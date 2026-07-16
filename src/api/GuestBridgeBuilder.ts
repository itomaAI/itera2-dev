/**
 * src/api/GuestBridgeBuilder.ts
 * Itera OS v2: Guest Bridge Code Generator
 */

export class GuestBridgeBuilder {
  private static cachedUrl: string | null = null;

  /**
   * Guest環境に注入するAPIコードを Blob URL として生成する。
   * メモリ効率化のため、生成済みのURLはキャッシュされる。
   */
  static getBlobUrl(): string {
    if (this.cachedUrl) return this.cachedUrl;

    const bundleCode = `
(function(global) {
    const PROTOCOL_VERSION = 'itera:ipc:v2';

    const generateId = () => {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
            return crypto.randomUUID();
        }
        return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    };

    class IpcMessage {
        static createRequest(source, target, action, payload = {}) {
            return { protocol: PROTOCOL_VERSION, type: 'req', id: generateId(), source, target, action, payload, error: null };
        }
        static createResponse(reqMessage, result, error = null) {
            return { protocol: PROTOCOL_VERSION, type: 'res', id: reqMessage.id, source: reqMessage.target, target: reqMessage.source, action: reqMessage.action, payload: result, error: error ? String(error) : null };
        }
        static createEvent(source, target, action, payload = {}) {
            return { protocol: PROTOCOL_VERSION, type: 'event', id: generateId(), source, target, action, payload, error: null };
        }
        static isValid(msg) {
            return msg && msg.protocol === PROTOCOL_VERSION && msg.type && msg.source && msg.target;
        }
    }

    class RpcManager {
        constructor(timeoutMs = 150000) {
            this.pendingRequests = new Map();
            this.timeoutMs = timeoutMs;
        }
        waitFor(id) {
            return new Promise((resolve, reject) => {
                const timeoutId = setTimeout(() => {
                    if (this.pendingRequests.has(id)) {
                        this.pendingRequests.delete(id);
                        reject(new Error("RPC Timeout: Request " + id + " exceeded " + this.timeoutMs + "ms"));
                    }
                }, this.timeoutMs);
                this.pendingRequests.set(id, { resolve, reject, timeoutId });
            });
        }
        resolve(id, result, error = null) {
            if (this.pendingRequests.has(id)) {
                const pending = this.pendingRequests.get(id);
                clearTimeout(pending.timeoutId);
                this.pendingRequests.delete(id);
                if (error) pending.reject(new Error(error));
                else pending.resolve(result);
            }
        }
    }

    class GuestTransport {
        constructor(pid) {
            this.pid = pid;
            this.rpc = new RpcManager();
            this.handlers = new Map();
            this.eventListeners = new Map();
            this._initListener();
        }
        registerHandler(action, handler) {
            this.handlers.set(action, handler);
        }
        on(action, callback) {
            if (!this.eventListeners.has(action)) this.eventListeners.set(action, []);
            this.eventListeners.get(action).push(callback);
        }
        off(action, callback) {
            if (this.eventListeners.has(action)) {
                const filtered = this.eventListeners.get(action).filter(cb => cb !== callback);
                if (filtered.length === 0) this.eventListeners.delete(action);
                else this.eventListeners.set(action, filtered);
            }
        }
        async requestHost(action, payload) {
            const req = IpcMessage.createRequest(this.pid, 'host', action, payload);
            const promise = this.rpc.waitFor(req.id);
            window.parent.postMessage(req, '*');
            return promise;
        }
        _initListener() {
            window.addEventListener('message', async (e) => {
                const msg = e.data;
                if (!IpcMessage.isValid(msg)) return;
                if (msg.target !== this.pid && msg.target !== 'broadcast') return;

                if (msg.type === 'req') {
                    const handler = this.handlers.get(msg.action);
                    let result = null, error = null;
                    if (handler) {
                        try { result = await handler(msg.payload); } 
                        catch (err) { error = err.message || String(err); }
                    } else {
                        error = "No handler registered for action: " + msg.action;
                    }
                    if (e.source) e.source.postMessage(IpcMessage.createResponse(msg, result, error), '*');
                } else if (msg.type === 'res') {
                    this.rpc.resolve(msg.id, msg.payload, msg.error);
                } else if (msg.type === 'event') {
                    const listeners = this.eventListeners.get(msg.action);
                    if (listeners) listeners.forEach(cb => cb(msg.payload));
                }
            });
        }
    }

    const MY_PID = window.__ITERA_PID__ || window.name || 'unknown';
    const transport = new GuestTransport(MY_PID);
    const localToolHandlers = new Map();
    const mountHandlers = new Map();

    transport.registerHandler('fs:resolve_missing', async (payload) => {
        let longestMatch = '';
        let matchedHandler = null;
        for (const [mountedPath, handler] of mountHandlers.entries()) {
            if (payload.path === mountedPath || payload.path.startsWith(mountedPath + '/')) {
                if (mountedPath.length >= longestMatch.length) {
                    longestMatch = mountedPath;
                    matchedHandler = handler;
                }
            }
        }
        if (matchedHandler) {
            return await matchedHandler(payload.path);
        }
        return false;
    });

    transport.registerHandler('execute_tool', async (payload) => {
        const handler = localToolHandlers.get(payload.name);
        if (!handler) throw new Error("Tool handler not found: " + payload.name);
        return await handler(payload.params);
    });

    transport.registerHandler('eval_js', async (payload) => {
        const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
        const func = new AsyncFunction(payload.code);
        return await func();
    });

    global.MetaOS = {
        fs: {
            read: async (path, opts = {}) => transport.requestHost('fs:read', { path, opts }),
            write: async (path, content, opts = {}) => transport.requestHost('fs:write', { path, content, opts }),
            append: async (path, content, opts = {}) => transport.requestHost('fs:append', { path, content, opts }),
            delete: async (path, opts = {}) => transport.requestHost('fs:delete', { path, opts }),
            rename: async (oldPath, newPath, opts = {}) => transport.requestHost('fs:rename', { oldPath, newPath, opts }),
            copy: async (srcPath, destPath, opts = {}) => transport.requestHost('fs:copy', { srcPath, destPath, opts }),
            mkdir: async (path, opts = {}) => transport.requestHost('fs:mkdir', { path, opts }),
            stat: async (path) => transport.requestHost('fs:stat', { path }),
            list: async (path, opts = {}) => transport.requestHost('fs:list', { path, opts }),
            exists: async (path) => transport.requestHost('fs:exists', { path }),
            getSyncState: async (path) => transport.requestHost('fs:get_sync_state', { path }),
            resolveUrl: async (path) => transport.requestHost('fs:resolve_url', { path }),
            getAcl: async (path) => transport.requestHost('fs:get_acl', { path }),
            setAcl: async (path, acl, opts = {}) => transport.requestHost('fs:set_acl', { path, acl, opts }),
            mount: async (path, onFetchMissing) => {
                let normPath = path.replace(/\\\\/g, '/').replace(/^\\/+/, '').replace(/\\/+$/, '');
                mountHandlers.set(normPath, onFetchMissing);
                return transport.requestHost('fs:mount', { path: normPath });
            },
            unmount: async (path) => {
                let normPath = path.replace(/\\\\/g, '/').replace(/^\\/+/, '').replace(/\\/+$/, '');
                mountHandlers.delete(normPath);
                return transport.requestHost('fs:unmount', { path: normPath });
            },
            createStub: async (path, meta, opts = {}) => transport.requestHost('fs:create_stub', { path, meta, opts })
        },
        ai: {
            ask: async (text, opts = {}) => transport.requestHost('ai:ask', { text, opts }),
            task: async (instruction, context, opts = {}) => transport.requestHost('ai:task', { instruction, context, opts }),
            log: async (message, type, opts = {}) => transport.requestHost('ai:log', { message, type, opts }),
            stop: async () => transport.requestHost('ai:stop', {})
        },
        system: {
            spawn: async (path, opts = {}) => transport.requestHost('sys:spawn', { path, opts }),
            kill: async (pid) => transport.requestHost('sys:kill', { pid }),
            ps: async () => transport.requestHost('sys:ps', {}),
            info: async () => transport.requestHost('sys:info', {}),
            broadcast: async (eventName, payload) => transport.requestHost('sys:broadcast', { eventName, payload }),
            on: (eventName, handler) => transport.on(eventName, handler),
            off: (eventName, handler) => transport.off(eventName, handler),
            capture: async (pid) => transport.requestHost('sys:capture', { pid }),
            getArgs: async () => transport.requestHost('sys:get_args', {}),
            getProviders: async () => transport.requestHost('sys:get_providers', {})
        },
        host: {
            openEditor: async (path) => transport.requestHost('host:open_editor', { path }),
            notify: async (message, title) => transport.requestHost('host:notify', { message, title }),
            copyText: async (text) => transport.requestHost('host:copy', { text }),
            openExternal: async (url) => transport.requestHost('host:open_url', { url }),
            updateAddressBar: async (path) => transport.requestHost('host:address_bar', { path })
        },
        net: {
            fetch: async (url, options = {}) => transport.requestHost('net:fetch', { url, options }),
            download: async (url, destPath, options = {}) => transport.requestHost('net:download', { url, destPath, options }),
            oauth: async (providerId, authUrl, instructions) => transport.requestHost('net:oauth', { providerId, authUrl, instructions })
        },
        device: {
            getLocation: async (options = {}) => transport.requestHost('dev:location', { options }),
            takePhoto: async (options = {}) => transport.requestHost('dev:photo', { options }),
            recordAudio: async (options = {}) => transport.requestHost('dev:audio', { options }),
            vibrate: async (pattern) => transport.requestHost('dev:vibrate', { pattern })
        },
        tools: {
            register: async (toolDef) => {
                if (!toolDef || !toolDef.name || typeof toolDef.handler !== 'function') {
                    throw new Error("Invalid tool definition.");
                }
                localToolHandlers.set(toolDef.name, toolDef.handler);
                await transport.requestHost('tools:register', {
                    name: toolDef.name,
                    description: toolDef.description,
                    definition: toolDef.definition
                });
            },
            unregister: async (name) => {
                localToolHandlers.delete(name);
                await transport.requestHost('tools:unregister', { name });
            }
        }
    };
    
    console.log("[Itera] MetaOS Bridge v2 Initialized (PID: " + MY_PID + ")");
})(window);
    `.trim();

    const blob = new Blob([bundleCode], { type: 'application/javascript' });
    this.cachedUrl = URL.createObjectURL(blob);
    return this.cachedUrl;
  }
}
