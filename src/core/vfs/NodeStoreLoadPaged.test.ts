import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NodeStore, LOAD_PAGE_SIZE } from './NodeStore';

/**
 * src/core/vfs/NodeStoreLoadPaged.test.ts
 * 起動時の読み込みを件数で区切る — T-0829
 *
 * 1 回の getAll() で全ノードを受け取ると、合計が IndexedDB の 1 回の応答の上限を超えた VFS は起動できない
 * （2026-11-12、同期先 143,800 ファイル）。押さえるのは:
 *  1. 1 回の getAll が受け取るのは LOAD_PAGE_SIZE 件まで（件数を必ず渡す）
 *  2. 区切りの境目（0 件・ちょうど・越え）でも全部を 1 度ずつ読む
 *  3. 途中で失敗したら reject し、メモリは前の状態のまま
 */

type Row = { id: string; parentId: string | null; name: string; kind: 'file' | 'directory'; meta: any };
type Call = { after: string | undefined; lowerOpen: boolean | undefined; count: number | undefined; returned: number };

function node(id: string, parentId: string | null, size = 1): Row {
  return {
    id,
    parentId,
    name: `name-${id}`,
    kind: 'file',
    meta: { size, createdAt: 0, updatedAt: 0, version: 1 },
  } as any;
}

/** 主キー（id）の順に返す偽の IndexedDB。getAll(range, count) の range は lowerBound だけを解する */
function fakeIndexedDb(state: { records: Row[]; failAt?: number }) {
  const calls: Call[] = [];
  const db: any = {
    objectStoreNames: { contains: () => true },
    close() {},
    transaction() {
      const tx: any = { error: null };
      tx.objectStore = () => ({
        getAll(range: any, count?: number) {
          const req: any = {};
          const callNo = calls.length;
          const sorted = [...state.records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          let rows = range
            ? sorted.filter((r) => (range.lowerOpen ? r.id > range.lower : r.id >= range.lower))
            : sorted;
          if (count !== undefined && count > 0) rows = rows.slice(0, count);
          calls.push({ after: range?.lower, lowerOpen: range?.lowerOpen, count, returned: rows.length });
          setTimeout(() => {
            if (state.failAt === callNo) {
              req.error = new Error('boom');
              req.onerror && req.onerror();
            } else {
              req.result = rows.map((r) => ({ ...r }));
              req.onsuccess && req.onsuccess();
            }
          }, 0);
          return req;
        },
      });
      return tx;
    },
  };
  const idb = {
    open() {
      const req: any = {};
      setTimeout(() => req.onsuccess && req.onsuccess({ target: { result: db } }), 0);
      return req;
    },
  };
  return { idb, calls };
}

/** 入れる順を主キーの順と変えておく（読む側が順に頼っていないことも見る） */
function manyNodes(n: number): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < n; i++) rows.push(node(`n${String(i).padStart(6, '0')}`, 'root', 2));
  return rows.reverse();
}

describe('NodeStore.loadAll — 件数で区切って読む', () => {
  const originalIdb = (globalThis as any).indexedDB;
  const originalRange = (globalThis as any).IDBKeyRange;
  beforeEach(() => {
    (globalThis as any).IDBKeyRange = {
      lowerBound: (lower: unknown, lowerOpen = false) => ({ lower, lowerOpen }),
    };
  });
  afterEach(() => {
    (globalThis as any).indexedDB = originalIdb;
    (globalThis as any).IDBKeyRange = originalRange;
  });

  function boot(state: { records: Row[]; failAt?: number }) {
    const f = fakeIndexedDb(state);
    (globalThis as any).indexedDB = f.idb;
    return { store: new NodeStore(), calls: f.calls };
  }

  it('空の VFS: 1 回読んで 0 件', async () => {
    const { store, calls } = boot({ records: [] });
    await store.loadAll();
    expect(Array.from(store.getAllNodes())).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].count).toBe(LOAD_PAGE_SIZE);
  });

  it('区切りを越える数: 1 回の応答は LOAD_PAGE_SIZE 件までで、全部を 1 度ずつ読む', async () => {
    const n = LOAD_PAGE_SIZE * 2 + 7;
    const { store, calls } = boot({ records: manyNodes(n) });
    await store.loadAll();

    const ids = Array.from(store.getAllNodes()).map((x) => x.id);
    expect(ids).toHaveLength(n);
    expect(new Set(ids).size).toBe(n);
    expect(Math.max(...calls.map((c) => c.returned))).toBeLessThanOrEqual(LOAD_PAGE_SIZE);
    expect(calls.map((c) => c.returned)).toEqual([LOAD_PAGE_SIZE, LOAD_PAGE_SIZE, 7]);
    expect(calls.every((c) => c.count === LOAD_PAGE_SIZE)).toBe(true);

    // 2 回目以降は、前の区切りの最後の主キーの「次」から
    expect(calls[0].after).toBeUndefined();
    expect(calls[1]).toMatchObject({ after: `n${String(LOAD_PAGE_SIZE - 1).padStart(6, '0')}`, lowerOpen: true });

    // インデックスと合計も全部のノードから作られる
    expect(store.getChildren('root')).toHaveLength(n);
    expect(store.getTotalSize()).toBe(n * 2);
  });

  it('ちょうど区切りの倍数: 最後に空の 1 回で止まる', async () => {
    const n = LOAD_PAGE_SIZE * 2;
    const { store, calls } = boot({ records: manyNodes(n) });
    await store.loadAll();
    expect(Array.from(store.getAllNodes())).toHaveLength(n);
    expect(calls.map((c) => c.returned)).toEqual([LOAD_PAGE_SIZE, LOAD_PAGE_SIZE, 0]);
  });

  it('途中の区切りで失敗したら reject し、メモリは前の状態のまま', async () => {
    const before = [node('a', 'root'), node('b', 'root'), node('c', null)];
    const state: { records: Row[]; failAt?: number } = { records: before };
    const { store, calls } = boot(state);
    await store.loadAll();
    expect(Array.from(store.getAllNodes())).toHaveLength(3);

    state.records = manyNodes(LOAD_PAGE_SIZE + 10);
    state.failAt = calls.length + 1; // 次の読み込みの 2 回目の getAll
    await expect(store.loadAll()).rejects.toThrow('boom');

    expect(
      Array.from(store.getAllNodes())
        .map((x) => x.id)
        .sort(),
    ).toEqual(['a', 'b', 'c']);
    expect(store.getChildren('root')).toHaveLength(2);
    expect(store.getTotalSize()).toBe(3);
  });
});
