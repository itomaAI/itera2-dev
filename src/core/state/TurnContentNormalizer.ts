/**
 * Read-only helpers for interpreting the existing Turn.content wire format.
 *
 * These functions do not mutate turns or introduce a new persisted shape.
 */

import type { MediaContentNode, MediaRef, TextContentNode } from '../types/content';
import type { ToolExecutionEntry, ToolResult } from '../types/tools';
import type { Turn } from './HistoryManager';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

export function isMediaRef(value: unknown): value is MediaRef {
  return isRecord(value) && typeof value.path === 'string' && typeof value.mimeType === 'string';
}

export function isTextContentNode(value: unknown): value is TextContentNode {
  return isRecord(value) && typeof value.text === 'string';
}

export function isMediaContentNode(value: unknown): value is MediaContentNode {
  return isRecord(value) && isMediaRef(value.media);
}

export function isToolResult(value: unknown): value is ToolResult {
  return isRecord(value);
}

export function isToolExecutionEntry(value: unknown): value is ToolExecutionEntry {
  return (
    isRecord(value) &&
    (value.actionType === undefined || typeof value.actionType === 'string') &&
    isToolResult(value.output)
  );
}

export function getMessageContentNodes(turn: Turn): Array<TextContentNode | MediaContentNode> {
  if (!Array.isArray(turn.content)) return [];

  return turn.content.filter(
    (node): node is TextContentNode | MediaContentNode =>
      isTextContentNode(node) || (!isTextContentNode(node) && isMediaContentNode(node)),
  );
}
