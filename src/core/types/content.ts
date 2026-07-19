/**
 * Shared content contracts used by history, tools, UI, and LLM projection.
 *
 * These interfaces describe the persisted/runtime shapes already used by
 * Itera OS. They do not introduce a new storage representation.
 */

export interface MediaRef {
  path: string;
  mimeType: string;
  metadata?: Record<string, unknown>;
}

export interface TextContentNode {
  text: string;
}

export interface MediaContentNode {
  media: MediaRef;
}