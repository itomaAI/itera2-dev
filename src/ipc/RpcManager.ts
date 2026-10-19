/**
 * src/ipc/RpcManager.ts
 * Itera OS v2: RPC Timeout and Promise Management
 */

/**
 * 相手（ゲスト）が「エラー」の返事を返したときの例外（T-0677）。
 * timeout や clearAll の例外（こちらの都合で届かなかった）と区別するためのもの。
 * 受け取る側はこれなら「相手の答え」、それ以外なら「経路の失敗」として扱える。
 */
export class RpcRemoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcRemoteError';
  }
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

export class RpcManager {
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private timeoutMs: number;

  constructor(timeoutMs: number = 150000) {
    this.timeoutMs = timeoutMs;
  }

  waitFor(id: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`RPC Timeout: Request ${id} exceeded ${this.timeoutMs}ms`));
        }
      }, this.timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timeoutId });
    });
  }

  resolve(id: string, result: any, error: string | null = null): void {
    if (this.pendingRequests.has(id)) {
      const { resolve, reject, timeoutId } = this.pendingRequests.get(id)!;
      clearTimeout(timeoutId);
      this.pendingRequests.delete(id);

      if (error) {
        reject(new RpcRemoteError(error));
      } else {
        resolve(result);
      }
    }
  }

  clearAll(): void {
    for (const { reject, timeoutId } of this.pendingRequests.values()) {
      clearTimeout(timeoutId);
      reject(new Error('RPC Manager cleared all pending requests.'));
    }
    this.pendingRequests.clear();
  }
}
