/**
 * src/shell/windowing/ProcessManager.ts
 * Itera OS v2: Process and Iframe Manager
 */

import type { VfsService } from "../../core/vfs/VfsService";
import { SYSTEM_PRINCIPAL } from "../../core/vfs/types";
import { GuestCompiler } from "./GuestCompiler";

export interface Process {
  pid: string;
  path: string;
  mode: string;
  type: "app" | "daemon";
  state: "foreground" | "background" | "running";
  iframe: HTMLIFrameElement;
  blobUrls: string[];
  lastActiveTime: number;
  args?: Record<string, string>;
  currentUri: string;
}

export class ProcessManager {
  private vfs: VfsService;
  private compiler: GuestCompiler;
  public processes: Map<string, Process> = new Map();
  private MAX_APPS = 5;
  private events: Record<string, Function> = {};
  private els: Record<string, HTMLElement | null> = {};

  constructor(vfs: VfsService) {
    this.vfs = vfs;
    this.compiler = new GuestCompiler();
    this._initElements();
    this._bindEvents();
  }

  on(event: string, callback: Function): void {
    this.events[event] = callback;
  }

  private _initElements(): void {
    this.els = {
      APPS_CONTAINER: document.getElementById("apps-container"),
      BG_CONTAINER: document.getElementById("background-processes"),
      LOADER: document.getElementById("preview-loader"),
      BTN_HOME: document.getElementById("btn-home"),
      BTN_REFRESH: document.getElementById("btn-refresh"),
      ADDRESS_BAR: document.getElementById("preview-address-bar"),
    };

    const legacyFrame = document.getElementById("preview-frame");
    if (legacyFrame) legacyFrame.remove();
  }

  private _bindEvents(): void {
    if (this.els.BTN_REFRESH) {
      this.els.BTN_REFRESH.onclick = () => {
        let targetProc = Array.from(this.processes.values()).find(
          (p) => p.state === "foreground",
        );
        if (targetProc) {
          this.spawn(
            targetProc.pid,
            targetProc.path,
            "foreground",
            true,
            targetProc.launchContext,
            targetProc.currentUri,
          );
        } else {
          this.spawn(
            "main",
            "index.html",
            "foreground",
            true,
            null,
            "metaos://open/index.html",
          );
        }
      };
    }
    if (this.els.BTN_HOME) {
      this.els.BTN_HOME.onclick = () => {
        this.spawn(
          "main",
          "index.html",
          "foreground",
          false,
          null,
          "metaos://open/index.html",
        );
      };
    }
  }

