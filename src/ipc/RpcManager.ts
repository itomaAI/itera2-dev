/**
 * src/ipc/RpcManager.ts
 * Itera OS v2: RPC Timeout and Promise Management
 */

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
          reject(
            new Error(
              `RPC Timeout: Request ${id} exceeded ${this.timeoutMs}ms`,
            ),
          );
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
        reject(new Error(error));
      } else {
        resolve(result);
      }
    }
  }

  clearAll(): void {
    for (const { reject, timeoutId } of this.pendingRequests.values()) {
      clearTimeout(timeoutId);
      reject(new Error("RPC Manager cleared all pending requests."));
    }
    this.pendingRequests.clear();
  }
}
