/**
 * src/api/HostApiRouter.ts
 * Itera OS v2: Host API Router
 */

import type { HostTransport } from '../ipc/HostTransport';
import type { VfsService } from '../core/vfs/VfsService';
import type { ConfigManager } from '../core/sys/ConfigManager';
import type { Role, Turn, TurnContent, TurnMeta } from '../core/state/HistoryManager';
import type { DynamicToolRegistration, ProcessInfo } from './HostApiContract';
import type { SpawnOptions } from '../shell/windowing/ProcessManager';
import { USER_PRINCIPAL } from '../core/vfs/types';
import { VfsEventFormatter } from '../core/vfs/VfsEventFormatter';
import { base64ToBlob, blobToDataUrl, dataUrlToBlob } from '../utils/binary';

// 依存モジュールのダックタイピング・インターフェース (未実装モジュール用)
export interface IHistoryManager {
  append(role: Role, content: TurnContent, meta?: TurnMeta): Turn;
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
}
export interface IEngine {
  injectUserTurn(content: TurnContent, meta?: TurnMeta): Promise<void>;
  stop(): void;
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

export interface RouterDeps {
  vfs: VfsService;
  configManager: ConfigManager;
  history?: IHistoryManager;
  processManager?: IProcessManager;
  engine?: IEngine;
  shell?: IShell;
  toolRegistry?: IToolRegistry;
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

    // ヘルパー: 送信元PIDからPrincipalを生成する
    const getPrincipal = (sourcePid: string): any => {
      return { type: 'app', id: sourcePid };
    };

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
    // 2. AI & History (ai)
    // ==========================================
    t.registerHandler('ai:ask', async ({ text, opts }) => {
      if (!d.engine || !d.shell) return false;
      const attachments =
        opts && opts.attachments
          ? opts.attachments.map((p: string) => {
              const mime = p.match(/\.(png|jpg|jpeg|gif|webp)$/i) ? 'image/png' : 'application/octet-stream';
              return { media: { path: p, mimeType: mime, metadata: {} } };
            })
          : [];
      let content: any[] = [];
      if (attachments.length > 0) {
        content.push(...attachments);
        attachments.forEach((a: any) =>
          content.push({
            text: `<user_attachment path="${a.media.path}">[Attachment]</user_attachment>`,
          }),
        );
      }
      if (text) content.push({ text });

      // opts.silent: 履歴に user ターンを置くだけで LLM を起こさない
      // （後続の ai.task などに心構えを前置きするための経路）
      if (opts && opts.silent === true) {
        await d.engine.injectUserTurn(content, { trigger_llm: false });
        return true;
      }
      d.shell.panels.chat.setProcessing(true);
      await d.engine.injectUserTurn(content);
      return true;
    });

    t.registerHandler('ai:task', async ({ instruction, context, opts }) => {
      if (!d.history || !d.shell) return false;
      let text = `[System Task Request]\n${instruction}`;
      if (context) text += `\n\n[Context]\n${JSON.stringify(context, null, 2)}`;
      const lpml = `<event type="system_task">\n${text}\n</event>`;

      const turn = d.history.append('system', lpml, {
        type: 'event_log',
        visible: !opts?.silent,
        trigger_llm: true,
      });
      if (!opts?.silent) {
        d.shell.panels.chat.appendTurn(turn);
        d.shell.panels.chat.setProcessing(true);
      }
      return true;
    });

    t.registerHandler('ai:log', async ({ message, type, opts }) => {
      if (!d.history || !d.shell) return false;
      const triggerLlm = opts?.trigger_llm === true;
      const lpml = `<event type="${type || 'app_event'}">\n${message}\n</event>`;
      // イベントの種類を meta.eventType に残す（画面で隠す判定 preferences.hiddenEventTypes に使う。T-0246）。
      // meta.type は従来どおり event_log（Engine の連続回数の判定がこれを見る）。
      const turn = d.history.append('system', lpml, {
        type: 'event_log',
        eventType: type || 'app_event',
        trigger_llm: triggerLlm,
      });
      d.shell.panels.chat.appendTurn(turn);
      if (triggerLlm) {
        d.shell.panels.chat.setProcessing(true);
      }
      return true;
    });

    t.registerHandler('ai:stop', async () => {
      if (d.engine) d.engine.stop();
      return true;
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

    t.registerHandler('host:address_bar', async ({ path }) => {
      if (!d.processManager) return false;
      const fgApp = Array.from(d.processManager.processes.values()).find((p) => p.state === 'foreground');
      if (fgApp) {
        const oldBasePath = fgApp.path.split(/[?#]/)[0];

        let newPath = path;
        if (path.startsWith('?') || path.startsWith('#')) {
          newPath = oldBasePath + path;
        }

        fgApp.path = newPath;

        // 既存のURIからIntentを抽出して新しいURIを組み立てる
        const intentMatch = fgApp.currentUri.match(/^metaos:\/\/([^\/]+)/);
        const intent = intentMatch ? intentMatch[1] : 'open';

        fgApp.currentUri = `metaos://${intent}/${newPath}`;
        d.processManager._updateAddressBar(fgApp.currentUri);
      }
      return true;
    });

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
      const homePath = d.configManager.get('appearance')?.layout?.homePath || 'apps/home.html';
      await d.processManager.spawn({ path: homePath, show: true });
      if (d.shell) d.shell._closeMobileDrawers();
      return true;
    });

    // ==========================================
    // 5. Network (net)
    // ==========================================
    const prepareFetchOptions = (url: string, options: any) => {
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
        const creds = d.configManager.get('credentials') || {};
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
      const { targetUrl, fetchOpts } = prepareFetchOptions(url, options);
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

    t.registerHandler('net:download', async ({ url, destPath, options }) => {
      // V1のハックを維持：巨大ファイルをIPCで送らず、Host側でフェッチしてBlobを直接VFS（OPFS）に書き込む
      const { targetUrl, fetchOpts } = prepareFetchOptions(url, options);
      const res = await fetch(targetUrl, fetchOpts);
      if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
      const blob = await res.blob();
      await d.vfs.writeFile(USER_PRINCIPAL, destPath, blob, {
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
          message: instructions || `Paste access token for '${providerId}':`,
          type: 'question',
          prompt: { defaultValue: '' },
          buttons: [
            { label: 'Cancel', value: null, style: 'normal' },
            { label: 'Save Token', value: 'save', style: 'primary', isDefault: true },
          ],
        });

        const token = res?.value;
        if (token && token !== 'cancel' && token.trim()) {
          const creds = d.configManager.get('credentials') || {};
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
