/**
 * Shared contracts for tool registration, execution, and history projection.
 *
 * These types describe the existing runtime wire format. In particular,
 * optional flags retain their current implicit semantics at each call site.
 */

import type { MediaRef } from './content';

export interface ToolResult {
  log?: string;
  ui?: string;
  media?: MediaRef;
  error?: boolean;
  trigger_llm?: boolean;
  halt_loop?: boolean;
}

export type ToolParams = Record<string, string>;

export interface ToolExecutionEntry {
  actionType?: string;
  originalIndex?: number;
  params?: ToolParams;
  output: ToolResult;
}