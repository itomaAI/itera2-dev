/**
 * src/core/cognitive/LlmRequest.ts
 * Itera OS v2: LLM に頼む 1 回の生成の、各社に依らない形（中立の要求。T-0804）
 *
 * 層の向きは一方向:  履歴（Projector）→ 中立の要求（ここ）→ 各社の本文（Renderer）→ 送信（Adapter）
 * ここは履歴もエンジンも LPML も知らない。各社の器も知らない。
 */

import type { MediaRef } from '../types/content';
import type { Principal } from '../vfs/types';
import type { VfsService } from '../vfs/VfsService';

/** 発話の主。履歴の語に合わせる（`system` は役割ではなく `LlmRequest.system`） */
export type LlmRole = 'user' | 'model';

export interface LlmTextPart {
  text: string;
}

export interface LlmMediaPart {
  media: MediaRef;
}

export type LlmPart = LlmTextPart | LlmMediaPart;

export interface LlmMessage {
  role: LlmRole;
  parts: LlmPart[];
}

export interface LlmRequest {
  /** システムプロンプト。無ければ送らない */
  system?: string;
  messages: LlmMessage[];
}

export function isTextPart(part: LlmPart): part is LlmTextPart {
  return typeof (part as LlmTextPart).text === 'string';
}

/** 中身が空白だけのメッセージ（部品が無いものも含む）。上流によっては、これを含む要求全体を断る */
export function isBlankMessage(message: LlmMessage): boolean {
  return message.parts.every((part) => isTextPart(part) && part.text.trim() === '');
}

/**
 * 添付を送れなかった理由。
 *
 * - `mime`: この上流が受け取れない種類
 * - `size`: この上流の上限（`limitMB`。VFS 上の実体の大きさで）を超える
 * - `missing`: VFS に実体が無い
 * - `no_credentials`: 送信先へ上げるための鍵が無い（未設定・失効など）
 * - `upload_failed`: 上げることそのものが失敗した
 */
export type MediaFailure =
  { reason: 'mime' } | { reason: 'size'; limitMB: number } | { reason: 'missing' | 'no_credentials' | 'upload_failed' };

/** 各社の本文を作るときに要るもの（要求そのものではなく、作る場の側の事情） */
export interface RenderEnv {
  vfs: VfsService;
  /** 添付を読む権限 */
  principal: Principal;
  signal?: AbortSignal;
  /**
   * 送れなかった添付の代わりに入れる文を返す。**無ければ、送れない添付があった時点で失敗する**（`LlmMediaError`）。
   * どう扱うかは呼び手が決める —— エージェントは「送れなかった」という注記を文脈に入れる（Projector）。
   */
  mediaFallback?: (media: MediaRef, failure: MediaFailure) => string;
}

/** 送れない添付があり、代わりの文も決められていない */
export class LlmMediaError extends Error {
  readonly media: MediaRef;
  readonly failure: MediaFailure;

  constructor(media: MediaRef, failure: MediaFailure) {
    const why =
      failure.reason === 'size' ? `it exceeds the size limit (${failure.limitMB}MB)` : `reason: ${failure.reason}`;
    super(`The file '${media.path}' (${media.mimeType}) cannot be sent to this model: ${why}.`);
    this.name = 'LlmMediaError';
    this.media = media;
    this.failure = failure;
  }
}
