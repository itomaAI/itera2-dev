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
export type ToolArtifact = SpeechArtifact | FilesArtifact;

/** report / ask の本文 */
export interface SpeechArtifact {
  kind: 'speech';
  text: string;
}

/**
 * files が利用者に差し出したファイルの並び（T-0344）。
 * ChatPanel が 1 件ずつ「開く」「ダウンロード」付きで描く。
 * 無いパスも `missing: true` で残す（履歴を読み返したとき、何を出そうとしたかが分かるように）。
 */
export interface FilesArtifact {
  kind: 'files';
  title?: string;
  files: PresentedFile[];
}

export interface PresentedFile {
  path: string;
  name: string;
  kind: 'file' | 'directory';
  size?: number;
  missing?: boolean;
}

/**
 * ツールの結果。
 */
export interface ToolResult {
  log?: string;
  ui?: string;
  media?: MediaRef;
  artifact?: ToolArtifact;
  error?: boolean;
  /**
   * まだ返っていない道具の枠（Engine が束を投げるときに積む）。<tool_output> の status が "pending" になる（T-0924）。
   * 付けるのは枠を作るときだけ。結果で枠を埋めるときは output ごと替わるので消える。
   * 投影のあとに返ったときは残る（送った文を変えない。結果は新しいターンで届く）
   */
  pending?: boolean;
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
