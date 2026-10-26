/**
 * src/core/vfs/VersionedWrite.test.ts
 * 版の照合（楽観ロック。T-0715）
 *
 *   writeFile(…, { ifVersion })  … 錠の中でノードの版と比べ、違えば 1 文字も書かずに ESTALE
 *   readFileWithVersion          … 版は中身を読みに行く「前」に取る（古い中身に新しい版、は作らない）
 *   updateFile(path, fn)         … 読む→fn→ifVersion 付きで書く。ESTALE なら読み直して fn をやり直す
 *
 * 背景: 読む→直す→書く の 3 手に通しの錠が無く、並んだ書き手が最初の中身を読んで最後の 1 つだけが残っていた
 * （T-0714 は道具の層で直列にした応急の手。これはその本直し）。
 */

import { describe, it, expect } from 'vitest';
import { VfsService } from './VfsService';
import { WriteFileOp } from './operations/WriteOps';
import { PathResolver } from './PathResolver';
import { VfsAuth } from './VfsAuth';
import { VfsLockManager } from './VfsLockManager';
import { VfsEventBus } from './VfsEventBus';
import { isVfsError } from './VfsError';
import { USER_PRINCIPAL, type VfsNode } from './types';
import type { VfsContext } from './operations/BaseOperation';

/* eslint-disable @typescript-eslint/no-explicit-any */
class MemoryNodeStore {
  memoryMap = new Map<string, VfsNode>();
  childrenIndex = new Map<string | null, Map<string, string>>();
  getNode(id: string) {
    return this.memoryMap.get(id);
  }
  getChildId(parentId: string | null, name: string) {
    return this.childrenIndex.get(parentId)?.get(name);
  }
  getChildren(parentId: string | null) {
    return [...(this.childrenIndex.get(parentId)?.values() || [])].map((id) => this.memoryMap.get(id)!).filter(Boolean);
  }
  getAllNodes() {
    return this.memoryMap.values();
  }
  getTotalSize() {
    return 0;
  }
  private add(node: VfsNode) {
    if (!this.childrenIndex.has(node.parentId)) this.childrenIndex.set(node.parentId, new Map());
    this.childrenIndex.get(node.parentId)!.set(node.name, node.id);
  }
  private remove(node: VfsNode) {
    this.childrenIndex.get(node.parentId)?.delete(node.name);
  }
  async commitTransaction(puts: VfsNode[], deletes: string[]) {
    for (const id of deletes) {
      const ex = this.memoryMap.get(id);
      if (ex) {
        this.remove(ex);
        this.memoryMap.delete(id);
      }
    }
    for (const node of puts) {
      const ex = this.memoryMap.get(node.id);
      if (ex) this.remove(ex);
      this.memoryMap.set(node.id, node);
      this.add(node);
    }
  }
  seed(node: VfsNode) {
    this.memoryMap.set(node.id, node);
    this.add(node);
  }
}

function makeCtx() {
  const nodeStore = new MemoryNodeStore();
  const pathResolver = new PathResolver(nodeStore as any);
  const auth = new VfsAuth(nodeStore as any);
  const contents = new Map<string, string>();
  let n = 0;
  const contentStore = {
    write: async (_id: string, content: string) => {
      const key = `c${++n}`;
      contents.set(key, content);
      return { backend: 'memory' as const, key };
    },
    readText: async (ref: { key: string }) => contents.get(ref.key) ?? '',
    readBlob: async (ref: { key: string }) => new Blob([contents.get(ref.key) ?? '']),
  };
  const ctx: VfsContext = {
    nodeStore: nodeStore as any,
    contentStore: contentStore as any,
    pathResolver,
    eventBus: new VfsEventBus(),
    lockManager: new VfsLockManager(),
    auth,
    vfs: {} as any,
  };
  const file: VfsNode = {
    id: 'f1',
    name: 'a.md',
    parentId: null,
    kind: 'file',
    flags: { isSystem: false, isTrashed: false },
    meta: { size: 3, createdAt: 1, updatedAt: 1, version: 3, hash: 'h' },
    acl: auth.getDefaultAcl(USER_PRINCIPAL, null),
    contentRef: { backend: 'memory' as any, key: 'c0' },
  };
  contents.set('c0', 'one');
  nodeStore.seed(file);
  const text = () => {
    const node = nodeStore.getNode('f1')!;
    return node.contentRef ? contents.get(node.contentRef.key) : undefined;
  };
  const version = () => nodeStore.getNode('f1')!.meta.version;
  return { ctx, nodeStore, contents, text, version };
}

const write = (ctx: VfsContext, path: string, content: string, opts: any) =>
  new WriteFileOp(ctx).execute(USER_PRINCIPAL, { path, content, opts });

