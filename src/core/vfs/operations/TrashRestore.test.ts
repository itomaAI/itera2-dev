import { describe, it, expect, beforeEach } from 'vitest';
import { DeleteFileOp, RenameOp, RestoreOp, uniquePath } from './TransferOps';
import { PathResolver } from '../PathResolver';
import { VfsAuth } from '../VfsAuth';
import { VfsLockManager } from '../VfsLockManager';
import { VfsEventBus } from '../VfsEventBus';
import { USER_PRINCIPAL, type VfsNode } from '../types';
import type { VfsContext } from './BaseOperation';

/**
 * src/core/vfs/operations/TrashRestore.test.ts
 * ゴミ箱に元の場所を控えて「元に戻す」— T-0470
 *
 * 押さえるのは 4 点。
 *  1. 消すと trash/<時刻>_<名前> に移り、meta に deletedAt と trashedFrom（元の完全パス）が付く
 *  2. restore は trashedFrom へ戻し、印（isTrashed / deletedAt / trashedFrom）を外す。親が無ければ作る
 *  3. 同名があれば `名前 (2).拡張子` に避ける（上書きしない）。opts.to で別の先に戻せる
 *  4. 元の場所を知らない古いゴミは、to が無ければ失敗する（黙って捨てない）
 * NodeStore は IndexedDB に依存するので、同じ形のメモリ版で置き換える（索引の作りは NodeStore と同じ）。
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
  /** 試験の準備用: 直接ノードを置く */
  seed(node: VfsNode) {
    this.memoryMap.set(node.id, node);
    this.add(node);
  }
}

let seq = 0;
function makeCtx() {
  const nodeStore = new MemoryNodeStore();
  const pathResolver = new PathResolver(nodeStore as any);
  const auth = new VfsAuth(nodeStore as any);
  const ctx: VfsContext = {
    nodeStore: nodeStore as any,
    contentStore: {} as any,
    pathResolver,
    eventBus: new VfsEventBus(),
    lockManager: new VfsLockManager(),
    auth,
    vfs: { _hydrateIfNeeded: async () => {} } as any,
  };
  const mk = (path: string, kind: 'file' | 'directory') => {
    const parts = path.split('/');
    const name = parts.pop()!;
    const parentPath = parts.join('/');
    const parentId = parentPath ? pathResolver.getIdByPath(parentPath)! : null;
    const node: VfsNode = {
      id: `n${++seq}`,
      name,
      parentId,
      kind,
      flags: { isSystem: false, isTrashed: false },
      meta: { size: kind === 'file' ? 10 : 0, createdAt: 1, updatedAt: 1, version: 1 },
      acl: auth.getDefaultAcl(USER_PRINCIPAL, parentId),
    };
    nodeStore.seed(node);
    return node;
  };
  const nodeAt = (path: string) => {
    const id = pathResolver.getIdByPath(path);
    return id ? nodeStore.getNode(id) : undefined;
  };
  const trashed = () =>
    nodeStore.getChildren(pathResolver.getIdByPath('trash') as string).map((n) => `trash/${n.name}`);
  return { ctx, mk, nodeAt, trashed, pathResolver };
}

describe('ゴミ箱に元の場所を控える（DeleteFileOp）', () => {
  it('消すと trash/<時刻>_<名前> に移り、deletedAt と trashedFrom（元の完全パス）が付く', async () => {
    const h = makeCtx();
    h.mk('個人', 'directory');
    h.mk('個人/資料', 'directory');
    h.mk('個人/資料/図面.pdf', 'file');
    await new DeleteFileOp(h.ctx).execute(USER_PRINCIPAL, { path: '個人/資料/図面.pdf', opts: {} });
    expect(h.nodeAt('個人/資料/図面.pdf')).toBeUndefined();
    const [p] = h.trashed();
    expect(p).toMatch(/^trash\/\d{13}_図面\.pdf$/);
    const node = h.nodeAt(p)!;
    expect(node.flags.isTrashed).toBe(true);
    expect(node.meta.trashedFrom).toBe('個人/資料/図面.pdf');
    expect(String(node.meta.deletedAt)).toBe(p.slice('trash/'.length).split('_')[0]);
  });
});

