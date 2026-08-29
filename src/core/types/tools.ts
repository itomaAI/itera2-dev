/**
 * Shared contracts for tool registration, execution, and history projection.
 *
 * These types describe the existing runtime wire format. In particular,
 * optional flags retain their current implicit semantics at each call site.
 */

import type { MediaRef } from './content';

/**
 * ツールがChatPanelに残す成果物。
 *
 * `log` が「LLMへ渡る記録」、`ui` が「ユーザーへ見せる実行ステータス（1行）」であるのに対し、
 * これは「ツールの副作用としてChatPanelに置かれたもの」を表す。
 * create_file がVFSにファイルを残すのと同じ関係で、report はここにメッセージを残す。
 *
 * 【重要】この値はLLMのコンテキストへ投影されない。
 * serializeToolOutput() は log と params しか読まず、buildToolPromptNodes() の
 * shouldEmit も log/media のみを見るため、追加のガードは不要である。
 * report 本文は modelターンの生出力に既に含まれており、二重に入れてはならない。
 */
export interface ToolArtifact {
  kind: 'speech';
  text: string;
}

/**
 * 起床の速さ。'fast' を名乗った結果（ターン）は短いデバウンスで LLM を起こす。
 * 既定（未指定）は通常の待ち。どのツールを特別扱いするかを Engine に固定で書かない
 * （各ツールが自分で名乗る）。
 */
export type WakeMode = 'fast' | 'normal';

export interface ToolResult {
  log?: string;
  ui?: string;
  media?: MediaRef;
  artifact?: ToolArtifact;
  error?: boolean;
  trigger_llm?: boolean;
  halt_loop?: boolean;
  wake?: WakeMode;
}

export type ToolParams = Record<string, string>;

export interface ToolExecutionEntry {
  actionType?: string;
  originalIndex?: number;
  params?: ToolParams;
  output: ToolResult;
}
