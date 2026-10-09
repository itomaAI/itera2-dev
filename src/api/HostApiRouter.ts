/**
 * src/api/HostApiRouter.ts
 * Itera OS v2: Host API Router
 */

import type { HostTransport } from '../ipc/HostTransport';
import type { VfsService } from '../core/vfs/VfsService';
import type { ConfigManager } from '../core/sys/ConfigManager';
import type { Role, Turn, TurnContent, TurnMeta } from '../core/state/HistoryManager';
import type { DynamicToolRegistration, ProcessInfo } from './HostApiContract';
import { resolvePrincipal } from './principal';
import type { SpawnOptions } from '../shell/windowing/ProcessManager';
import { SYSTEM_PRINCIPAL, USER_PRINCIPAL } from '../core/vfs/types';
import { buildAppendPlan, buildChatStatus, buildResetPlan, latestContextUsage } from './chatApi';
import { VfsEventFormatter } from '../core/vfs/VfsEventFormatter';
import { buildGuestThemeCss } from '../shell/windowing/guestThemeCss';
import { base64ToBlob, blobToDataUrl, dataUrlToBlob } from '../utils/binary';
// この中では t が transport を指す（register の中の `const t = this.transport`）ので、文の関数は別名にする
import { t as tr } from '../i18n/i18n';

// 依存モジュールのダックタイピング・インターフェース (未実装モジュール用)
export interface IHistoryManager {
  append(role: Role, content: TurnContent, meta?: TurnMeta): Turn;
  get(): Turn[];
}
export interface IProcessManager {
  spawn(options: SpawnOptions): Promise<void>;
  kill(pid: string): boolean;
  list(): ProcessInfo[];
  broadcast(eventName: string, payload: any): void;
  captureScreenshot(pid?: string): Promise<string>;
  resolveUrl(path: string, pid: string): Promise<string>;
  getArgs(pid: string): Record<string, string> | null;
  reportError(pid: string, errorData: any): void;
  processes: Map<string, any>;
  _updateAddressBar(path: string): void;
  declareRoute(path: string, pid?: string): string | null;
}
export interface IEngine {
  injectUserTurn(content: TurnContent, meta?: TurnMeta): Promise<Turn>;
  requestEvaluation(): void;
  stop(): void;
  status(): { running: boolean; busy: boolean; outstandingTools: number };
}
/** 会話の空にする・切り替える・保存する（SessionManager が満たす。MetaOS.chat の実体。T-0634） */
export interface ISessionManager {
  clearSession(opts: { summary?: string; triggerLlm?: boolean; restoreTools?: boolean }): Promise<{
    archived: boolean;
    sessionId: string;
  }>;
  currentSession(): Promise<{ id: string; title: string; createdAt: number }>;
  listSessions(): Promise<unknown[]>;
  switchSession(id: string): Promise<unknown>;
  exportSessionToDefaultDir(id: string | 'current', principal: unknown): Promise<string | null>;
  importSessionFromVfs(path: string, principal: unknown): Promise<unknown>;
}
export interface IShell {
  _closeMobileDrawers(): void;
  _revealInExplorer?(path: string): boolean;
  _openPath?(path: string): void;
  getMergedProviders?(): Promise<any[]>;
  panels: { chat: any };
  modals: { editor: any; camera: any; audio: any; filePicker?: any };
}
export interface IToolRegistry {
  registerDynamicTool(name: string, sourcePid: string, definition: DynamicToolRegistration): void;
  unregisterDynamicTool(name: string, sourcePid: string): void;
}

/** 登録簿（層を重ねた値）の口。AppRegistry / FileAssociationResolver が満たす。 */
export interface IRegistryReader {
  getAllApps(): any[];
  getAllServices(): any[];
  /** services.json の 1 件（systemPrivilege の判定に使う。T-0617） */
  getService(id: string): any | undefined;
  updateEntry(kind: 'apps' | 'services', id: string, updates: Record<string, unknown>): Promise<any>;
}
export interface IAssociationReader {
  getAssociations(): any;
}

export interface INavHistory {
  back(): Promise<boolean>;
  forward(): Promise<boolean>;
  state(): { canBack: boolean; canForward: boolean; current: { uri: string; pid: string } | null };
}

export interface RouterDeps {
  vfs: VfsService;
  configManager: ConfigManager;
  navHistory?: INavHistory;
  appRegistry?: IRegistryReader;
  associations?: IAssociationReader;
  history?: IHistoryManager;
  processManager?: IProcessManager;
  engine?: IEngine;
  shell?: IShell;
  toolRegistry?: IToolRegistry;
  sessionManager?: ISessionManager;
}

