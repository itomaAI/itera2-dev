/**
 * Minimal serializer for LPML fragments emitted into model context.
 *
 * Output formatting intentionally matches the existing Projector behavior.
 */

import type { ToolExecutionEntry } from '../types/tools';

export function wrapUserInput(text: string): string {
  return `<user_input>\n${text}\n</user_input>`;
}

export function serializeToolOutput(entry: ToolExecutionEntry): string {
  const actionName = entry.actionType || 'unknown';
  const status = entry.output.error ? 'error' : 'success';
  let attrStr = `action="${actionName}" status="${status}"`;

  if (entry.params) {
    for (const [key, value] of Object.entries(entry.params)) {
      attrStr += ` ${key}="${String(value).replace(/"/g, '&quot;')}"`;
    }
  }

  const logContent = entry.output.log ? entry.output.log.trim() : '';
  return logContent ? `<tool_output ${attrStr}>\n${logContent}\n</tool_output>` : `<tool_output ${attrStr} />`;
}