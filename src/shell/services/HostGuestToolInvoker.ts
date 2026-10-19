/**
 * Shell-side implementation of guest tool invocation.
 */

import type { GuestToolInvoker } from '../../core/control/GuestToolInvoker';
import type { ToolParams } from '../../core/types/tools';
import type { HostTransport } from '../../ipc/HostTransport';
import type { ProcessManager } from '../windowing/ProcessManager';
import { RpcRemoteError } from '../../ipc/RpcManager';
import { ToolError } from '../../core/control/ToolError';

export class HostGuestToolInvoker implements GuestToolInvoker {
  private processManager: ProcessManager;
  private transport: HostTransport;

  constructor(processManager: ProcessManager, transport: HostTransport) {
    this.processManager = processManager;
    this.transport = transport;
  }

  async invokeTool(pid: string, name: string, params: ToolParams): Promise<unknown> {
    const proc = this.processManager.processes.get(pid);
    if (!proc || !proc.iframe || !proc.iframe.contentWindow) {
      throw new Error(`Target process '${pid}' is no longer available.`);
    }

    try {
      return await this.transport.invokeGuest(pid, 'execute_tool', { name, params }, proc.iframe.contentWindow);
    } catch (err: unknown) {
      // ゲストの handler が投げた（＝ゲストが返した error）は、その道具の契約上の答えなので ToolError にする。
      // RPC の timeout・transport の失敗はそのまま投げる（ToolRegistry が実装の例外として記録する。T-0677）
      if (err instanceof RpcRemoteError) throw new ToolError(err.message, { cause: err });
      throw err;
    }
  }
}