export class HostApiRouter {
  private transport: HostTransport;
  private deps: RouterDeps;

  constructor(transport: HostTransport, deps: RouterDeps) {
    this.transport = transport;
    this.deps = deps;
    this._registerHandlers();
  }

  private _checkAndEmitEvent(options: any, type: string, desc: string) {
    // パフォーマンスとノイズ低減のため、デフォルトはログ出力なし(silent: true)とする
    // 明示的に { silent: false } が指定された場合のみイベントログを発行する
    const shouldEmit = options && options.silent === false;

    if (shouldEmit && this.deps.history && this.deps.shell) {
      const lpml = `<event type="${type}">\n${desc}\n</event>`;
      const turn = this.deps.history.append('system', lpml, {
        type: 'event_log',
        trigger_llm: false,
      });
      this.deps.shell.panels.chat.appendTurn(turn);
    }
  }

  private _registerHandlers() {
    const t = this.transport;
    const d = this.deps;

    // ==========================================
    // 1. File System (fs)
    // ==========================================

    // ヘルパー: 明示的なエンコーディング指定に従って文字列をバイナリに変換する
    const prepareWriteContent = (content: any, encoding?: string): Blob | string | Uint8Array => {
      if (content instanceof Uint8Array || content instanceof Blob) {
        return content;
      }
      if (content instanceof ArrayBuffer) {
        return new Uint8Array(content);
      }

      if (typeof content === 'string') {
        if (encoding === 'base64') {
          return base64ToBlob(content);
        } else if (encoding === 'dataurl') {
          return dataUrlToBlob(content);
        }
      }

      // encodingの指定がない、または対象外の場合はそのまま返す（純粋な文字列として扱う）
      return content;
    };

    // ヘルパー: 送信元PIDからPrincipalを生成する（system 特権の判定は src/api/principal.ts。T-0617）
    const getPrincipal = (sourcePid: string): any =>
      resolvePrincipal(sourcePid, { processManager: d.processManager, appRegistry: d.appRegistry });

    t.registerHandler('fs:read', async ({ path, opts }, sourcePid) => {
      const principal = getPrincipal(sourcePid);
      if (opts && opts.encoding) {
        if (opts.encoding === 'binary') {
          const blob = await d.vfs.readBlob(principal, path, opts);
          const buffer = await blob.arrayBuffer();
          return new Uint8Array(buffer);
        } else if (opts.encoding === 'base64' || opts.encoding === 'dataurl') {
          const blob = await d.vfs.readBlob(principal, path, opts);
          const dataUrl = await blobToDataUrl(blob);
          if (opts.encoding === 'dataurl') return dataUrl;
          return dataUrl.split(',')[1] || '';
        }
      }
      return await d.vfs.readFile(principal, path, opts);
    });

    t.registerHandler('fs:write', async ({ path, content, opts }, sourcePid) => {
      const principal = getPrincipal(sourcePid);
      const finalContent = prepareWriteContent(content, opts?.encoding);
      const res = await d.vfs.writeFile(principal, path, finalContent, opts);
      const msg = VfsEventFormatter.format({
        actor: `App [${sourcePid}]`,
        action: 'edit',
        items: [{ srcPath: path }],
      });
      this._checkAndEmitEvent(opts, 'file_edited', msg);
      return res;
    });

    t.registerHandler('fs:append', async ({ path, content, opts }, sourcePid) => {
      const principal = getPrincipal(sourcePid);
      const res = await d.vfs.appendFile(principal, path, content, opts);
      const msg = VfsEventFormatter.format({
        actor: `App [${sourcePid}]`,
        action: 'edit',
        items: [{ srcPath: path }],
      });
      this._checkAndEmitEvent(opts, 'file_edited', msg);
      return res;
    });

    t.registerHandler('fs:delete', async ({ path, opts }, sourcePid) => {
      const principal = getPrincipal(sourcePid);
      const res = await d.vfs.deleteFile(principal, path, opts);
      const msg = VfsEventFormatter.format({
        actor: `App [${sourcePid}]`,
        action: 'delete',
        items: [{ srcPath: path }],
      });
      this._checkAndEmitEvent(opts, 'file_deleted', msg);
      return res;
    });

    // ゴミ箱から元の場所（か opts.to）へ戻す（T-0470）。戻した先のパスを返す
    t.registerHandler('fs:restore', async ({ path, opts }, sourcePid) => {
      const principal = getPrincipal(sourcePid);
      const dest = await d.vfs.restore(principal, path, opts);
      const msg = VfsEventFormatter.format({
        actor: `App [${sourcePid}]`,
        action: 'move',
        items: [{ srcPath: path, destPath: dest }],
      });
      this._checkAndEmitEvent(opts, 'file_moved', msg);
      return dest;
    });

    t.registerHandler('fs:rename', async ({ oldPath, newPath, opts }, sourcePid) => {
      const principal = getPrincipal(sourcePid);
      const res = await d.vfs.rename(principal, oldPath, newPath, opts);
      const msg = VfsEventFormatter.format({
        actor: `App [${sourcePid}]`,
        action: 'move',
        items: [{ srcPath: oldPath, destPath: newPath }],
      });
      this._checkAndEmitEvent(opts, 'file_moved', msg);
      return res;
    });

    t.registerHandler('fs:copy', async ({ srcPath, destPath, opts }, sourcePid) => {
      const principal = getPrincipal(sourcePid);
      const res = await d.vfs.copyFile(principal, srcPath, destPath, opts);
      const msg = VfsEventFormatter.format({
        actor: `App [${sourcePid}]`,
        action: 'copy',
        items: [{ srcPath, destPath }],
      });
      this._checkAndEmitEvent(opts, 'file_copied', msg);
      return res;
    });

    t.registerHandler('fs:mkdir', async ({ path, opts }, sourcePid) => {
      const principal = getPrincipal(sourcePid);
      const res = await d.vfs.mkdir(principal, path, opts);
      this._checkAndEmitEvent(opts, 'folder_created', `App [${sourcePid}] created folder: ${path}`);
      return res;
    });

    t.registerHandler('fs:stat', async ({ path }, sourcePid) => d.vfs.stat(getPrincipal(sourcePid), path));
    t.registerHandler('fs:list', async ({ path, opts }, sourcePid) =>
      d.vfs.listFiles(getPrincipal(sourcePid), { path, ...opts }),
    );
    t.registerHandler('fs:exists', async ({ path }, sourcePid) => d.vfs.exists(getPrincipal(sourcePid), path));
    // この端末の VFS の容量（バイト）。素の事実 3 つだけを配る。割合や「満杯か」はゲストが自分で決める（T-0354）。
    // パスも中身も漏れないので権限検査は無い。
    t.registerHandler('fs:get_usage', async () => {
      const u = d.vfs.getUsage();
      return { used: u.used, max: u.max, reserved: u.reserved };
    });
    t.registerHandler('fs:get_sync_state', async ({ path }, sourcePid) =>
      d.vfs.getSyncState(getPrincipal(sourcePid), path || ''),
    );

    t.registerHandler('fs:resolve_url', async ({ path }, sourcePid) => {
      if (!d.processManager) throw new Error('ProcessManager not connected.');
      return d.processManager.resolveUrl(path, sourcePid);
    });

    t.registerHandler('fs:get_acl', async ({ path }, sourcePid) => {
      return d.vfs.getAcl(getPrincipal(sourcePid), path);
    });

    t.registerHandler('fs:set_acl', async ({ path, acl, opts }, sourcePid) => {
      const principal = getPrincipal(sourcePid);
      if (opts?.recursive) {
        await d.vfs.setAclRecursive(principal, path, acl);
      } else {
        await d.vfs.setAcl(principal, path, acl);
      }
      this._checkAndEmitEvent(opts, 'permission_changed', `App [${sourcePid}] changed permissions for: ${path}`);
      return true;
    });

    t.registerHandler('fs:create_stub', async ({ path, meta, opts }, sourcePid) => {
      return await d.vfs.createStub(getPrincipal(sourcePid), path, meta, opts);
    });

    // 新しいSync Provider API
    t.registerHandler('fs:register_provider', async ({ path }, sourcePid) => {
      d.vfs.getProviderManager()?.registerProvider(path, sourcePid);
      return true;
    });

    t.registerHandler('fs:unregister_provider', async ({ path }) => {
      d.vfs.getProviderManager()?.unregisterProvider(path);
      return true;
    });

    // マウント表の読み取り。同期デーモンが「他プロバイダの管轄下」を
    // 導出して自分の同期対象から外すために使う（除外リストのハードコード回避）。
    // 構造情報のみで内容を含まないため読み取り専用で公開する。
    //
    // fail-closed: ProviderManager を参照できない状態で空配列を返すと、
    // 呼び出し側は「他マウントは無い」とみなして他領域を自分の同期対象に
    // 含めてしまう。例外にして呼び出し側のサイクルを中断させる。
    //
    // ※ ミャク楽Agent 側の同名ハンドラは services.json の reservedMountPath
    //    （未登録だが予約済みのマウント）も併せて返すが、itera2-dev の
    //    ServiceManifest には当該フィールドが存在しないため移植していない。
    //    ルートマウントの同期デーモンを追加する場合は、デーモンの登録が
    //    間に合わない起動直後の窓を塞ぐため、先に ServiceManifest の拡張が要る。
    t.registerHandler('fs:list_mounts', async () => {
      const pm = d.vfs.getProviderManager();
      if (!pm) throw new Error('ProviderManager not connected.');
      // registered … マウント表に載っている（この一覧に出る時点で常に true）
      // alive      … その担当プロセスがいま応じられる（T-0353）
      //
      // 🔴 管轄の除外（根をマウントするデーモンが他プロバイダの部分木を避ける処理）は、
      //   alive ではなく **mountPath で判断すること**。相手が一時的に落ちている間に除外を外すと、
      //   取り込みが相手の管轄のディレクトリを削除し、その削除が利用者の実機まで伝播しうる。
      return pm.listMounts().map((m) => ({ ...m, registered: true, alive: pm.isProviderAlive(m.pid) }));
    });

    // ==========================================
    // 2. Chat (chat) — 会話の基本操作（T-0634）
    //   append / wake / stop / reset / status と、会話の一覧・切り替え・保存・読み込み。
    //   ai.ask / ai.task / ai.log / ai.stop は guest_bridge.js の側で append / stop の薄皮として組む
    //   （ホストに `ai:*` を残して二重に実装しない）。規則は chatApi.ts（純関数）。
    //   権限は従来の ai:* と同じ（ゲストに閉じない）。遠隔の相手の認証は中継するデーモンの責任。
    // ==========================================
    const chatPanel = () => d.shell?.panels?.chat;

    t.registerHandler('chat:append', async ({ role, content, opts }, sourcePid) => {
      if (!d.engine || !d.history) throw new Error('Chat is not available.');
      const plan = buildAppendPlan({ role, content, opts }, sourcePid);
      if (!plan.ok) throw new Error(`chat.append: ${plan.reason}`);
      const chat = chatPanel();
      if (plan.role === 'user') {
        // injectUserTurn が turn_end を出すので画面には Engine 経由で載る
        const turn = await d.engine.injectUserTurn(plan.content, plan.meta);
        if (plan.wake) chat?.setProcessing(true);
        return { id: turn.id };
      }
      const turn = d.history.append('system', plan.content, plan.meta);
      if (plan.visible) chat?.appendTurn(turn);
      if (plan.wake) chat?.setProcessing(true);
      return { id: turn.id };
    });

    t.registerHandler('chat:wake', async () => {
      if (!d.engine) throw new Error('Chat is not available.');
      d.engine.requestEvaluation();
      // 未読が無ければ評価が loop_stop(idle) を出して消す
      chatPanel()?.setProcessing(true);
      return true;
    });

    t.registerHandler('chat:stop', async () => {
      if (d.engine) d.engine.stop();
      return true;
    });

    t.registerHandler('chat:reset', async ({ opts }, sourcePid) => {
      if (!d.engine || !d.sessionManager) throw new Error('Chat is not available.');
      const plan = buildResetPlan(opts, sourcePid);
      // LLM が応答できない状態（文脈の溢れ）でも効くように、busy は見ない。走っている束は見捨てる（会話は退避される）
      d.engine.stop();
      return await d.sessionManager.clearSession({
        summary: plan.summary,
        triggerLlm: plan.wake,
        restoreTools: plan.restoreTools,
      });
    });

    // usage ログは UTC の日付で切られ、応答のあとに書かれる（観測は 1 ターン遅れる）。今日に無ければ昨日を読む
    const readLatestUsage = async () => {
      for (const back of [0, 1]) {
        const day = new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);
        const path = `system/logs/usage/${day}.jsonl`;
        try {
          if (!d.vfs.exists(SYSTEM_PRINCIPAL, path)) continue;
          const found = latestContextUsage(await d.vfs.readFile(SYSTEM_PRINCIPAL, path));
          if (found) return found;
        } catch {
          /* 読めなければ無いのと同じ */
        }
      }
      return null;
    };

