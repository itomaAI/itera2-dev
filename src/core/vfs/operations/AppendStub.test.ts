import { describe, it, expect } from 'vitest';
import { AppendFileOp } from './WriteOps';
import { PathResolver } from '../PathResolver';
import { VfsAuth } from '../VfsAuth';
import { VfsLockManager } from '../VfsLockManager';
import { VfsEventBus } from '../VfsEventBus';
import { USER_PRINCIPAL, type VfsNode } from '../types';
import type { VfsContext } from './BaseOperation';

/**
 * src/core/vfs/operations/AppendStub.test.ts
 * 追記は元の中身に依存する — stub なら先に実体化する（T-0689）
 *
 * 以前は contentRef の有無だけを見ていたので、stub（contentRef 無し・中身は向こう側）に追記すると
 * 「空に追記した結果」が置かれ、次の同期で向こうの中身がそれで上書きされた。
 */
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

function makeCtx(opts: { remote: string | null }) {
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
    readText: async (ref: { backend: string; key: string }) => contents.get(ref.key) ?? '',
  };
  const fetched: string[] = [];
  // 実物の readBlob と同じ結果だけを写す: プロバイダが中身を置き、stub の印が外れる。取れなければ投げる
  const vfs = {
    readBlob: async (_p: any, path: string) => {
      fetched.push(path);
      if (opts.remote === null) throw new Error(`Failed to fetch missing content for ${path}`);
      const id = pathResolver.getIdByPath(path)!;
      const node = nodeStore.getNode(id)!;
      const ref = await contentStore.write(id, opts.remote);
      nodeStore.seed({
        ...node,
        contentRef: ref,
        meta: { ...node.meta, size: opts.remote.length, syncState: undefined },
      });
      return new Blob([opts.remote]);
    },
  };
  const ctx: VfsContext = {
    nodeStore: nodeStore as any,
    contentStore: contentStore as any,
    pathResolver,
    eventBus: new VfsEventBus(),
    lockManager: new VfsLockManager(),
    auth,
    vfs: vfs as any,
  };
  const stub: VfsNode = {
    id: 'f1',
    name: 'notes.md',
    parentId: null,
    kind: 'file',
    flags: { isSystem: false, isTrashed: false },
    meta: { size: 20, createdAt: 1, updatedAt: 1, version: 1, hash: 'h', syncState: 'stub' },
    acl: auth.getDefaultAcl(USER_PRINCIPAL, null),
  };
  nodeStore.seed(stub);
  const text = async () => {
    const node = nodeStore.getNode('f1')!;
    return node.contentRef ? contents.get(node.contentRef.key) : undefined;
  };
  return { ctx, fetched, text, nodeStore };
}

describe('AppendFileOp: stub への追記', () => {
  it('先に実体化してから追記する（本命・空に追記して向こうを潰さない）', async () => {
    const { ctx, fetched, text, nodeStore } = makeCtx({ remote: 'line1\nline2' });
    await new AppendFileOp(ctx).execute(USER_PRINCIPAL, { path: 'notes.md', content: 'line3', opts: {} });
    expect(fetched).toEqual(['notes.md']);
    expect(await text()).toBe('line1\nline2\nline3');
    expect(nodeStore.getNode('f1')!.meta.syncState).toBeUndefined();
  });

  it('実体化できなければ追記しない（stub のまま・中身は置かれない）', async () => {
    const { ctx, text, nodeStore } = makeCtx({ remote: null });
    await expect(
      new AppendFileOp(ctx).execute(USER_PRINCIPAL, { path: 'notes.md', content: 'line3', opts: {} }),
    ).rejects.toThrow(/Failed to fetch/);
    expect(await text()).toBeUndefined();
    expect(nodeStore.getNode('f1')!.meta.syncState).toBe('stub');
  });

  it('実体のあるファイルは取りに行かない', async () => {
    const { ctx, fetched, nodeStore, text } = makeCtx({ remote: 'unused' });
    const node = nodeStore.getNode('f1')!;
    const ref = await (ctx.contentStore as any).write('f1', 'a');
    nodeStore.seed({ ...node, contentRef: ref as any, meta: { ...node.meta, syncState: undefined } });
    await new AppendFileOp(ctx).execute(USER_PRINCIPAL, { path: 'notes.md', content: 'b', opts: {} });
    expect(fetched).toEqual([]);
    expect(await text()).toBe('a\nb');
  });
});
