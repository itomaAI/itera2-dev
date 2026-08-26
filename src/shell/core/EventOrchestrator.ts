/**
 * src/shell/core/EventOrchestrator.ts
 * Itera OS v2: Event Routing and Inter-Component Coordination
 */

import type { DesktopEnvironment } from './DesktopEnvironment';
import type { VfsService } from '../../core/vfs/VfsService';
import type { HistoryManager } from '../../core/state/HistoryManager';
import type { Engine } from '../../core/control/Engine';
import type { ProcessManager } from '../windowing/ProcessManager';
import type { UriRouter } from './UriRouter';
import type { SessionManager } from '../services/SessionManager';
import type { CognitiveManager } from '../services/CognitiveManager';
import type { FileAssociationResolver, ResolvedApp } from '../../core/sys/FileAssociationResolver';
import type { VfsEventBus } from '../../core/vfs/VfsEventBus';
import type { ConfigManager } from '../../core/sys/ConfigManager';
import { VfsEventFormatter } from '../../core/vfs/VfsEventFormatter';

/**
 * ターン終了時に待機表示をどうするか。── T-0028
 *
 * Engine の流れ:
 *   turn_start(model) → stream → turn_end(model) → [ツールがあれば _dispatchActions（await されない）]
 *   → finally で isRunning=false → 各ツール結果が turn_end(system) を出す → 最後に loop_stop
 *
 * ★ 以前は turn_end で「isRunning が false なら消す」としていた。
 *   ツール実行は isRunning=false になった**後**に走るため、最初のツール結果が届いた時点で
 *   待機表示が消えていた。つまり "Processing..." は文言以前に、そもそも出る余地が無かった。
 *
 * モデルのターンが終わった直後は 'processing' に切り替える。
 * ツールが無い場合、Engine は同じ同期ブロック内で loop_stop を出す（間に描画が挟まらない）ため、
 * "Processing..." が画面に見えることはない。
 *
 * toolPhase は「消してよいか」の判断にだけ使う。取りこぼすと待機表示が残り続けるので、
 * loop_stop では必ず false に戻すこと（Engine は loop_stop を必ず出す契約になっている）。
 */
export type IndicatorAction = 'processing' | 'hide' | 'keep';

/** チャット欄からの送信オプション。silent は「置くだけ」（LLM を起こさない） */
export interface ChatSendOptions {
  silent?: boolean;
}

export function decideIndicatorOnTurnEnd(role: string, isRunning: boolean, toolPhase: boolean): IndicatorAction {
  if (role === 'model') return 'processing';
  if (!isRunning && !toolPhase) return 'hide';
  return 'keep';
}

export class EventOrchestrator {
  /** モデル発話後〜loop_stop までの「ツール実行中」帯にいるか（表示判断にのみ使う） */
  private toolPhase = false;

  private desktop: DesktopEnvironment;
  private vfs: VfsService;
  private history: HistoryManager;
  private engine: Engine;
  private processManager: ProcessManager;
  private uriRouter: UriRouter;
  private sessionManager: SessionManager;
  private cognitiveManager: CognitiveManager;
  private resolver: FileAssociationResolver;
  private eventBus: VfsEventBus;
  private configManager: ConfigManager;

  constructor(
    desktop: DesktopEnvironment,
    vfs: VfsService,
    history: HistoryManager,
    engine: Engine,
    processManager: ProcessManager,
    uriRouter: UriRouter,
    sessionManager: SessionManager,
    cognitiveManager: CognitiveManager,
    resolver: FileAssociationResolver,
    eventBus: VfsEventBus,
    configManager: ConfigManager,
  ) {
    this.desktop = desktop;
    this.vfs = vfs;
    this.history = history;
    this.engine = engine;
    this.processManager = processManager;
    this.uriRouter = uriRouter;
    this.sessionManager = sessionManager;
    this.cognitiveManager = cognitiveManager;
    this.resolver = resolver;
    this.eventBus = eventBus;
    this.configManager = configManager;
  }

  /**
   * システム全体のイベント配線を行う
   */
  public bindAll(): void {
    this._bindGlobalUIEvents();
    this._bindUriRouting();
    this._bindVfsEvents();
    this._bindExplorerEvents();
    this._bindChatEvents();
    this._bindEngineEvents();
    this._bindModalEvents();
  }