    t.registerHandler('chat:status', async () => {
      if (!d.engine || !d.history) throw new Error('Chat is not available.');
      let session: { id: string; title: string; createdAt: number } | null = null;
      if (d.sessionManager) {
        try {
          const m = await d.sessionManager.currentSession();
          session = { id: m.id, title: m.title, createdAt: m.createdAt };
        } catch {
          session = null;
        }
      }
      return buildChatStatus({
        engine: d.engine.status(),
        turns: d.history.get(),
        session,
        context: await readLatestUsage(),
      });
    });

    t.registerHandler('chat:sessions', async () => {
      if (!d.sessionManager) throw new Error('Chat is not available.');
      const [current, saved] = await Promise.all([d.sessionManager.currentSession(), d.sessionManager.listSessions()]);
      return { current, saved };
    });

    t.registerHandler('chat:switch_session', async ({ id }) => {
      if (!d.sessionManager) throw new Error('Chat is not available.');
      if (typeof id !== 'string' || !id) throw new Error('chat.switchSession: id is required');
      return await d.sessionManager.switchSession(id);
    });

    t.registerHandler('chat:save_session', async ({ id }, sourcePid) => {
      if (!d.sessionManager) throw new Error('Chat is not available.');
      const target = typeof id === 'string' && id ? id : 'current';
      return await d.sessionManager.exportSessionToDefaultDir(target, getPrincipal(sourcePid));
    });

