/**
 * src/shell/windowing/processGate.ts
 * プロセスの関所の規則（T-0912）—— 「誰が」動かすのかと、動かしてよいかの判定。純関数。
 *
 * プロセスに触る口は 4 つの動詞に分かれる（口そのものは ProcessManager が持つ）:
 *   動かす   … 起こす・名指しで再開／起こし直す・終わらせる・中でコードを走らせる。「誰が」を受け取り、ここの規則で判定する
 *   見る     … 一覧・画面写真。判定しない（全部見える）
 *   頼む     … 道具の呼び出し・同期プロバイダへの要求。関所は通すだけ（頼めるかを知っているのは、道具の台帳とマウントの表）
 *   知らせる … 告知。通すだけ
 *
 * ■ 誰が（Mover）
 *   os     … OS 自身（自動起動・窓の押し出し・エンジンを畳む・全停止）
 *   user   … 画面の前の人の操作（アドレスバー・タスク切り替え・プロセスモニタ・ボタン）
 *   engine … エンジンとして。AI の道具と、そのエンジンに仕えるゲストのプロセス（`via` は、そのプロセスの pid。
 *            記録のための欄で、判定には使わない）
 *
 * ■ 規則（これ 1 つ）
 *   OS と利用者は全部。ルートのエンジンは全部。ほかのエンジンは、自分に仕えるプロセスだけ。
 *
 * VFS の「誰として」（core/vfs/VfsHandle.ts の Actor）とは別の語にしてある —— あちらは主体（ACL）と個体の印、
 * こちらはプロセスを動かす者。
 */

import { ROOT_ENGINE_ID } from '../../core/control/Engine';

export type Mover =
  | { readonly kind: 'os' }
  | { readonly kind: 'user' }
  | { readonly kind: 'engine'; readonly engine: string; readonly via?: string };

export const OS_MOVER: Mover = Object.freeze({ kind: 'os' });
export const USER_MOVER: Mover = Object.freeze({ kind: 'user' });

/** エンジンとして。`via` は、そのエンジンに仕えるゲストのプロセスが頼んだとき、そのプロセスの pid */
export function engineMover(engine: string, via?: string): Mover {
  return via === undefined ? { kind: 'engine', engine } : { kind: 'engine', engine, via };
}

/** 記録（process_events）に書く形: 誰が動かしたか。エンジンなら、その id と、頼んだゲストのプロセス（居れば） */
export function describeMover(mover: Mover): { by: Mover['kind']; byEngine?: string; via?: string } {
  if (mover.kind !== 'engine') return { by: mover.kind };
  return { by: 'engine', byEngine: mover.engine, ...(mover.via === undefined ? {} : { via: mover.via }) };
}

/** 動かしてよいか。`target` はプロセスの記録のうち、仕えるエンジン */
export function canMove(mover: Mover, target: { engine: string }): boolean {
  if (mover.kind !== 'engine') return true;
  return mover.engine === ROOT_ENGINE_ID || target.engine === mover.engine;
}

/** 動かすのを断った（相手は、ほかのエンジンに仕えている）。断る前に投げるので、何も変わっていない */
export class ProcessRefusedError extends Error {
  constructor(target: { pid: string; engine: string }, what: string) {
    super(`Process "${target.pid}" serves another engine ("${target.engine}"). This engine cannot ${what} it.`);
    this.name = 'ProcessRefusedError';
  }
}
