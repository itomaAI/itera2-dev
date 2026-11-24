/**
 * src/core/vfs/VfsHandle.ts
 * VFS の取っ手: 「誰として触るか」を焼き込んだ VFS の口（T-0903）。
 *
 * VfsService の口は、どれも最初の引数に主体（Principal）を取る。呼ぶ側が毎回それを書くと、
 * 「誰として」を決める場所が呼び出しの数だけ散らばる（道具は自分で AGENT_PRINCIPAL と書いていた）。
 * 取っ手では、作る側（その個体を知っている者）が 1 度だけ決め、使う側は渡された取っ手を使う。
 *
 * ■ Actor: 誰として
 *   - principal … 何として（役割・アプリ）。ACL が見る。ノードの owner として保存される
 *   - origin    … どの個体が（エンジンの id・プロセスの pid）。揮発する。保存しない
 *   system と user は個体が 1 つずつなので、2 つは一致して見える。エンジンとプロセスでは、
 *   1 つの役割を複数の個体が持つ（ルートとサブのエンジンは同じ agent）。
 *
 * ■ いまの範囲
 *   - 取っ手は origin を持っているだけで、VFS の中へ渡すのは principal だけ。
 *     変更（VfsMutation）に origin を載せ、同期のエコー止めと vfs_events がそれを見るようにするのは後の段
 *   - 口は、道具が使うものだけ。ゲストの口（HostApiRouter）が取っ手に乗るときに残りを足す
 *
 * 引数と戻り値の型は VfsService の同名の口から導く（ここに写しを持たない）。
 */

import { USER_PRINCIPAL, type Principal } from './types';
import type { VfsService } from './VfsService';

export interface Actor {
  /** 何として（ACL が見る。保存される） */
  principal: Principal;
  /** どの個体が（揮発。保存しない） */
  origin: string;
}

/** 利用者（画面の前の人）。個体は 1 つ */
export const USER_ACTOR: Actor = Object.freeze({ principal: USER_PRINCIPAL, origin: 'user' });

/** VfsService の口 K から、先頭の principal を除いた引数 */
type Rest<K extends keyof VfsService> = VfsService[K] extends (principal: Principal, ...rest: infer R) => unknown
  ? R
  : never;

export class VfsHandle {
  private readonly vfs: VfsService;
  readonly actor: Actor;

  constructor(vfs: VfsService, actor: Actor) {
    this.vfs = vfs;
    this.actor = actor;
  }

  exists(...args: Rest<'exists'>) {
    return this.vfs.exists(this.actor.principal, ...args);
  }

  stat(...args: Rest<'stat'>) {
    return this.vfs.stat(this.actor.principal, ...args);
  }

  listFiles(...args: Rest<'listFiles'>) {
    return this.vfs.listFiles(this.actor.principal, ...args);
  }

  getAcl(...args: Rest<'getAcl'>) {
    return this.vfs.getAcl(this.actor.principal, ...args);
  }

  readFile(...args: Rest<'readFile'>) {
    return this.vfs.readFile(this.actor.principal, ...args);
  }

  readBlob(...args: Rest<'readBlob'>) {
    return this.vfs.readBlob(this.actor.principal, ...args);
  }

  updateFile(...args: Rest<'updateFile'>) {
    return this.vfs.updateFile(this.actor.principal, ...args);
  }

  writeFile(...args: Rest<'writeFile'>) {
    return this.vfs.writeFile(this.actor.principal, ...args);
  }

  deleteFile(...args: Rest<'deleteFile'>) {
    return this.vfs.deleteFile(this.actor.principal, ...args);
  }

  restore(...args: Rest<'restore'>) {
    return this.vfs.restore(this.actor.principal, ...args);
  }

  rename(...args: Rest<'rename'>) {
    return this.vfs.rename(this.actor.principal, ...args);
  }

  copyFile(...args: Rest<'copyFile'>) {
    return this.vfs.copyFile(this.actor.principal, ...args);
  }
}
