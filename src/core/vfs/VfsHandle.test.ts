/**
 * src/core/vfs/VfsHandle.test.ts
 * VFS の取っ手（T-0903）: 焼き込んだ者として VfsService の同名の口を呼ぶだけ、であること。
 */

import { describe, it, expect } from 'vitest';
import { VfsHandle, USER_ACTOR, actorOf, type Actor } from './VfsHandle';
import { VfsService } from './VfsService';

/* eslint-disable @typescript-eslint/no-explicit-any */
const ACTOR: Actor = { principal: { type: 'agent', id: 'Itera_AI' }, origin: 'root' };
const READS = ['exists', 'stat', 'listFiles', 'getAcl', 'readFile', 'readBlob'] as const;
const WRITES = ['updateFile', 'writeFile', 'deleteFile', 'restore', 'rename', 'copyFile'] as const;

describe('VfsHandle', () => {
  const callThrough = (name: string) => {
    const calls: unknown[][] = [];
    const vfs = {
      [name]: (...args: unknown[]) => {
        calls.push(args);
        return `result of ${name}`;
      },
    };
    const handle = new VfsHandle(vfs as unknown as VfsService, ACTOR);
    const res = (handle as any)[name]('a/b.md', { x: 1 });
    expect(res).toBe(`result of ${name}`);
    return calls;
  };

  it('読む口は、焼き込んだ主体を先頭に付けて VfsService の同名の口を呼び、結果をそのまま返す', () => {
    for (const name of READS) expect(callThrough(name)).toEqual([[ACTOR.principal, 'a/b.md', { x: 1 }]]);
  });

  it('書く口は、「誰として」（主体 ＋ 個体の印）をそのまま渡す —— 印は変更に載る', () => {
    for (const name of WRITES) expect(callThrough(name)).toEqual([[ACTOR, 'a/b.md', { x: 1 }]]);
  });

  it('actorOf: 主体だけなら、印は主体の id。Actor はそのまま', () => {
    expect(actorOf({ type: 'user', id: 'local_user' })).toEqual({
      principal: { type: 'user', id: 'local_user' },
      origin: 'local_user',
    });
    expect(actorOf(ACTOR)).toBe(ACTOR);
  });

  it('VfsService.as は、その者の取っ手を返す', () => {
    const vfs: any = Object.create(VfsService.prototype);
    const seen: unknown[] = [];
    vfs.exists = (principal: unknown, path: string) => {
      seen.push(principal, path);
      return true;
    };
    const handle = vfs.as(USER_ACTOR);
    expect(handle).toBeInstanceOf(VfsHandle);
    expect(handle.actor).toBe(USER_ACTOR);
    expect(handle.exists('x')).toBe(true);
    expect(seen).toEqual([USER_ACTOR.principal, 'x']);
  });

  it('利用者の取っ手は、利用者の主体と個体の印を持つ', () => {
    expect(USER_ACTOR).toEqual({ principal: { type: 'user', id: 'local_user' }, origin: 'local_user' });
  });
});
