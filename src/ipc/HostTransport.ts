/**
 * src/ipc/HostTransport.ts
 * Itera OS v2: Host side postMessage Transport
 */

import { IpcMessage } from "./Message";
import { RpcManager } from "./RpcManager";

export type RequestHandler = (payload: any, sourcePid: string) => Promise<any>;

export class HostTransport {
  private rpc: RpcManager;
  private handlers: Map<string, RequestHandler>;

  constructor() {
    this.rpc = new RpcManager();
    this.handlers = new Map();
    this._initListener();
  }

  /**
   * Guestからのリクエストを処理するハンドラを登録する
   */
  registerHandler(action: string, handler: RequestHandler): void {
    this.handlers.set(action, handler);
  }

  /**
   * Guestへリクエストを送信し、結果を待機する（逆方向RPC）
   */
  async invokeGuest(
    pid: string,
    action: string,
    payload: any,
    targetWindow: Window,
  ): Promise<any> {
    if (!targetWindow) {
      throw new Error(
        `[HostTransport] Target window for PID '${pid}' is missing.`,
      );
    }

    const req = IpcMessage.createRequest("host", pid, action, payload);
    const promise = this.rpc.waitFor(req.id);

    // サンドボックス内のiframeに向けて送信
    targetWindow.postMessage(req, "*");

    return promise;
  }

  /**
   * Guestへ一方通行のイベントを送信する（ブロードキャスト等）
   */
  sendEvent(
    pid: string,
    action: string,
    payload: any,
    targetWindow: Window,
  ): void {
    if (!targetWindow) return;
    const evt = IpcMessage.createEvent("host", pid, action, payload);
    targetWindow.postMessage(evt, "*");
  }

  private _initListener(): void {
    window.addEventListener("message", async (e: MessageEvent) => {
      const msg = e.data;

      if (!IpcMessage.isValid(msg)) return;

      // Host宛てのメッセージ以外は無視
      if (msg.target !== "host") return;

      if (msg.type === "req") {
        // Guestからのリクエスト処理
        const handler = this.handlers.get(msg.action);
        let result: any = null;
        let error: string | null = null;

        if (handler) {
          try {
            result = await handler(msg.payload, msg.source);
          } catch (err: any) {
            error = err.message || String(err);
          }
        } else {
          error = `[HostTransport] No handler registered for action: ${msg.action}`;
        }

        // レスポンスの返送
        const res = IpcMessage.createResponse(msg, result, error);
        if (e.source && typeof (e.source as any).postMessage === "function") {
          (e.source as Window).postMessage(res, "*");
        }
      } else if (msg.type === "res") {
        // Guestからのレスポンス受け取り（待機中のPromiseを解決）
        this.rpc.resolve(msg.id, msg.payload, msg.error);
      }
    });
  }
}
