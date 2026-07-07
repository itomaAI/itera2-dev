/**
 * src/ipc/HostTransport.ts
 * Itera OS v2: Host side postMessage Transport
 */

import { IpcMessage } from "./Message";
import { RpcManager } from "./RpcManager";

export type RequestHandler = (payload: any, sourcePid: string) => Promise<any>;
export type SourceValidator = (pid: string, sourceWindow: Window) => boolean;

export class HostTransport {
  private rpc: RpcManager;
  private handlers: Map<string, RequestHandler>;
  private sourceValidator?: SourceValidator;

  constructor() {
    this.rpc = new RpcManager();
    this.handlers = new Map();
    this._initListener();
  }

  /**
   * 送信元の Window が、申告された PID のものと一致するか検証するバリデーターを設定
   */
  setSourceValidator(validator: SourceValidator): void {
    this.sourceValidator = validator;
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
        let result: any = null;
        let error: string | null = null;

        // セキュリティ: 送信元の厳密な検証
        if (this.sourceValidator && !this.sourceValidator(msg.source, e.source as Window)) {
          error = `[SecurityError] PID spoofing detected or invalid source window for PID: ${msg.source}`;
          console.error(error);
        } else {
          const handler = this.handlers.get(msg.action);
          if (handler) {
            try {
              result = await handler(msg.payload, msg.source);
            } catch (err: any) {
              error = err.message || String(err);
            }
          } else {
            error = `[HostTransport] No handler registered for action: ${msg.action}`;
          }
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
