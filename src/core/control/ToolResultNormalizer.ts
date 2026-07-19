/**
 * Normalizes dynamic guest-tool return values into the existing ToolResult
 * wire format used by Engine and History.
 */

import type { ToolResult } from '../types/tools';

export function normalizeDynamicToolResult(value: unknown, toolName: string): ToolResult {
  if (typeof value !== 'object' || value === null) {
    return {
      log: String(value),
      ui: `⚙️ ${toolName}`,
    };
  }

  const result = value as ToolResult;
  if (result.log === undefined) {
    result.log = JSON.stringify(result);
  }
  if (!result.ui) {
    result.ui = `⚙️ ${toolName}`;
  }

  return result;
}
