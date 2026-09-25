/**
 * src/shell/windowing/ProcessManager.ts
 * Itera OS v2: Process and Iframe Manager
 */

import type { VfsService } from '../../core/vfs/VfsService';
import type { AppRegistry } from '../../core/sys/AppRegistry';
import type { ConfigManager } from '../../core/sys/ConfigManager';
import { USER_PRINCIPAL } from '../../core/vfs/types';
import { GuestCompiler } from './GuestCompiler';
import { resolveRelativePath } from '../../utils/path';
import { t, escapeHtml } from '../../i18n/i18n';

export interface Process {
  pid: string;
  path: string;
  type: 'app' | 'daemon';
  state: 'foreground' | 'background' | 'running';
  iframe: HTMLIFrameElement;
  blobUrls: string[];
  lastActiveTime: number;
  args?: Record<string, string>;
  currentUri: string;
}

/**
 * 「現在の場所」（T-0453）。前面のアプリと、そのアプリが申告した URI。
 * ブラウザに倣った 3 層のうち OS が持つ唯一の正: ①場所（ここ）／②アドレスバー（表示）／③履歴（記録）。
 * ②③はシェルの側で 'current_route_changed' を購読する。ProcessManager は履歴を知らない。
 */
export interface CurrentRoute {
  pid: string;
  uri: string;
}

export interface SpawnOptions {
  pid?: string;
  path: string;
  type?: 'app' | 'daemon';
  show?: boolean;
  forceReload?: boolean;
  args?: Record<string, string>;
  currentUri?: string;
}

/**
 * ゲストの spawn(path, { args }) は URI に引数が出ないので、値が全部 文字列／数／真偽 なら `?` に写す（T-0453）。
 * 履歴から戻ったときに同じ引数で開けるようにするため。物や配列（pick の items など）は写せないので、そのときは path だけ。
 * path が既に `?` を持つときは触らない。
 */
