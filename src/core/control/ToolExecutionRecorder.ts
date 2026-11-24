/**
 * Persists tool execution events through the shared SystemLogger.
 *
 * Parameters and results are intentionally recorded without redaction or
 * guest-specific interpretation.
 */

import type { SystemLogger } from '../state/SystemLogger';
import type { ToolParams, ToolResult } from '../types/tools';

export interface ToolExecutionLogEntry {
  tool: string;
  /** 呼んだエンジンの id（ルートは `root`）。道具の持ち主（sourcePid）とは別のこと（T-0903） */
  engine: string;
  kind: 'system' | 'dynamic' | 'unknown';
  toolSetId?: string;
  sourcePid?: string;
  params: ToolParams;
  status: 'success' | 'error';
  startedAt: string;
  completedAt: string;
  durationMs: number;
  result?: ToolResult | null;
  rawResult?: unknown;
  error?: {
    name?: string;
    message: string;
    stack?: string;
    code?: string;
  };
}

export class ToolExecutionRecorder {
  private logger: SystemLogger;

  constructor(logger: SystemLogger) {
    this.logger = logger;
  }

  record(entry: ToolExecutionLogEntry): void {
    void this.logger.log('tool_events', entry).catch((error) => {
      console.error('[ToolExecutionRecorder] Failed to queue tool execution log:', error);
    });
  }
}