  // ==========================================
  // 1. Global UI (Address Bar & Commands)
  // ==========================================
  private _bindGlobalUIEvents(): void {
    const addressBar = document.getElementById('preview-address-bar') as HTMLInputElement;
    const btnAddressGo = document.getElementById('btn-address-go');

    const handleAddressNavigate = () => {
      if (!addressBar) return;
      const input = addressBar.value.trim();
      if (!input) return;
      try {
        this.uriRouter.dispatch(input);
      } catch (e: any) {
        console.error('[Router] Navigation failed:', e);
        if (window.AppUI) window.AppUI.notify(e.message, 'warning');
        this._restoreAddressBar();
      } finally {
        addressBar.blur();
      }
    };

    if (addressBar) {
      addressBar.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleAddressNavigate();
      });
    }

    if (btnAddressGo) {
      btnAddressGo.addEventListener('mousedown', (e) => e.preventDefault());
      btnAddressGo.addEventListener('touchstart', (e) => e.preventDefault(), {
        passive: false,
      });
      btnAddressGo.addEventListener('click', handleAddressNavigate);
    }

    // Command Palette -> AI (ChatPanel へのパススルー)
    this.desktop.commandPalette.on('ask_ai', (query: string) => {
      this._handleChatSend(query, [], []);
    });
  }

  // ==========================================
  // 2. URI Routing (Intent Dispatching)
  // ==========================================
  private _bindUriRouting(): void {
    // metaos://open/... (データファイルを関連付けアプリで開く)
    this.uriRouter.register('open', async (path: string, queryArgs: Record<string, string>, searchAndHash: string) => {
      const homePath = this.configManager.get('appearance')?.layout?.homePath || 'apps/home.html';
      let targetPath = path || homePath;
      try {
        const stat = this.vfs.stat(this.desktop.getActivePrincipal(), targetPath);
        const resolvedApp = this.resolver.resolveDefault(stat);

        if (resolvedApp.appId === 'HostRunner') {
          const fullUri = `metaos://run/${targetPath}${searchAndHash}`;
          await this.processManager.spawn({
            path: targetPath + searchAndHash,
            show: true,
            args: queryArgs,
            currentUri: fullUri,
          });
        } else if (resolvedApp.appId === 'HostEditor') {
          const content = await this.vfs.readFile(this.desktop.getActivePrincipal(), targetPath);
          this.desktop.modals.editor.open(targetPath, content);
          this._restoreAddressBar();
        } else if (resolvedApp.appId === 'HostMediaViewer') {
          const blob = await this.vfs.readBlob(this.desktop.getActivePrincipal(), targetPath);
          this.desktop.modals.media.open(targetPath, blob);
          this._restoreAddressBar();
        } else {
          const args = { file: targetPath, ...queryArgs };
          const fullUri = `metaos://open/${targetPath}${searchAndHash}`;
          // V2仕様: args として起動パラメータを渡す
          await this.processManager.spawn({
            pid: resolvedApp.appId,
            path: resolvedApp.appPath!,
            show: true,
            args,
            currentUri: fullUri,
          });
        }
      } catch (e: any) {
        if (window.AppUI) window.AppUI.notify(`Cannot open: ${e.message}`, 'error');
        this._restoreAddressBar();
      }
    });

    // metaos://run/... (関連付けを無視して実行ファイルとして起動)
    this.uriRouter.register('run', async (path: string, queryArgs: Record<string, string>, searchAndHash: string) => {
      const homePath = this.configManager.get('appearance')?.layout?.homePath || 'apps/home.html';
      let executablePath = path || homePath;
      try {
        const args = { ...queryArgs };
        const fullUri = `metaos://run/${executablePath}${searchAndHash}`;
        await this.processManager.spawn({
          path: executablePath,
          show: true,
          args,
          currentUri: fullUri,
        });
      } catch (e: any) {
        if (window.AppUI) window.AppUI.notify(`Cannot run: ${e.message}`, 'error');
        this._restoreAddressBar();
      }
    });

    // metaos://edit/... (強制的にHostコードエディタで開く)
    this.uriRouter.register('edit', async (path: string) => {
      try {
        const content = await this.vfs.readFile(this.desktop.getActivePrincipal(), path);
        this.desktop.modals.editor.open(path, content);
        this.desktop.closeMobileDrawers();
      } catch (e: any) {
        if (window.AppUI) window.AppUI.notify(`File not found: ${e.message}`, 'error');
      }
      this._restoreAddressBar();
    });

    // metaos://view/... (強制的にHostメディアビューアで開く)
    this.uriRouter.register('view', async (path: string) => {
      try {
        const blob = await this.vfs.readBlob(this.desktop.getActivePrincipal(), path);
        this.desktop.modals.media.open(path, blob);
        this.desktop.closeMobileDrawers();
      } catch (e: any) {
        if (window.AppUI) window.AppUI.notify(`File not found: ${e.message}`, 'error');
      }
      this._restoreAddressBar();
    });

    // metaos://system/... (システムモーダルを開く)
    this.uriRouter.register('system', async (path: string) => {
      const target = path.toLowerCase();
      if (target === 'settings') {
        this.desktop.modals.system.open();
      } else if (target === 'api_keys') {
        this.desktop.modals.apiSettings.open();
      } else if (target === 'monitor') {
        this.desktop.modals.processMonitor.open();
      } else {
        if (window.AppUI) window.AppUI.notify(`Unknown system modal: ${target}`, 'warning');
      }
      this._restoreAddressBar();
      this.desktop.closeMobileDrawers();
    });
  }

  // ==========================================
  // 3. VFS Events (Filesystem Changes)
  // ==========================================
  private _bindVfsEvents(): void {
    this.eventBus.subscribe((mutations) => {
      this.desktop.updateStorageUI(this.vfs.getUsage());

      for (const mutation of mutations) {
        if (!mutation.path.startsWith('system/logs/')) {
          // 稼働中のゲストアプリへ新しいMutation形式で状態変更を通知
          this.processManager.broadcast('vfs_mutation', mutation);
        }
      }
    });

    // 履歴や VFS 変更時にセーブフィードバックを走らせる
    this.history.on('change', () => this.desktop.triggerAutoSaveFeedback());
    this.eventBus.subscribe(() => this.desktop.triggerAutoSaveFeedback());
  }

  // ==========================================
  // 4. Explorer Panel Events
  // ==========================================
  private _bindExplorerEvents(): void {
    const explorer = this.desktop.panels.explorer;

    explorer.on('open_file', async (path: string, resolvedApp?: ResolvedApp) => {
      // 解決済みアプリ情報が渡されなければ、デフォルトの振る舞い（UriRouter経由）に落とし込む
      if (!resolvedApp) {
        this.uriRouter.dispatch(`metaos://open/${path}`);
      } else {
        // AppRegistryで紐付けられたアプリを明示的に起動
        if (resolvedApp.appId === 'HostRunner') {
          this.uriRouter.dispatch(`metaos://run/${path}`);
        } else if (resolvedApp.appId === 'HostEditor') {
          this.uriRouter.dispatch(`metaos://edit/${path}`);
        } else if (resolvedApp.appId === 'HostMediaViewer') {
          this.uriRouter.dispatch(`metaos://view/${path}`);
        } else {
          // Guestアプリを明示指定で開く
          const currentUri = `metaos://open/${path}`;
          await this.processManager.spawn({
            pid: resolvedApp.appId,
            path: resolvedApp.appPath!,
            show: true,
            args: { file: path },
            currentUri,
          });
        }
      }
    });

    explorer.on('history_event', (type: string, desc: string) => {
      const lpml = `<event type="${type}">\n${desc}\n</event>`;
      const turn = this.history.append('system', lpml, {
        type: 'event_log',
        trigger_llm: false,
      });
      this.desktop.panels.chat.appendTurn(turn);
    });

    explorer.on('properties_request', (path: string) => {
      this.desktop.modals.properties.open(path, this.desktop.getActivePrincipal());
    });

    explorer.on('add_to_context', (paths: string[]) => {
      paths.forEach((p) => this.desktop.panels.chat.addVfsReference(p));
    });

    explorer.on('spawn_daemon', async (path: string) => {
      try {
        await this.processManager.spawn({
          path,
          type: 'daemon',
          show: false,
        });
        if (window.AppUI) window.AppUI.notify(`Spawned ${path} as daemon`, 'success');
      } catch (e: any) {
        if (window.AppUI) window.AppUI.notify(`Failed to spawn daemon: ${e.message}`, 'error');
      }
    });
  }

  // ==========================================
  // 5. Chat Panel Events
  // ==========================================
  private _bindChatEvents(): void {
    const chat = this.desktop.panels.chat;

    chat.on('send', (text: string, attachments: File[], vfsReferences: string[], opts?: ChatSendOptions) => {
      this._handleChatSend(text, attachments, vfsReferences, opts);
    });

    chat.on('stop', () => this.engine.stop());

    chat.on('clear', async () => {
      const res = await window.AppUI?.showMessageBox({
        title: 'Clear Chat History',
        message: 'Are you sure you want to clear the chat history and media cache?',
        type: 'warning',
        buttons: [
          { label: 'Cancel', value: false, style: 'normal', isCancel: true },
          { label: 'Clear History', value: true, style: 'danger', isDefault: true },
        ],
      });
      if (res && res.action) {
        // 履歴を消しても、走っているアプリ・デーモンの道具は生きている。
        // 登録時の tool_available は履歴ごと消えるので、リセット時と同じく定義を積み直す（T-0246）。
        this.sessionManager.clearSession({
          purgeMedia: true,
          triggerLlm: false,
          restoreTools: true,
        });
      }
    });

    chat.on('delete_turn', (id: string) => {
      this.history.delete(id);
      chat.renderHistory(this.history.get());
    });

    chat.on('preview_request', async (name: string, src: string, mime: string, path?: string) => {
      if (path) {
        try {
          const blob = await this.vfs.readBlob(this.desktop.getActivePrincipal(), path);
          this.desktop.modals.media.open(path.split('/').pop() || name, blob, mime);
        } catch (e: any) {
          if (window.AppUI) window.AppUI.notify(`Cannot open media: ${e.message}`, 'error');
        }
      } else if (src.startsWith('data:')) {
        const parts = src.split(',');
        const bstr = atob(parts[1]);
        let n = bstr.length;
        const u8arr = new Uint8Array(n);
        while (n--) u8arr[n] = bstr.charCodeAt(n);
        const blob = new Blob([u8arr], { type: mime });
        this.desktop.modals.media.open(name, blob, mime);
      }
      this.desktop.closeMobileDrawers();
    });
  }

  // ==========================================
  // 6. Engine (AI) Events
  // ==========================================
  private _bindEngineEvents(): void {
    const chat = this.desktop.panels.chat;

    this.engine.on('turn_start', (data: any) => {
      if (data.role === 'model') {
        this.toolPhase = false;
        chat.setProcessing(true, 'thinking');
        chat.startStreaming(data.turnId);
      }
    });

    this.engine.on('stream_chunk', (chunk: string) => {
      chat.updateStreaming(chunk);
    });

    this.engine.on('turn_end', (data: any) => {
      const role = data.role || (data.turn && data.turn.role);
      if (role === 'model') {
        chat.finalizeStreaming();
      }
      const turn = data.turn || this.history.getLast();
      if (turn) {
        chat.appendTurn(turn);
      }
      // 表示の切り替えのみ。Engine の挙動には触れない。
      const action = decideIndicatorOnTurnEnd(role, this.engine.isRunning, this.toolPhase);
      if (action === 'processing') {
        this.toolPhase = true;
        chat.setProcessing(true, 'processing');
      } else if (action === 'hide') {
        chat.setProcessing(false);
      }
    });

    this.engine.on('loop_stop', (data: any) => {
      if (chat.currentStreamEl) chat.finalizeStreaming();
      this.toolPhase = false;
      chat.setProcessing(false);
      if (data && data.reason === 'error') {
        console.error('[EventOrchestrator] Loop stopped due to error:', data.error);
      }
    });
  }

  // ==========================================
  // 7. Modal Events
  // ==========================================
  private _bindModalEvents(): void {
    // API設定の保存時はエンジンを再構成
    this.desktop.modals.apiSettings.on('secrets_updated', async () => {
      await this.cognitiveManager.refreshEngineConfig();
    });

    // エディタの保存
    this.desktop.modals.editor.on('save', async (path: string, content: string) => {
      try {
        await this.vfs.writeFile(this.desktop.getActivePrincipal(), path, content, {
          overwrite: true,
        });
        const msg = VfsEventFormatter.format({
          actor: 'User',
          action: 'edit',
          items: [{ srcPath: path }],
        });
        const lpml = `<event type="file_edited">\n${msg}\n</event>`;
        const turn = this.history.append('system', lpml, {
          type: 'event_log',
          trigger_llm: false,
        });
        this.desktop.panels.chat.appendTurn(turn);
        return true;
      } catch (e: any) {
        if (window.AppUI) window.AppUI.notify(`Save failed: ${e.message}`, 'error');
        return false;
      }
    });

    // セッションクリア後のUI更新
    this.sessionManager.setOnClearedCallback(() => {
      this.desktop.panels.chat.renderHistory(this.history.get());
    });
  }

  // --- Helper Methods ---

  private _restoreAddressBar(): void {
    const fgApp = Array.from(this.processManager.processes.values()).find((p) => p.state === 'foreground');
    const homePath = this.configManager.get('appearance')?.layout?.homePath || 'apps/home.html';
    const uri = fgApp ? fgApp.currentUri : `metaos://run/${homePath}`;
    this.desktop.updateAddressBar(uri);
  }

  /**
   * チャットから送信されたテキストとメディアの統合処理
   * opts.silent: 履歴に置くだけで LLM を起こさない（処理中表示も出さない）
   */
  private async _handleChatSend(
    text: string,
    attachments: File[],
    vfsReferences: string[],
    opts: ChatSendOptions = {},
  ) {
    const CACHE_DIR = 'system/temp/media';
    const content: any[] = [];

    // 1. 既存VFSパスの参照
    for (const path of vfsReferences) {
      content.push({
        text: `<user_attachment path="${path}">[Existing VFS Path]</user_attachment>`,
      });
    }

    // 2. アップロードされたファイルの処理
    for (const file of attachments) {
      const isText =
        file.type.startsWith('text/') ||
        file.type === 'application/json' ||
        file.type === 'application/xml' ||
        !!file.name.match(/\.(txt|md|js|json|html|css|xml|yml|yaml|csv|log|sh|py)$/i);

      const reader = new FileReader();
      const data = await new Promise<string>((r) => {
        reader.onload = () => r(reader.result as string);
        if (isText) reader.readAsText(file);
        else reader.readAsDataURL(file);
      });

      const timestamp = Date.now();
      const safeName = file.name.replace(/[\/\\:*?"<>|\x00-\x1F]/g, '_');
      const path = `${CACHE_DIR}/${timestamp}_${safeName}`;

      try {
        if (isText) {
          await this.vfs.writeFile(this.desktop.getActivePrincipal(), path, data, {
            system: true,
            overwrite: true,
          });
          content.push({
            text: `<user_attachment name="${file.name}" path="${path}">\n${data}\n</user_attachment>`,
          });
        } else {
          // バイナリは Blob のまま VFS の ContentStore (OPFS) に逃がす
          await this.vfs.writeFile(this.desktop.getActivePrincipal(), path, file, {
            system: true,
            overwrite: true,
          });
          content.push({
            media: {
              path: path,
              mimeType: file.type || 'application/octet-stream',
              metadata: {},
            },
          });
          content.push({
            text: `<user_attachment path="${path}">[Binary File: ${file.name}]</user_attachment>`,
          });
        }
      } catch (e: any) {
        console.error(`[EventOrchestrator] Failed to save upload: ${path}`, e);
        if (window.AppUI) window.AppUI.notify(`Failed to save attachment: ${e.message}`, 'error');
        return;
      }
    }

    // 3. テキストの追加と送信
    if (text) content.push({ text: text });
    if (content.length === 0) return;

    if (opts.silent) {
      await this.engine.injectUserTurn(content, { trigger_llm: false });
      return;
    }
    await this.cognitiveManager.refreshEngineConfig();
    this.desktop.panels.chat.setProcessing(true);
    await this.engine.injectUserTurn(content);
  }
}