describe('writeFile の ifVersion', () => {
  it('読んだ版と同じなら書けて、版が 1 つ上がる', async () => {
    const { ctx, text, version } = makeCtx();
    await write(ctx, 'a.md', 'two', { overwrite: true, ifVersion: 3 });
    expect(text()).toBe('two');
    expect(version()).toBe(4);
  });

  it('版が違えば ESTALE で、1 文字も書かれず版も動かない', async () => {
    const { ctx, text, version } = makeCtx();
    await write(ctx, 'a.md', 'two', { overwrite: true }); // 誰かが先に書いた → 版 4
    let err: unknown;
    try {
      await write(ctx, 'a.md', 'three', { overwrite: true, ifVersion: 3 });
    } catch (e) {
      err = e;
    }
    expect(isVfsError(err) && err.code === 'ESTALE').toBe(true);
    expect(String((err as Error).message)).toContain('expected version 3');
    expect(text()).toBe('two');
    expect(version()).toBe(4);
  });

  it('ifVersion を渡さなければ今までどおり（比べない）', async () => {
    const { ctx, text, version } = makeCtx();
    await write(ctx, 'a.md', 'two', { overwrite: true });
    await write(ctx, 'a.md', 'three', { overwrite: true });
    expect(text()).toBe('three');
    expect(version()).toBe(5);
  });

  it('ifVersion: 0 は「まだ無いはず」。無ければ作れ、あれば ESTALE', async () => {
    const { ctx, nodeStore } = makeCtx();
    await write(ctx, 'b.md', 'new', { ifVersion: 0 });
    expect(nodeStore.getChildId(null, 'b.md')).toBeDefined();
    let err: unknown;
    try {
      await write(ctx, 'a.md', 'x', { overwrite: true, ifVersion: 0 });
    } catch (e) {
      err = e;
    }
    expect(isVfsError(err) && err.code === 'ESTALE').toBe(true);
  });
});

describe('readFileWithVersion', () => {
  it('中身と版を返す。版は中身を読みに行く前のもの', async () => {
    const { ctx } = makeCtx();
    const svc: any = Object.create(VfsService.prototype);
    svc.nodeStore = ctx.nodeStore;
    svc.pathResolver = ctx.pathResolver;
    svc.auth = ctx.auth;
    // 読みに行っている間に書かれる: 中身は古いまま（c0）、版は 3 のまま返る
    svc.contentStore = {
      readBlob: async (ref: { key: string }) => {
        ctx.nodeStore.getNode('f1')!.meta.version = 99; // 読んでいる最中に誰かが書いた
        return new Blob([ref.key === 'c0' ? 'one' : '?']);
      },
    };
    const r = await (svc as VfsService).readFileWithVersion(USER_PRINCIPAL, 'a.md');
    expect(r).toEqual({ content: 'one', version: 3 });
  });
});

describe('updateFile', () => {
  /** 版を持つ最小の VFS 模型。readFileWithVersion と writeFile(ifVersion) だけ本物の約束を守る */
  function model(initial: string, hooks: { beforeWrite?: (attempt: number) => void } = {}) {
    let content = initial;
    let version = 1;
    let writes = 0;
    const svc: any = Object.create(VfsService.prototype);
    svc.pathResolver = { normalizePath: (p: string) => p };
    svc.readFileWithVersion = async () => ({ content, version });
    svc.writeFile = async (_p: any, _path: string, next: string, opts: any) => {
      writes++;
      hooks.beforeWrite?.(writes);
      if (opts.ifVersion !== version) {
        const { VfsError } = await import('./VfsError');
        throw new VfsError(
          'ESTALE',
          `Stale write: expected version ${opts.ifVersion} but the file is at version ${version}.`,
        );
      }
      content = next;
      version++;
      return 'Overwrote';
    };
    const bump = (c: string) => {
      content = c;
      version++;
    };
    return { svc: svc as VfsService, get: () => ({ content, version, writes }), bump };
  }

  it('誰も割り込まなければ 1 回で書ける', async () => {
    const { svc, get } = model('one');
    const r = await svc.updateFile(USER_PRINCIPAL, 'a.md', (c) => c + '\ntwo');
    expect(r.attempts).toBe(1);
    expect(r.version).toBe(2);
    expect(get().content).toBe('one\ntwo');
  });

  it('割り込まれたら読み直して当て直す（当て直した中身には割り込みの分も入る）', async () => {
    let bumped = false;
    const m = model('one');
    const { svc, get } = m;
    const r = await svc.updateFile(USER_PRINCIPAL, 'a.md', (c) => c + '\nmine');
    expect(r.attempts).toBe(1);
    // 2 回目: 書く直前に誰かが書く → ESTALE → 読み直し → 2 回目で入る
    const m2 = model('one', {
      beforeWrite: () => {
        if (!bumped) {
          bumped = true;
          m2.bump('one\ntheirs');
        }
      },
    });
    const r2 = await m2.svc.updateFile(USER_PRINCIPAL, 'a.md', (c) => c + '\nmine');
    expect(r2.attempts).toBe(2);
    expect(m2.get().content).toBe('one\ntheirs\nmine');
    expect(get().content).toBe('one\nmine');
  });

  it('updater が null を返したら書かない', async () => {
    const { svc, get } = model('one');
    const r = await svc.updateFile(USER_PRINCIPAL, 'a.md', () => null);
    expect(r.message).toContain('Unchanged');
    expect(get().writes).toBe(0);
  });

  it('updater の例外はそのまま出る（書かない）', async () => {
    const { svc, get } = model('one');
    await expect(svc.updateFile(USER_PRINCIPAL, 'a.md', () => Promise.reject(new Error('no match')))).rejects.toThrow(
      'no match',
    );
    expect(get().writes).toBe(0);
  });

  it('上限まで割り込まれ続けたら最後の ESTALE を投げる', async () => {
    const m = model('x', { beforeWrite: () => m.bump('y') });
    let err: unknown;
    try {
      await m.svc.updateFile(USER_PRINCIPAL, 'a.md', (c) => c + '!', { maxAttempts: 3 });
    } catch (e) {
      err = e;
    }
    expect(isVfsError(err) && err.code === 'ESTALE').toBe(true);
    expect(m.get().writes).toBe(3);
  });
});
