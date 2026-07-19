/**
 * Shell-side implementation of guest tool invocation.
 */

import type { GuestToolInvoker } from '../../core/control/GuestToolInvoker';
import type { ToolParams } from '../../core/types/tools';
import type { HostTransport } from '../../ipc/HostTransport';
import type { ProcessManager } from '../windowing/ProcessManager';

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

    return this.transport.invokeGuest(
      pid,
      'execute_tool',
      { name, params },
      proc.iframe.contentWindow,
    );
  }
}