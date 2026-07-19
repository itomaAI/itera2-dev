/**
 * Capability used by the control layer to invoke a tool exposed by a guest
 * process. Process and transport details remain outside ToolRegistry.
 */

import type { ToolParams } from '../types/tools';

export interface GuestToolInvoker {
  invokeTool(pid: string, name: string, params: ToolParams): Promise<unknown>;
}
