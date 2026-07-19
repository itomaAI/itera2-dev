/**
 * Provider-neutral traversal of the existing history content format.
 *
 * This module preserves content ordering and LPML wrapping while leaving
 * provider-specific part rendering and media resolution to each Projector.
 */

import type { Turn } from '../state/HistoryManager';
import {
  getMessageContentNodes,
  isMediaContentNode,
  isTextContentNode,
  isToolExecutionEntry,
} from '../state/TurnContentNormalizer';
import type { MediaRef } from '../types/content';
import { serializeToolOutput, wrapUserInput } from './LpmlSerializer';

export interface TextPromptNode {
  kind: 'text';
  text: string;
}

export type PromptContentNode = TextPromptNode | { kind: 'media'; media: MediaRef };

export interface ToolPromptNode {
  shouldEmit: boolean;
  text: string;
  media?: MediaRef;
}

export function buildToolPromptNodes(turn: Turn): ToolPromptNode[] {
  if (turn.meta?.type !== 'tool_execution' || !Array.isArray(turn.content)) return [];

  return turn.content.map((item) => {
    if (!isToolExecutionEntry(item)) {
      return { shouldEmit: false, text: '' };
    }

    const shouldEmit = Boolean(item.output.log || item.output.media);
    return {
      shouldEmit,
      text: shouldEmit ? serializeToolOutput(item) : '',
      media: item.output.media,
    };
  });
}

export function buildUserPromptNodes(turn: Turn): PromptContentNode[] {
  const nodes: PromptContentNode[] = [];
  let textBuffer = '';

  const flushText = () => {
    if (textBuffer.trim()) {
      nodes.push({
        kind: 'text',
        text: wrapUserInput(textBuffer.trim()),
      });
    }
    textBuffer = '';
  };

  for (const item of getMessageContentNodes(turn)) {
    if (isTextContentNode(item) && item.text) {
      if (item.text.trim().startsWith('<')) {
        flushText();
        nodes.push({ kind: 'text', text: item.text });
      } else {
        textBuffer += item.text + '\n';
      }
    } else if (isMediaContentNode(item)) {
      flushText();
      nodes.push({ kind: 'media', media: item.media });
    }
  }

  flushText();
  return nodes;
}

export function buildTextPromptNodes(turn: Turn): TextPromptNode[] {
  return getMessageContentNodes(turn)
    .filter(isTextContentNode)
    .filter((item) => Boolean(item.text))
    .map((item) => ({ kind: 'text' as const, text: item.text }));
}
