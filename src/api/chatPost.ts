/**
 * src/api/chatPost.ts
 * 会話にターンを置く手順（T-0908）。MetaOS.chat.append と、MetaOS.engine の取っ手の append が同じものを通る ——
 * 違うのは相手の束の決め方だけで、それは呼ぶ側（HostApiRouter・EngineCalls）が決める。
 *
 *   添付は門を通す（T-0672）。文字は呼び手の権限で読み、先頭だけ本文に展開する。読めなければ注記だけ
 *   → 計画（chatApi.ts の buildAppendPlan。純関数）→ 束の口に置く（置く・知らせる・起こす は束の口が 1 つで行う）
 *
 * 添付の実体は写さない。ターンが持つのは呼び手が渡した VFS のパスで、どのエンジンの会話に置いても同じ。
 */

import type { Turn, TurnContent, TurnMeta } from '../core/state/HistoryManager';
import type { VfsService } from '../core/vfs/VfsService';
import type { Principal } from '../core/vfs/types';
import { attachmentPathsOf, buildAppendPlan, resolveAttachments, type ChatAppendRequest } from './chatApi';

/** 呼んだプロセスと、その主体 */
export interface Caller {
  pid: string;
  principal: Principal;
}

/** 束のうち、置く口（EngineBundle が満たす） */
export interface PostTarget {
  post(role: 'user' | 'system', content: TurnContent, meta?: TurnMeta): Promise<Turn>;
}

/**
 * 要求をターン 1 つにして束に置く。受けられない形なら、置かずに理由を付けて断る（`label` は呼んだ口の名前）。
 * 起こすか（wake）と描くか（visible）は計画の meta に入っている。
 */
export async function postToBundle(
  vfs: Pick<VfsService, 'stat' | 'withBlob'>,
  bundle: PostTarget,
  caller: Caller,
  req: ChatAppendRequest,
  label = 'chat.append',
): Promise<{ id: string }> {
  const { principal } = caller;
  const resolved = await resolveAttachments(attachmentPathsOf(req.opts), async (path) => {
    const stat = vfs.stat(principal, path);
    if (stat.kind !== 'file') return null;
    return {
      size: stat.size,
      bytes: () => vfs.withBlob(principal, path, async (blob) => new Uint8Array(await blob.arrayBuffer())),
    };
  });
  const plan = buildAppendPlan(req, caller.pid, resolved);
  if (!plan.ok) throw new Error(`${label}: ${plan.reason}`);
  const turn = await bundle.post(plan.role, plan.content, plan.meta);
  return { id: turn.id };
}