    t.registerHandler('chat:load_session', async ({ path }, sourcePid) => {
      if (!d.sessionManager) throw new Error('Chat is not available.');
      if (typeof path !== 'string' || !path) throw new Error('chat.loadSession: path is required');
      return await d.sessionManager.importSessionFromVfs(path, getPrincipal(sourcePid));
    });

    // ==========================================
    // 3. System & Process (sys)
    // ==========================================
    t.registerHandler('sys:spawn', async ({ path, opts }) => {
      if (!d.processManager) return false;

      const spawnOptions: any = { path };
      if (opts?.pid) spawnOptions.pid = opts.pid;
      if (opts?.type) spawnOptions.type = opts.type;
      if (opts?.show !== undefined) spawnOptions.show = opts.show;
      if (opts?.forceReload !== undefined) spawnOptions.forceReload = opts.forceReload;
      if (opts?.args) spawnOptions.args = opts.args;

      await d.processManager.spawn(spawnOptions);
      if (spawnOptions.show !== false && d.shell) d.shell._closeMobileDrawers();
      return true;
    });

    t.registerHandler('sys:kill', async ({ pid }) => (d.processManager ? d.processManager.kill(pid) : false));
    t.registerHandler('sys:ps', async () => (d.processManager ? d.processManager.list() : []));
    t.registerHandler('sys:info', async (_, sourcePid) => {
      if (!d.processManager) return null;
      const p = d.processManager.processes.get(sourcePid);
      return p ? { pid: p.pid, path: p.path, type: p.type, state: p.state } : null;
    });
    t.registerHandler('sys:broadcast', async ({ eventName, payload }) => {
      if (d.processManager) d.processManager.broadcast(eventName, payload);
      return true;
    });
    t.registerHandler('sys:capture', async ({ pid }) => {
      if (!d.processManager) throw new Error('ProcessManager not connected');
      return await d.processManager.captureScreenshot(pid);
    });