export function queryFromArgs(path: string, args?: Record<string, unknown>): string {
  if (!args || /[?#]/.test(path)) return '';
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return '';
    q.set(k, String(v));
  }
  const str = q.toString();
  return str ? `?${str}` : '';
}

/**
 * path に付いた `?query` を args へ移す（T-0542）。`#hash` は path に残す。
 * ゲストが `nav.declare('?view=history')` で場所を申告すると、プロセスの path は `x.html?view=history` になる。
 * それをそのまま起動し直す（アドレスバーの再読み込み・ゲストの `spawn('x.html?a=1')`）と、
 * コンパイラは blob URL に query を付けていた（Firefox では開けない）うえ、query の中身はゲストに届かなかった。
 * query の値は args より優先する（申告された場所が、起動したときの引数より新しい）。
 */
export function moveQueryToArgs(
  path: string,
  args?: Record<string, string>,
): { path: string; args?: Record<string, string> } {
  const hashIdx = path.indexOf('#');
  const beforeHash = hashIdx === -1 ? path : path.slice(0, hashIdx);
  const hash = hashIdx === -1 ? '' : path.slice(hashIdx);
  const qIdx = beforeHash.indexOf('?');
  if (qIdx === -1) return { path, args };
  const fromQuery = Object.fromEntries(new URLSearchParams(beforeHash.slice(qIdx + 1)));
  return { path: beforeHash.slice(0, qIdx) + hash, args: { ...(args || {}), ...fromQuery } };
}

export class ProcessManager {
  private vfs: VfsService;
  private compiler: GuestCompiler;
  private appRegistry: AppRegistry;
  private configManager: ConfigManager;
  public processes: Map<string, Process> = new Map();
  public currentRoute: CurrentRoute | null = null;
  private MAX_APPS = 10;
  private events: Record<string, Function[]> = {};
  private els: Record<string, HTMLElement | null> = {};

  constructor(vfs: VfsService, appRegistry: AppRegistry, configManager: ConfigManager) {
    this.vfs = vfs;
    this.appRegistry = appRegistry;
    this.configManager = configManager;
    this.compiler = new GuestCompiler();
    this._initElements();
    this._bindEvents();
  }

  on(event: string, callback: Function): void {
    if (!this.events[event]) this.events[event] = [];
    this.events[event].push(callback);
  }

  private _initElements(): void {
    this.els = {
      APPS_CONTAINER: document.getElementById('apps-container'),
      BG_CONTAINER: document.getElementById('background-processes'),
      LOADER: document.getElementById('preview-loader'),
      BTN_HOME: document.getElementById('btn-home'),
      BTN_REFRESH: document.getElementById('btn-refresh'),
      ADDRESS_BAR: document.getElementById('preview-address-bar'),
    };
  }

  private _bindEvents(): void {
    if (this.els.BTN_REFRESH) {
      this.els.BTN_REFRESH.onclick = () => {
        let targetProc = Array.from(this.processes.values()).find((p) => p.state === 'foreground');
        if (targetProc) {
          this.spawn({
            pid: targetProc.pid,
            path: targetProc.path,
            type: targetProc.type,
            show: true,
            forceReload: true,
            args: targetProc.args,
            currentUri: targetProc.currentUri,
          });
        } else {
          const homePath = this.configManager.homePath();
          this.spawn({ path: homePath, show: true, forceReload: true });
        }
      };
    }
    if (this.els.BTN_HOME) {
      this.els.BTN_HOME.onclick = () => {
        const homePath = this.configManager.homePath();
        this.spawn({ path: homePath, show: true });
      };
    }
  }

  private _resolveProcessInfo(options: SpawnOptions) {
    const basePath = options.path.split(/[?#]/)[0];
    let pid = options.pid || '';
    let type: 'app' | 'daemon' | undefined = options.type;

    // レジストリ検索（指定がない場合）
    if (!pid || !type) {
      const apps = this.appRegistry.getAllApps();
      const svcs = this.appRegistry.getAllServices();
      const foundApp = apps.find((a) => a.path === basePath);
      const foundSvc = svcs.find((s) => s.path === basePath);

      if (foundApp) {
        if (!pid) pid = foundApp.id;
        if (!type) type = 'app';
      } else if (foundSvc) {
        if (!pid) pid = foundSvc.id;
        if (!type) type = 'daemon';
      } else {
        const homePath = this.configManager.homePath();
        if (basePath === homePath) {
          if (!pid) pid = 'home';
          if (!type) type = 'app';
        }
      }
    }

    // 野良アプリのフォールバック
    if (!pid) {
      const safeName = basePath.replace(/[^a-zA-Z0-9_-]/g, '_');
      pid = `app_${safeName}`;
    }
    if (!type) {
      type = 'app';
    }

    // デーモンは強制的に非表示、アプリは未指定なら表示(true)
    const show = type === 'daemon' ? false : options.show !== false;

    return { pid, type, show };
  }

  /**
   * プロセスを起動、またはバックグラウンドにあるアプリをフォアグラウンドに引き出す
   */
  async spawn(options: SpawnOptions): Promise<void> {
    const { path: rawPath, forceReload = false, args: rawArgs, currentUri } = options;
    const { pid, type, show } = this._resolveProcessInfo(options);

    const uri = currentUri || `metaos://run/${rawPath}${queryFromArgs(rawPath, rawArgs)}`;
    // 起動に使う path には query を残さない（T-0542）
    const { path, args } = moveQueryToArgs(rawPath, rawArgs);
    const existingProc = this.processes.get(pid);

    if (existingProc && existingProc.iframe) {
      // 厳密なパス一致ではなくベースパスの一致でResumeを判定する（引数だけの変化を許容）
      const isExactBasePathMatch = existingProc.path.split(/[?#]/)[0] === path.split(/[?#]/)[0];

      if (!forceReload && isExactBasePathMatch && existingProc.type === type) {
        console.log(`[ProcessManager] Resume [${pid}] -> ${path}`);
        existingProc.path = path;
        existingProc.args = args;
        existingProc.currentUri = uri;

        if (show) {
          this._focusApp(pid);
          this.setCurrentRoute({ pid, uri: existingProc.currentUri });
        }

        if (this.events['process_resumed']) {
          this.events['process_resumed'].forEach((cb) => cb(existingProc));
        }

        if (existingProc.iframe.contentWindow) {
          const evtMsg = {
            protocol: 'itera:ipc:v2',
            type: 'event',
            id: 'resume_' + Date.now(),
            source: 'host',
            target: pid,
            action: 'route_changed',
            payload: { path, args },
            error: null,
          };
          existingProc.iframe.contentWindow.postMessage(evtMsg, '*');
        }
        return;
      }
    }

    // 新規起動または強制リロード
    this.kill(pid);

    if (show && this.els.LOADER) {
      this.els.LOADER.classList.remove('hidden');
    }

    try {
      const { entryUrl, blobUrls } = await this.compiler.compile(this.vfs, path, pid, args);

      const iframe = document.createElement('iframe');
      iframe.id = `proc-${pid}`;
      iframe.name = pid;
      // allow-downloads: ゲストアプリから a[download] で保存できるようにする（T-0345。スキルアプリの履歴から成果物を落とす）
      iframe.sandbox = 'allow-scripts allow-forms allow-modals allow-popups allow-same-origin allow-downloads';

      if (type === 'app') {
        iframe.className = 'absolute inset-0 w-full h-full border-none bg-app transition-opacity duration-300';
        iframe.style.opacity = '0';
        iframe.style.pointerEvents = 'none';
        iframe.style.zIndex = '1';
        if (this.els.APPS_CONTAINER) this.els.APPS_CONTAINER.appendChild(iframe);
      } else {
        if (this.els.BG_CONTAINER) this.els.BG_CONTAINER.appendChild(iframe);
      }

      this.processes.set(pid, {
        pid,
        path,
        type,
        state: type === 'app' ? 'background' : 'running',
        iframe,
        blobUrls,
        lastActiveTime: Date.now(),
        args,
        currentUri: uri,
      });

      if (type === 'app') this._enforceLRU();

      // 先にフォアグラウンド/バックグラウンドの状態を確定させる
      if (show) {
        this._focusApp(pid);
        this.setCurrentRoute({ pid, uri });
      }

      // 状態が確定した後にイベントを発行する
      if (this.events['process_spawned']) {
        this.events['process_spawned'].forEach((cb) => cb(this.processes.get(pid)));
      }

      // 非同期でのIframeロードを実行
      if (entryUrl) {
        await this._loadIframe(iframe, entryUrl);
      } else if (type === 'app') {
        // srcdoc は独立した文書なので、ホストの :root に定義した CSS 変数は
        // 継承されない。解決済みの値を埋め込む必要がある。
        const uiFont = getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim() || 'system-ui';
        iframe.srcdoc = `<div style="color:#888; padding:20px; font-family:${uiFont}, system-ui, sans-serif;">${escapeHtml(t('process.notFound', { path }))}</div>`;
      }

      console.log(`[ProcessManager] Spawned [${pid}] (Type:${type}, Show:${show}) -> ${path}`);
    } catch (e) {
      console.error(`[ProcessManager] Spawn error (${pid}):`, e);
      if (type === 'app' && window.AppUI) {
        window.AppUI.notify(t('process.launchFailed', { path }), 'error');
      }
    } finally {
      if (show && this.els.LOADER) {
        setTimeout(() => {
          this.els.LOADER!.classList.add('hidden');
        }, 200);
      }
    }
  }

  private _focusApp(targetPid: string): void {
    const targetProc = this.processes.get(targetPid);
    if (!targetProc || targetProc.type !== 'app') return;

    for (const [pid, proc] of this.processes.entries()) {
      if (proc.type === 'app' && proc.state === 'foreground' && pid !== targetPid) {
        proc.state = 'background';
        proc.iframe.style.opacity = '0';
        proc.iframe.style.pointerEvents = 'none';
        proc.iframe.style.zIndex = '1';
      }
    }

    targetProc.state = 'foreground';
    targetProc.lastActiveTime = Date.now();
    targetProc.iframe.style.opacity = '1';
    targetProc.iframe.style.pointerEvents = 'auto';
    targetProc.iframe.style.zIndex = '10';
  }

  private _enforceLRU(): void {
    const apps = Array.from(this.processes.values()).filter((p) => p.type === 'app');
    if (apps.length > this.MAX_APPS) {
      const bgApps = apps.filter((p) => p.state === 'background');
      if (bgApps.length > 0) {
        bgApps.sort((a, b) => a.lastActiveTime - b.lastActiveTime);
        const oldest = bgApps[0];
        console.log(`[ProcessManager] LRU limit reached. Killing oldest app: ${oldest.pid}`);
        this.kill(oldest.pid);
      }
    }
  }

  kill(pid: string): boolean {
    if (!this.processes.has(pid)) return false;

    const proc = this.processes.get(pid)!;

    if (proc.blobUrls) {
      proc.blobUrls.forEach((url) => URL.revokeObjectURL(url));
    }

    if (proc.iframe) {
      proc.iframe.remove();
    }

    this.processes.delete(pid);

    if (this.events['process_killed']) {
      this.events['process_killed'].forEach((cb) => cb(pid, proc));
    }

    if (proc.state === 'foreground') {
      const apps = Array.from(this.processes.values()).filter((p) => p.type === 'app');
      if (apps.length > 0) {
        apps.sort((a, b) => b.lastActiveTime - a.lastActiveTime);
        this._focusApp(apps[0].pid);
        this.setCurrentRoute({ pid: apps[0].pid, uri: apps[0].currentUri });
      } else {
        const homePath = this.configManager.homePath();
        this.spawn({ path: homePath, show: true });
      }
    }

    console.log(`[ProcessManager] Killed [${pid}]`);
    return true;
  }

  killAll(): void {
    for (const pid of this.processes.keys()) {
      this.kill(pid);
    }
  }

  reportError(pid: string, errorData: any): void {
    const proc = this.processes.get(pid);
    if (!proc) return;
    if (this.events['process_error']) {
      this.events['process_error'].forEach((cb) => cb(proc, errorData));
    }
  }

  broadcast(eventName: string, payload: any): void {
    for (const proc of this.processes.values()) {
      if (proc.iframe && proc.iframe.contentWindow) {
        const msg = {
          protocol: 'itera:ipc:v2',
          type: 'event',
          id: 'bcast_' + Date.now(),
          source: 'host',
          target: proc.pid,
          action: eventName,
          payload: payload,
          error: null,
        };
        proc.iframe.contentWindow.postMessage(msg, '*');
      }
    }
  }

  list(): any[] {
    return Array.from(this.processes.values()).map((proc) => ({
      pid: proc.pid,
      path: proc.path,
      type: proc.type,
      state: proc.state,
    }));
  }

  getArgs(pid: string): Record<string, string> | null {
    const proc = this.processes.get(pid);
    return proc ? proc.args || null : null;
  }

  /**
   * 画面を撮る。pid を渡せばそのプロセスを、省略すれば前面のアプリを撮る（T-0350）。
   * 背景のアプリも撮れる（前面/背景は z-index で分けているだけで、描画は生きている）。
   * timeoutMs は重い画面のための逃げ道。既定 30 秒
   * （実測: 14,976 ノードの画面で 18.6 秒かかった。もとの 15 秒では足りない）。
   */
  async captureScreenshot(pid?: string, timeoutMs: number = 30000): Promise<string> {
    let targetPid = pid;
    if (!targetPid) {
      const fg = Array.from(this.processes.values()).find((p) => p.state === 'foreground');
      if (fg) targetPid = fg.pid;
    }

    if (!targetPid) throw new Error('No foreground process to capture.');

    const proc = this.processes.get(targetPid);
    if (proc && proc.type === 'daemon') {
      throw new Error(`Cannot capture a daemon (it has no visible window): ${targetPid}`);
    }
    if (!proc || !proc.iframe || !proc.iframe.contentWindow) {
      throw new Error(`Process ${targetPid} not found or has no iframe.`);
    }

    return new Promise((resolve, reject) => {
      const iframe = proc.iframe;
      const handler = (e: MessageEvent) => {
        if (e.data.type === 'SCREENSHOT_RESULT' && e.data.pid === targetPid) {
          window.removeEventListener('message', handler);
          const parts = e.data.data.split(',');
          resolve(parts.length > 1 ? parts[1] : parts[0]);
        } else if (e.data.type === 'SCREENSHOT_ERROR' && e.data.pid === targetPid) {
          window.removeEventListener('message', handler);
          reject(new Error(e.data.message));
        }
      };

      window.addEventListener('message', handler);

      setTimeout(() => {
        window.removeEventListener('message', handler);
        reject(
          new Error(
            `Screenshot timeout after ${Math.round(timeoutMs / 1000)}s (${targetPid}). ` +
              `The guest did not answer. Heavy screens can exceed this; retry with a larger timeout.`,
          ),
        );
      }, timeoutMs);

      iframe.contentWindow!.postMessage({ action: 'CAPTURE' }, '*');
    });
  }

  private async _loadIframe(iframe: HTMLIFrameElement, url: string): Promise<void> {
    return new Promise((resolve) => {
      let timeoutId: ReturnType<typeof setTimeout>;
      const handler = () => {
        clearTimeout(timeoutId);
        iframe.removeEventListener('load', handler);
        resolve();
      };
      iframe.addEventListener('load', handler);
      iframe.src = url;

      timeoutId = setTimeout(() => {
        console.warn(`[ProcessManager] Iframe load timeout for URL: ${url}`);
        iframe.removeEventListener('load', handler);
        resolve();
      }, 10000);
    });
  }

  /**
   * 「現在の場所」を書き換える唯一の口（T-0453）。呼ぶのは spawn（新規・resume の show）・kill 後の切替・ゲストの申告（host:address_bar / nav:declare）。
   * 同じ場所なら何もしない。変わったらアドレスバーを描き、'current_route_changed' を発する（シェルの履歴はこれを購読する）。
   */
  public setCurrentRoute(route: CurrentRoute): void {
    const prev = this.currentRoute;
    if (prev && prev.pid === route.pid && prev.uri === route.uri) return;
    this.currentRoute = { pid: route.pid, uri: route.uri };
    this._updateAddressBar(route.uri);
    if (this.events['current_route_changed']) {
      this.events['current_route_changed'].forEach((cb) => cb(this.currentRoute, prev));
    }
  }

  /**
   * ゲストの申告（自分の画面の URL を伝える）。前面のアプリの path と currentUri を書き換え、場所を更新する。
   * path が '?' / '#' で始まれば base に付け足す。`metaos://<intent>/<path>` の完全な URI なら intent とパスに分けて受ける
   * （そのまま前置すると `metaos://run/metaos://run/…` と二重になり、path も `metaos://…` になって resume 判定と相対パスが狂う。T-0468）。
   * 戻り値は新しい URI（前面が無ければ null）。
   */
  public declareRoute(path: string): string | null {
    const fg = Array.from(this.processes.values()).find((p) => p.type === 'app' && p.state === 'foreground');
    if (!fg) return null;
    const oldBasePath = fg.path.split(/[?#]/)[0];
    // 既存の URI から intent（run / open）を保つ。完全な URI で申告されたらそちらの intent を採る
    const intentMatch = fg.currentUri.match(/^metaos:\/\/([^/]+)/);
    let intent = intentMatch ? intentMatch[1] : 'open';
    let declared = String(path || '');
    const full = declared.match(/^metaos:\/\/([^/]+)\/(.*)$/);
    if (full) {
      intent = full[1];
      declared = full[2];
    }
    const newPath =
      declared.startsWith('?') || declared.startsWith('#') ? oldBasePath + declared : declared || oldBasePath;
    fg.path = newPath;
    fg.currentUri = `metaos://${intent}/${newPath}`;
    this.setCurrentRoute({ pid: fg.pid, uri: fg.currentUri });
    return fg.currentUri;
  }

  /** アドレスバーの表示だけ（②）。場所は変えない。場所を変えるのは setCurrentRoute */
  public _updateAddressBar(uri: string): void {
    if (this.els.ADDRESS_BAR) {
      (this.els.ADDRESS_BAR as HTMLInputElement).value = uri;
    }
  }

  async resolveUrl(requestPath: string, pid: string): Promise<string> {
    const proc = this.processes.get(pid);
    if (!proc) throw new Error(`Process [${pid}] not found.`);

    const basePath = proc.path.split(/[?#]/)[0];
    const currentDir = basePath.includes('/') ? basePath.substring(0, basePath.lastIndexOf('/')) : '';

    let absPath = requestPath;
    if (requestPath.startsWith('./') || requestPath.startsWith('../') || requestPath.startsWith('/')) {
      absPath = resolveRelativePath(currentDir, requestPath);
    }

    // 解決はユーザー権限で行う（セキュリティ確保のため）
    if (!this.vfs.exists(USER_PRINCIPAL, absPath)) {
      throw new Error(`File not found: ${absPath}`);
    }

    const blob = await this.vfs.readBlob(USER_PRINCIPAL, absPath);
    const mimeType = this.compiler.getMimeType(absPath);
    const typedBlob = new Blob([blob], { type: mimeType });
    const url = URL.createObjectURL(typedBlob);

    if (!proc.blobUrls) proc.blobUrls = [];
    proc.blobUrls.push(url);

    return url;
  }
}