  /**
   * プロセスを起動、またはバックグラウンドにあるアプリをフォアグラウンドに引き出す
   */
  async spawn(
    pid: string,
    path: string,
    mode: string = "background",
    forceReload: boolean = false,
    args?: Record<string, string>,
    currentUri?: string,
  ): Promise<void> {
    // V1のハック継承: 'main' が指定された場合はパスベースのPIDに変換し、強制的にフォアグラウンドにする
    if (pid === "main") {
      mode = "foreground";
      const basePath = path.split(/[?#]/)[0];
      const safeName = basePath.replace(/[^a-zA-Z0-9_-]/g, "_");
      pid = `app_${safeName}`;
    }

    const type =
      mode === "foreground" || pid.startsWith("app_") ? "app" : "daemon";
    const existingProc = this.processes.get(pid);
    const uri = currentUri || `metaos://run/${path}`;

    if (existingProc && existingProc.iframe) {
      const isExactPathMatch = existingProc.path === path;

      // 同じアプリがすでに生きていれば Resume
      if (!forceReload && isExactPathMatch && existingProc.type === type) {
        console.log(`[ProcessManager] Resume [${pid}] -> ${path}`);
        existingProc.path = path;
        existingProc.args = args;
        existingProc.currentUri = uri;

        if (mode === "foreground") {
          this._focusApp(pid);
          this._updateAddressBar(existingProc.currentUri);
        }

        // 再描画等のためにイベントを飛ばす
        if (existingProc.iframe.contentWindow) {
          const evtMsg = {
            protocol: "itera:ipc:v2",
            type: "event",
            id: "resume_" + Date.now(),
            source: "host",
            target: pid,
            action: "route_changed",
            payload: { path, args },
            error: null,
          };
          existingProc.iframe.contentWindow.postMessage(evtMsg, "*");
        }
        return;
      }
    }

    // 新規起動または強制リロード
    this.kill(pid);

    if (mode === "foreground" && this.els.LOADER) {
      this.els.LOADER.classList.remove("hidden");
    }

    try {
      const { entryUrl, blobUrls } = await this.compiler.compile(
        this.vfs,
        path,
        pid,
        args,
      );

      const iframe = document.createElement("iframe");
      iframe.id = `proc-${pid}`;
      iframe.name = pid;
      iframe.sandbox =
        "allow-scripts allow-forms allow-modals allow-popups allow-same-origin";

      if (type === "app") {
        iframe.className =
          "absolute inset-0 w-full h-full border-none bg-app transition-opacity duration-300";
        iframe.style.opacity = "0";
        iframe.style.pointerEvents = "none";
        iframe.style.zIndex = "1";
        if (this.els.APPS_CONTAINER)
          this.els.APPS_CONTAINER.appendChild(iframe);
      } else {
        if (this.els.BG_CONTAINER) this.els.BG_CONTAINER.appendChild(iframe);
      }

      this.processes.set(pid, {
        pid,
        path,
        mode,
        type,
        state: type === "app" ? "background" : "running",
        iframe,
        blobUrls,
        lastActiveTime: Date.now(),
        args,
        currentUri: uri,
      });

      if (type === "app") this._enforceLRU();

      if (entryUrl) {
        await this._loadIframe(iframe, entryUrl);
      } else if (type === "app") {
        iframe.srcdoc = `<div style="color:#888; padding:20px; font-family:sans-serif;">No ${path} found.</div>`;
      }

      if (mode === "foreground") {
        this._focusApp(pid);
        this._updateAddressBar(uri);
      }

      console.log(
        `[ProcessManager] Spawned [${pid}] (Type:${type}, Mode:${mode}) -> ${path}`,
      );
    } catch (e) {
      console.error(`[ProcessManager] Spawn error (${pid}):`, e);
      if (type === "app" && window.AppUI) {
        window.AppUI.notify(`Failed to launch ${path}`, "error");
      }
    } finally {
      if (mode === "foreground" && this.els.LOADER) {
        setTimeout(() => {
          this.els.LOADER!.classList.add("hidden");
        }, 200);
      }
    }
  }

  private _focusApp(targetPid: string): void {
    const targetProc = this.processes.get(targetPid);
    if (!targetProc || targetProc.type !== "app") return;

    for (const [pid, proc] of this.processes.entries()) {
      if (
        proc.type === "app" &&
        proc.state === "foreground" &&
        pid !== targetPid
      ) {
        proc.state = "background";
        proc.iframe.style.opacity = "0";
        proc.iframe.style.pointerEvents = "none";
        proc.iframe.style.zIndex = "1";
      }
    }

    targetProc.state = "foreground";
    targetProc.lastActiveTime = Date.now();
    targetProc.iframe.style.opacity = "1";
    targetProc.iframe.style.pointerEvents = "auto";
    targetProc.iframe.style.zIndex = "10";
  }

  private _enforceLRU(): void {
    const apps = Array.from(this.processes.values()).filter(
      (p) => p.type === "app",
    );
    if (apps.length > this.MAX_APPS) {
      const bgApps = apps.filter((p) => p.state === "background");
      if (bgApps.length > 0) {
        bgApps.sort((a, b) => a.lastActiveTime - b.lastActiveTime);
        const oldest = bgApps[0];
        console.log(
          `[ProcessManager] LRU limit reached. Killing oldest app: ${oldest.pid}`,
        );
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

    if (this.events["process_killed"]) {
      this.events["process_killed"](pid);
    }

    if (proc.state === "foreground") {
      const apps = Array.from(this.processes.values()).filter(
        (p) => p.type === "app",
      );
      if (apps.length > 0) {
        apps.sort((a, b) => b.lastActiveTime - a.lastActiveTime);
        this._focusApp(apps[0].pid);
        this._updateAddressBar(apps[0].currentUri);
      } else {
        this._updateAddressBar("metaos://run/index.html");
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

  broadcast(eventName: string, payload: any): void {
    for (const proc of this.processes.values()) {
      if (proc.iframe && proc.iframe.contentWindow) {
        const msg = {
          protocol: "itera:ipc:v2",
          type: "event",
          id: "bcast_" + Date.now(),
          source: "host",
          target: proc.pid,
          action: eventName,
          payload: payload,
          error: null,
        };
        proc.iframe.contentWindow.postMessage(msg, "*");
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

  async captureScreenshot(pid?: string): Promise<string> {
    let targetPid = pid;
    if (!targetPid) {
      const fg = Array.from(this.processes.values()).find(
        (p) => p.state === "foreground",
      );
      if (fg) targetPid = fg.pid;
    }

    if (!targetPid) throw new Error("No foreground process to capture.");

    const proc = this.processes.get(targetPid);
    if (!proc || !proc.iframe || !proc.iframe.contentWindow) {
      throw new Error(`Process ${targetPid} not found or has no iframe.`);
    }

    return new Promise((resolve, reject) => {
      const iframe = proc.iframe;
      const handler = (e: MessageEvent) => {
        if (e.data.type === "SCREENSHOT_RESULT" && e.data.pid === targetPid) {
          window.removeEventListener("message", handler);
          const parts = e.data.data.split(",");
          resolve(parts.length > 1 ? parts[1] : parts[0]);
        } else if (
          e.data.type === "SCREENSHOT_ERROR" &&
          e.data.pid === targetPid
        ) {
          window.removeEventListener("message", handler);
          reject(new Error(e.data.message));
        }
      };

      window.addEventListener("message", handler);

      setTimeout(() => {
        window.removeEventListener("message", handler);
        reject(new Error("Screenshot timeout"));
      }, 15000);

      iframe.contentWindow!.postMessage({ action: "CAPTURE" }, "*");
    });
  }

  private async _loadIframe(
    iframe: HTMLIFrameElement,
    url: string,
  ): Promise<void> {
    return new Promise((resolve) => {
      let timeoutId: ReturnType<typeof setTimeout>;
      const handler = () => {
        clearTimeout(timeoutId);
        iframe.removeEventListener("load", handler);
        resolve();
      };
      iframe.addEventListener("load", handler);
      iframe.src = url;

      timeoutId = setTimeout(() => {
        console.warn(`[ProcessManager] Iframe load timeout for URL: ${url}`);
        iframe.removeEventListener("load", handler);
        resolve();
      }, 10000);
    });
  }

  public _updateAddressBar(uri: string): void {
    if (this.els.ADDRESS_BAR) {
      (this.els.ADDRESS_BAR as HTMLInputElement).value = uri;
    }
  }

  async resolveUrl(requestPath: string, pid: string): Promise<string> {
    const proc = this.processes.get(pid);
    if (!proc) throw new Error(`Process [${pid}] not found.`);

    const basePath = proc.path.split(/[?#]/)[0];
    const currentDir = basePath.includes("/")
      ? basePath.substring(0, basePath.lastIndexOf("/"))
      : "";

    let absPath = requestPath;
    if (requestPath.startsWith("./") || requestPath.startsWith("../")) {
      absPath = this._resolveRelativePath(currentDir, requestPath);
    } else if (requestPath.startsWith("/")) {
      absPath = requestPath.substring(1);
    }

    // 解決はシステム権限で行う
    if (!this.vfs.exists(SYSTEM_PRINCIPAL, absPath)) {
      throw new Error(`File not found: ${absPath}`);
    }

    const blob = await this.vfs.readBlob(SYSTEM_PRINCIPAL, absPath);
    const mimeType = this.compiler.getMimeType(absPath);
    const typedBlob = new Blob([blob], { type: mimeType });
    const url = URL.createObjectURL(typedBlob);

    if (!proc.blobUrls) proc.blobUrls = [];
    proc.blobUrls.push(url);

    return url;
  }

  private _resolveRelativePath(baseDir: string, relPath: string): string {
    const stack = baseDir ? baseDir.split("/") : [];
    const parts = relPath.split("/");

    for (const part of parts) {
      if (part === "." || part === "") continue;
      if (part === "..") {
        if (stack.length > 0) stack.pop();
      } else {
        stack.push(part);
      }
    }
    return stack.join("/");
  }
}