    // ★ V2 新機能: 起動引数の取得
    t.registerHandler('sys:get_args', async (_, sourcePid) => {
      if (!d.processManager) return null;
      return d.processManager.getArgs(sourcePid);
    });

    t.registerHandler('sys:get_providers', async () => {
      if (!d.shell || !d.shell.getMergedProviders) return [];
      return await d.shell.getMergedProviders();
    });

    // 設定の口（T-0431）。ゲストが system/config/*.json を直接読み書きすると、
    //   1. 層（system/config → user/config）の規則をゲストごとに写すことになり、
    //   2. 配信の層に書いてしまい OS 更新のたびに戻る（itera2 で実際に起きた）。
    // 併合と差分書きは ConfigManager が 1 か所で持つ。ゲストはこの口だけを使う。
    // 🔴 credentials は渡さない（鍵の置き場。ゲストが読む筋合いは無い）。
    // 🔴 分類があるかどうかはここで決めない（T-0553）。以前は「控えにあるか」で断っていたため、
    //    起動時に読まない分類（既定以外）は、その回のうちにファイルが書かれるまで読めなかった。
    //    在否は ConfigManager が層を探して答え（無ければ {}）、名前の検めもそこで行う（パスを組むのはそこなので）。
    const GUEST_CONFIG_DENY = new Set(['credentials']);
    const guestConfigCategory = (raw: unknown): string => {
      const category = typeof raw === 'string' ? raw.trim() : '';
      if (GUEST_CONFIG_DENY.has(category)) {
        throw new Error(`Config category not available to apps: ${JSON.stringify(raw)}`);
      }
      return category;
    };
    t.registerHandler('sys:get_config', async ({ category }) => {
      const key = guestConfigCategory(category);
      const value = await d.configManager.ensure(key);
      return value === undefined ? {} : JSON.parse(JSON.stringify(value));
    });
    t.registerHandler('sys:update_config', async ({ category, updates }) => {
      const key = guestConfigCategory(category);
      if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
        throw new Error('updates must be an object');
      }
      await d.configManager.update(key, updates);
      return JSON.parse(JSON.stringify(d.configManager.get(key)));
    });
    // 起動中のアプリがテーマを取り直す口（T-0539）。theme_changed を受けたブリッジが呼ぶ。
    // 起動時の焼き込み（GuestCompiler）と同じ関数で作る。
    t.registerHandler('sys:get_theme_css', async () => buildGuestThemeCss());

    // 登録簿の口（T-0447）。設定と同じ理由 —— ゲストが system/registry/*.json を直接読み書きすると
    // 層の規則を写すことになり、書けば配信の層へ落ちて OS 更新で戻る（設定アプリのサービス切り替えで実際に起きうる）。
    // 重ねるのも書き先を決めるのも AppRegistry が 1 か所で持つ。
    // adapters.json は渡さない（層を認めていない。config_layers.ts）。
    const clone = (v: unknown) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
    t.registerHandler('sys:get_registry', async ({ name }) => {
      switch (name) {
        case 'apps':
          if (!d.appRegistry) throw new Error('AppRegistry not connected');
          return clone(d.appRegistry.getAllApps());
        case 'services':
          if (!d.appRegistry) throw new Error('AppRegistry not connected');
          return clone(d.appRegistry.getAllServices());
        case 'associations':
          if (!d.associations) throw new Error('FileAssociationResolver not connected');
          return clone(d.associations.getAssociations());
        default:
          throw new Error(`Unknown registry: ${JSON.stringify(name)}`);
      }
    });
    t.registerHandler('sys:update_registry', async ({ name, id, updates }) => {
      if (name !== 'apps' && name !== 'services') {
        throw new Error(`Registry ${JSON.stringify(name)} cannot be updated through this call`);
      }
      if (!d.appRegistry) throw new Error('AppRegistry not connected');
      if (typeof id !== 'string' || !id) throw new Error("'id' is required.");
      if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
        throw new Error('updates must be an object');
      }
      return clone(await d.appRegistry.updateEntry(name, id, updates));
    });

    t.registerHandler('sys:report_error', async (payload, sourcePid) => {
      if (d.processManager) {
        d.processManager.reportError(sourcePid, payload);
      }
      return true;
    });

    // ==========================================
    // 4. Host UI & Native (host)
    // ==========================================
    t.registerHandler('host:open_editor', async ({ path }) => {
      if (!d.shell || !d.shell.modals.editor) return false;
      const content = await d.vfs.readFile(USER_PRINCIPAL, path);
      d.shell.modals.editor.open(path, content);
      d.shell._closeMobileDrawers();
      return true;
    });
    t.registerHandler('host:reveal_in_explorer', async ({ path }) => {
      if (!d.shell || !d.shell._revealInExplorer) return false;
      if (typeof path !== 'string' || !path) throw new Error("'path' is required.");
      // 存在しないパスは「木に無い」として false を返す（例外にしない。呼ぶ側が判断する）
      return d.shell._revealInExplorer(path.replace(/^\/+|\/+$/g, ''));
    });
    // 関連付けのアプリで開く（metaos://open/… と同じ経路。T-0344）。
    // ゲストは「何で開くか」を知らなくてよい。開けなかったときはホストが通知で見せる。
    t.registerHandler('host:open_path', async ({ path }) => {
      if (!d.shell || !d.shell._openPath) throw new Error('open is not available.');
      if (typeof path !== 'string' || !path) throw new Error("'path' is required.");
      d.shell._openPath(path.replace(/^\/+|\/+$/g, ''));
      return true;
    });
    t.registerHandler('host:notify', async ({ message, type, duration }) => {
      if (window.AppUI) window.AppUI.notify(message, type, duration);
      return true;
    });
    t.registerHandler('host:copy', async ({ text }) => {
      await navigator.clipboard.writeText(text);
      return true;
    });
    t.registerHandler('host:open_url', async ({ url }) => {
      window.open(url, '_blank', 'noopener,noreferrer');
      return true;
    });
    t.registerHandler('host:show_open_dialog', async ({ options }) => {
      if (!d.shell || !d.shell.modals.filePicker) return null;
      return await d.shell.modals.filePicker.open(options);
    });
    t.registerHandler('host:show_save_dialog', async ({ options }) => {
      if (!d.shell || !d.shell.modals.filePicker) return null;
      return await d.shell.modals.filePicker.openSave(options);
    });

    // ゲストの申告（自分の画面の URL）。nav.declare が正式名。host.updateAddressBar は互換（非推奨）で同じ handler（T-0453）
    // 当てるのは呼び出し元（sourcePid）であって前面ではない（T-0619）
    const declare = async ({ path }: { path: string }, sourcePid: string) => {
      if (!d.processManager) return false;
      return d.processManager.declareRoute(String(path || ''), sourcePid) !== null;
    };
    t.registerHandler('host:address_bar', declare);
    t.registerHandler('nav:declare', declare);
    t.registerHandler('nav:back', async () => (d.navHistory ? d.navHistory.back() : false));
    t.registerHandler('nav:forward', async () => (d.navHistory ? d.navHistory.forward() : false));
    t.registerHandler('nav:state', async () =>
      d.navHistory ? d.navHistory.state() : { canBack: false, canForward: false, current: null },
    );

    t.registerHandler('host:show_message_box', async ({ options }) => {
      if (window.AppUI) {
        return await window.AppUI.showMessageBox(options);
      }
      return null;
    });
    t.registerHandler('host:show_loading', async ({ message }) => {
      if (window.AppUI) window.AppUI.showLoading(message);
      return true;
    });
    t.registerHandler('host:hide_loading', async () => {
      if (window.AppUI) window.AppUI.hideLoading();
      return true;
    });
    t.registerHandler('host:go_home', async () => {
      if (!d.processManager) return false;
      const homePath = d.configManager.homePath();
      await d.processManager.spawn({ path: homePath, show: true });
      if (d.shell) d.shell._closeMobileDrawers();
      return true;
    });

    // ==========================================
    // 5. Network (net)
    // ==========================================
    const prepareFetchOptions = async (url: string, options: any) => {
      let targetUrl = url;
      const fetchOpts: RequestInit = {
        method: options?.method || 'GET',
        headers: options?.headers || {},
      };

      if (options?.body) {
        // Uint8Array や Blob などのバイナリデータは JSON.stringify せずにそのまま送る
        if (options.body instanceof Uint8Array || options.body instanceof Blob || options.body instanceof ArrayBuffer) {
          fetchOpts.body = options.body;
        } else if (typeof options.body === 'object') {
          fetchOpts.body = JSON.stringify(options.body);
        } else {
          fetchOpts.body = options.body;
        }
      }

      if (options?.credentialId) {
        const netConf = d.configManager.get('network');
        if (options.useProxy && !netConf?.allowCredentialsWithProxy) {
          throw new Error('Security Error: Cannot use public proxy with credentials.');
        }
        // credentials は既定の分類ではないので、起動時には読まれていない。ensure で層から読む（T-0553）
        const creds = (await d.configManager.ensure('credentials')) || {};
        const cred = creds[options.credentialId];
        if (!cred) throw new Error(`Credential ID '${options.credentialId}' not found.`);
        if (cred.type === 'query') {
          targetUrl += `${targetUrl.includes('?') ? '&' : '?'}${encodeURIComponent(cred.key)}=${encodeURIComponent(cred.value)}`;
        } else if (cred.type === 'header') {
          (fetchOpts.headers as any)[cred.key] = cred.value;
        }
      }

      if (options?.useProxy) {
        const proxyPrefix = d.configManager.get('network')?.proxyUrl || 'https://corsproxy.io/?';
        targetUrl = `${proxyPrefix}${encodeURIComponent(targetUrl)}`;
      }
      return { targetUrl, fetchOpts };
    };

    t.registerHandler('net:fetch', async ({ url, options }) => {
      const { targetUrl, fetchOpts } = await prepareFetchOptions(url, options);
      const res = await fetch(targetUrl, fetchOpts);

      const resHeaders: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        resHeaders[key] = value;
      });

      const responseObj: any = {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        headers: resHeaders,
        data: null,
      };

      const responseType = options?.responseType || 'text';
      if (responseType === 'json') {
        responseObj.data = await res.json();
      } else if (responseType === 'dataURL') {
        const blob = await res.blob();
        responseObj.data = await blobToDataUrl(blob);
      } else if (responseType === 'arraybuffer' || responseType === 'binary') {
        const arrayBuffer = await res.arrayBuffer();
        responseObj.data = new Uint8Array(arrayBuffer);
      } else {
        responseObj.data = await res.text();
      }
      return responseObj;
    });

    t.registerHandler('net:download', async ({ url, destPath, options }, sourcePid) => {
      // V1のハックを維持：巨大ファイルをIPCで送らず、Host側でフェッチしてBlobを直接VFS（OPFS）に書き込む
      const { targetUrl, fetchOpts } = await prepareFetchOptions(url, options);
      const res = await fetch(targetUrl, fetchOpts);
      if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
      const blob = await res.blob();
      // 書くのは呼び手の principal（T-0617）。以前は USER で書いていたため、同期デーモンが
      // スタブの中身をここで取り寄せると、AI の領域（agent-only）では USER に書く権限が無く
      // 「Failed to fetch missing content」で落ちた。system 特権のデーモンは system で書く。
      await d.vfs.writeFile(getPrincipal(sourcePid), destPath, blob, {
        overwrite: true,
        // 実体化のときに元の日付を保つための口（T-0351）
        meta: options?.meta,
      });
      return { path: destPath, size: blob.size };
    });

    t.registerHandler('net:oauth', async ({ providerId, authUrl, instructions }) => {
      window.open(authUrl, '_blank', 'noopener,noreferrer');
      if (window.AppUI) {
        const res = await window.AppUI.showMessageBox({
          title: providerId,
          message: instructions || tr('oauth.pasteToken', { provider: providerId }),
          type: 'question',
          prompt: { defaultValue: '' },
          buttons: [
            { label: tr('common.cancel'), value: null, style: 'normal', isCancel: true },
            { label: tr('oauth.saveToken'), value: 'save', style: 'primary', isDefault: true },
          ],
        });

        const token = res?.value;
        if (token && token !== 'cancel' && token.trim()) {
          // 控えの値を直接いじらない（update が「変わったか」を旧値と比べるので）。起動直後でも層から読む（T-0553）
          const creds = { ...((await d.configManager.ensure('credentials')) || {}) };
          creds[providerId] = {
            type: 'header',
            key: 'Authorization',
            value: `Bearer ${token.trim()}`,
          };
          await d.configManager.update('credentials', creds);
          return true;
        }
      }
      return false;
    });

    // ==========================================
    // 6. Device & Hardware (dev)
    // ==========================================
    t.registerHandler('dev:location', async ({ options }) => {
      return new Promise((resolve, reject) => {
        if (!navigator.geolocation) return reject(new Error('Geolocation not supported.'));
        navigator.geolocation.getCurrentPosition(
          (pos) =>
            resolve({
              latitude: pos.coords.latitude,
              longitude: pos.coords.longitude,
              accuracy: pos.coords.accuracy,
            }),
          (err) => reject(new Error(err.message)),
          options,
        );
      });
    });

    t.registerHandler('dev:vibrate', async ({ pattern }) => {
      if (navigator.vibrate) return navigator.vibrate(pattern);
      return false;
    });

    t.registerHandler('dev:photo', async ({ options }) => {
      if (!d.shell || !d.shell.modals.camera) {
        throw new Error('Camera modal is not available in the shell.');
      }
      return await d.shell.modals.camera.open(options);
    });

    t.registerHandler('dev:audio', async ({ options }) => {
      if (!d.shell || !d.shell.modals.audio) {
        throw new Error('Audio modal is not available in the shell.');
      }
      return await d.shell.modals.audio.open(options);
    });

    // ==========================================
    // 7. Dynamic Tools (tools)
    // ==========================================
    t.registerHandler('tools:register', async (payload, sourcePid) => {
      if (d.toolRegistry) d.toolRegistry.registerDynamicTool(payload.name, sourcePid, payload);
      return true;
    });
    t.registerHandler('tools:unregister', async ({ name }, sourcePid) => {
      if (d.toolRegistry) d.toolRegistry.unregisterDynamicTool(name, sourcePid);
      return true;
    });
  }
}
