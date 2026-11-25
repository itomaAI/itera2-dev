/**
 * Shell-side implementation of guest tool invocation.
 */

import type { GuestToolInvoker } from '../../core/control/GuestToolInvoker';
import type { ToolParams } from '../../core/types/tools';
import { RpcRemoteError } from '../../ipc/RpcManager';
import { ToolError } from '../../core/control/ToolError';

/**
 * 道具を持つプロセスへ頼む道（ProcessManager が満たす）。
 * ここでは「誰が呼んだか」を見ない —— 呼べるかどうかは道具の台帳が決めていて、関所は通すだけ（T-0912）
 */
export interface ToolHostProcesses {
  isReachable(pid: string): boolean;
  request(pid: string, action: string, payload: unknown): Promise<unknown>;
}

export class HostGuestToolInvoker implements GuestToolInvoker {
  private processes: ToolHostProcesses;

  constructor(processes: ToolHostProcesses) {
    this.processes = processes;
  }

  async invokeTool(pid: string, name: string, params: ToolParams): Promise<unknown> {
    if (!this.processes.isReachable(pid)) {
      throw new Error(`Target process '${pid}' is no longer available.`);
    }

    try {
      return await this.processes.request(pid, 'execute_tool', { name, params });
    } catch (err: unknown) {
      // ゲストの handler が投げた（＝ゲストが返した error）は、その道具の契約上の答えなので ToolError にする。
      // RPC の timeout・transport の失敗はそのまま投げる（ToolRegistry が実装の例外として記録する。T-0677）
      if (err instanceof RpcRemoteError) throw new ToolError(err.message, { cause: err });
      throw err;
    }
  }
}