describe('元に戻す（RestoreOp）', () => {
  let h: ReturnType<typeof makeCtx>;
  beforeEach(async () => {
    h = makeCtx();
    h.mk('個人', 'directory');
    h.mk('個人/資料', 'directory');
    h.mk('個人/資料/図面.pdf', 'file');
    await new DeleteFileOp(h.ctx).execute(USER_PRINCIPAL, { path: '個人/資料/図面.pdf', opts: {} });
  });

  it('trashedFrom へ戻り、印が外れる。戻り値は戻した先', async () => {
    const [p] = h.trashed();
    const dest = await new RestoreOp(h.ctx).execute(USER_PRINCIPAL, { path: p, opts: {} });
    expect(dest).toBe('個人/資料/図面.pdf');
    const node = h.nodeAt('個人/資料/図面.pdf')!;
    expect(node.flags.isTrashed).toBe(false);
    expect(node.meta.deletedAt).toBeUndefined();
    expect(node.meta.trashedFrom).toBeUndefined();
    expect(h.trashed()).toEqual([]);
  });

  it('元のフォルダが消えていても作って戻す', async () => {
    // 資料 フォルダ自体を消す（中に何も無いので単独）
    await new DeleteFileOp(h.ctx).execute(USER_PRINCIPAL, { path: '個人/資料', opts: { permanent: true } });
    expect(h.nodeAt('個人/資料')).toBeUndefined();
    const [p] = h.trashed();
    const dest = await new RestoreOp(h.ctx).execute(USER_PRINCIPAL, { path: p, opts: {} });
    expect(dest).toBe('個人/資料/図面.pdf');
    expect(h.nodeAt('個人/資料')!.kind).toBe('directory');
    expect(h.nodeAt('個人/資料/図面.pdf')!.kind).toBe('file');
  });

  it('同名があれば `名前 (2).拡張子` に避ける（上書きしない）', async () => {
    h.mk('個人/資料/図面.pdf', 'file'); // 消したあとに同じ名前でまた置いた
    const [p] = h.trashed();
    const dest = await new RestoreOp(h.ctx).execute(USER_PRINCIPAL, { path: p, opts: {} });
    expect(dest).toBe('個人/資料/図面 (2).pdf');
    expect(h.nodeAt('個人/資料/図面.pdf')!.meta.size).toBe(10); // 後から置いたほうは触らない
    expect(h.nodeAt('個人/資料/図面 (2).pdf')!.flags.isTrashed).toBe(false);
  });

  it('opts.to で別の先へ戻せる。trash の中へは戻せない', async () => {
    const [p] = h.trashed();
    const dest = await new RestoreOp(h.ctx).execute(USER_PRINCIPAL, {
      path: p,
      opts: { to: '個人/資料/2026-09/図面.pdf' },
    });
    expect(dest).toBe('個人/資料/2026-09/図面.pdf');
    expect(h.nodeAt('個人/資料/2026-09')!.kind).toBe('directory');
    h.mk('個人/資料/メモ.md', 'file');
    await new DeleteFileOp(h.ctx).execute(USER_PRINCIPAL, { path: '個人/資料/メモ.md', opts: {} });
    const [q] = h.trashed();
    await expect(new RestoreOp(h.ctx).execute(USER_PRINCIPAL, { path: q, opts: { to: 'trash/x.md' } })).rejects.toThrow(
      /into trash/,
    );
  });

  it('元の場所を知らない古いゴミは、to が無ければ失敗する（黙って捨てない）。ゴミ箱の外のものも失敗', async () => {
    const [p] = h.trashed();
    delete h.nodeAt(p)!.meta.trashedFrom; // この欄が付く前に消したもの
    await expect(new RestoreOp(h.ctx).execute(USER_PRINCIPAL, { path: p, opts: {} })).rejects.toThrow(
      /Original location unknown/,
    );
    expect(h.trashed()).toEqual([p]);
    const dest = await new RestoreOp(h.ctx).execute(USER_PRINCIPAL, { path: p, opts: { to: '個人/図面.pdf' } });
    expect(dest).toBe('個人/図面.pdf');
    h.mk('個人/資料/a.txt', 'file');
    await expect(new RestoreOp(h.ctx).execute(USER_PRINCIPAL, { path: '個人/資料/a.txt', opts: {} })).rejects.toThrow(
      /Not in trash/,
    );
  });

  it('改名でゴミ箱の外へ出しても印が外れる（RenameOp）', async () => {
    const [p] = h.trashed();
    await new RenameOp(h.ctx).execute(USER_PRINCIPAL, { oldPath: p, newPath: '個人/図面.pdf', opts: {} });
    const node = h.nodeAt('個人/図面.pdf')!;
    expect(node.flags.isTrashed).toBe(false);
    expect(node.meta.trashedFrom).toBeUndefined();
    expect(node.meta.deletedAt).toBeUndefined();
  });
});

describe('uniquePath', () => {
  it('空いていればそのまま。塞がっていれば (2) (3) … を拡張子の前に', () => {
    const taken = new Set(['a/b.txt', 'a/b (2).txt', 'a/c', 'a/.env']);
    const ex = (p: string) => taken.has(p);
    expect(uniquePath('a/x.txt', ex)).toBe('a/x.txt');
    expect(uniquePath('a/b.txt', ex)).toBe('a/b (3).txt');
    expect(uniquePath('a/c', ex)).toBe('a/c (2)');
    expect(uniquePath('a/.env', ex)).toBe('a/.env (2)'); // 先頭の . は拡張子ではない
  });
});
