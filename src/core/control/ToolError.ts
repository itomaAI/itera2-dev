/**
 * src/core/control/ToolError.ts
 * ツールの「期待される失敗」の印（T-0677）。
 *
 * ツールの実行が失敗する理由には 2 種類ある。
 *   - 期待される失敗: SEARCH が一致しない・ファイルが無い・属性が足りない … ツールの契約上の答え。
 *     呼んだ側（AI）の入力で決まり、結果の `{ error: true }` と tool_events に残れば足りる
 *   - 実装の例外: TypeError・OPFS の I/O 失敗・配線の欠け … OS の不具合。コンソールに赤で出て人の目に触れるべきもの
 * ToolRegistry はこの 2 つを「ToolError かどうか」だけで見分ける。ツールは前者を ToolError で投げる。
 * VFS の拒否（VfsError）は、ツールから見れば前者なので、ここで ToolError に包む（判定はこの 1 か所）。
 */

import { isVfsError } from '../vfs/VfsError';

export class ToolError extends Error {
  /** 何の失敗か。VFS の拒否を包んだときはその code（ENOENT など）が入る */
  readonly code?: string;

  constructor(message: string, opts?: { cause?: unknown; code?: string }) {
    super(message);
    this.name = 'ToolError';
    if (opts?.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
    if (opts?.code) this.code = opts.code;
  }
}

/** instanceof は realm や束ね方で外れることがあるので、name でも見る */
export function isToolError(err: unknown): err is ToolError {
  return err instanceof ToolError || (typeof err === 'object' && err !== null && (err as Error).name === 'ToolError');
}

/**
 * ツールの中から投げられたものを、ToolRegistry が見る形に揃える。
 *   ToolError … そのまま
 *   VfsError … ToolError に包む（message はそのまま。元は cause に残す）
 *   それ以外 … そのまま（実装の例外として扱われる）
 */
export function asToolFailure(err: unknown): unknown {
  if (isToolError(err)) return err;
  if (isVfsError(err)) return new ToolError(err.message, { cause: err, code: err.code });
  return err;
}
