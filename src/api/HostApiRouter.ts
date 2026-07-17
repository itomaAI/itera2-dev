/**
 * src/api/HostApiRouter.ts
 * Itera OS v2: Host API Router
 */

import type { HostTransport } from '../ipc/HostTransport';
import type { VfsService } from '../core/vfs/VfsService';
import type { ConfigManager } from '../core/sys/ConfigManager';
import { USER_PRINCIPAL } from '../core/vfs/types';

// 依存モジュールのダックタイピング・インターフェース (未実装モジュール用)
export interface IHistoryManager {
  append(role: string, content: any, meta?: any): any;
}
export interface IProcessManager {
  spawn(
    pid: string,
    path: string,
    mode?: string,
    forceReload?: boolean,
    args?: Record<string, string>,
    currentUri?: string,
  ): Promise<void>;
  kill(pid: string): boolean;
  list(): any[];
  broadcast(eventName: string, payload: any): void;
  captureScreenshot(pid?: string): Promise<string>;
  resolveUrl(path: string, pid: string): Promise<string>;
  getArgs(pid: string): Record<string, string> | null;
  processes: Map<string, any>;
  _updateAddressBar(path: string): void;
}
export interface IEngine {
  injectUserTurn(content: any[], meta?: any): Promise<void>;
  stop(): void;
}
export interface IShell {
  _refreshEngineConfig(): Promise<void>;
  _closeMobileDrawers(): void;
  getMergedProviders?(): Promise<any[]>;
  panels: { chat: any };
  modals: { editor: any; camera: any; audio: any };
}
export interface IToolRegistry {
  registerDynamicTool(name: string, sourcePid: string, definition: any): void;
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
          const bstr = atob(content);
          let n = bstr.length;
          const u8arr = new Uint8Array(n);
          while (n--) {
            u8arr[n] = bstr.charCodeAt(n);
          }
          return new Blob([u8arr], { type: 'application/octet-stream' });
        } else if (encoding === 'dataurl') {
          const parts = content.split(',');
          const mimeMatch = parts[0] ? parts[0].match(/:(.*?);/) : null;
          const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
          const base64Data = parts.length > 1 ? parts[1] : parts[0];

          const bstr = atob(base64Data);
          let n = bstr.length;
          const u8arr = new Uint8Array(n);
          while (n--) {
            u8arr[n] = bstr.charCodeAt(n);
          }
          return new Blob([u8arr], { type: mime });
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
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
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
      this._checkAndEmitEvent(opts, 'file_edited', `App [${sourcePid}] edited file: ${path}`);
      return res;
    });

    t.registerHandler('fs:append', async ({ path, content, opts }, sourcePid) => {
      const principal = getPrincipal(sourcePid);
      const res = await d.vfs.appendFile(principal, path, content, opts);
      this._checkAndEmitEvent(opts, 'file_edited', `App [${sourcePid}] appended to file: ${path}`);
      return res;
    });

    t.registerHandler('fs:delete', async ({ path, opts }, sourcePid) => {
      const principal = getPrincipal(sourcePid);
      const res = await d.vfs.deleteFile(principal, path, opts);
      this._checkAndEmitEvent(opts, 'file_deleted', `App [${sourcePid}] deleted file: ${path}`);
      return res;
    });

    t.registerHandler('fs:rename', async ({ oldPath, newPath, opts }, sourcePid) => {
      const principal = getPrincipal(sourcePid);
      const res = await d.vfs.rename(principal, oldPath, newPath, opts);
      this._checkAndEmitEvent(opts, 'file_moved', `App [${sourcePid}] renamed file: ${oldPath} -> ${newPath}`);
      return res;
    });

    t.registerHandler('fs:copy', async ({ srcPath, destPath, opts }, sourcePid) => {
      const principal = getPrincipal(sourcePid);
      const res = await d.vfs.copyFile(principal, srcPath, destPath, opts);
      this._checkAndEmitEvent(opts, 'file_copied', `App [${sourcePid}] copied file: ${srcPath} -> ${destPath}`);
      return res;
    });

    t.registerHandler('fs:mkdir', async ({ path, opts }, sourcePid) => {
      const principal = getPrincipal(sourcePid);
      const res = await d.vfs.mkdir(principal, path, opts);
      this._checkAndEmitEvent(opts, 'folder_created', `App [${sourcePid}] created folder: ${path}`);
      return res;
    });

    t.registerHandler('fs:stat', async ({ path }, sourcePid) => d.vfs.stat(getPrincipal(sourcePid), path));
    t.registerHandler('fs:list', async ({ path, opts }, sourcePid) => d.vfs.listFiles(getPrincipal(sourcePid), { path, ...opts }));
    t.registerHandler('fs:exists', async ({ path }, sourcePid) => d.vfs.exists(getPrincipal(sourcePid), path));
    t.registerHandler('fs:get_sync_state', async ({ path }, sourcePid) => d.vfs.getSyncState(getPrincipal(sourcePid), path || ''));
    
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

      await d.shell._refreshEngineConfig();
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
        await d.shell._refreshEngineConfig();
        d.shell.panels.chat.setProcessing(true);
      }
      return true;
    });

    t.registerHandler('ai:log', async ({ message, type, opts }) => {
      if (!d.history || !d.shell) return false;
      const triggerLlm = opts?.trigger_llm === true;
      const lpml = `<event type="${type || 'app_event'}">\n${message}\n</event>`;
      const turn = d.history.append('system', lpml, {
        type: 'event_log',
        trigger_llm: triggerLlm,
      });
      d.shell.panels.chat.appendTurn(turn);
      if (triggerLlm) {
        await d.shell._refreshEngineConfig();
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
      const pid = opts?.pid || 'main';
      const mode = opts?.mode || 'background';
      const force = opts?.forceReload || false;
      const args = opts?.args; // V2 新機能: args渡し
      const currentUri = `metaos://run/${path}`;
      await d.processManager.spawn(pid, path, mode, force, args, currentUri);
      if (mode === 'foreground' && d.shell) d.shell._closeMobileDrawers();
      return true;
    });

    t.registerHandler('sys:kill', async ({ pid }) => (d.processManager ? d.processManager.kill(pid) : false));
    t.registerHandler('sys:ps', async () => (d.processManager ? d.processManager.list() : []));
    t.registerHandler('sys:info', async (_, sourcePid) => {
      if (!d.processManager) return null;
      const p = d.processManager.processes.get(sourcePid);
      return p ? { pid: p.pid, path: p.path, mode: p.mode } : null;
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
    t.registerHandler('host:notify', async ({ message, title }) => {
      if (window.AppUI) window.AppUI.notify(`${title}: ${message}`);
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
        responseObj.data = await new Promise((r, j) => {
          const reader = new FileReader();
          reader.onloadend = () => r(reader.result);
          reader.onerror = j;
          reader.readAsDataURL(blob);
        });
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
      });
      return { path: destPath, size: blob.size };
    });

    t.registerHandler('net:oauth', async ({ providerId, authUrl, instructions }) => {
      window.open(authUrl, '_blank', 'noopener,noreferrer');
      if (window.AppUI) {
        const token = await window.AppUI.prompt(instructions || `Paste access token for '${providerId}':`, providerId);
        if (token && token.trim()) {
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
