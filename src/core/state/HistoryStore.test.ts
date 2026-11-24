/**
 * src/core/state/HistoryStore.test.ts
 * 会話の保存（IndexedDB）。T-0903 で HistoryManager から分けた。
 *
 * 守りたいこと:
 *   - DB の名前・store・鍵は分ける前と同じ（移行が無いので、変えると利用者の会話が読めなくなる）
 *   - 結び付けた会話を読み戻し、以後の変更を 500 ms まとめて書く。`load`（読み戻し・切り替え）は保存を起こさない
 *   - `persist()` は予約を待たずに書く
 *   - 保存するのは結び付けた 1 つの会話だけ
 *
 * 本物の IndexedDB は無いので、同じ口を持つ最小の偽物を差す（実機の読み書きは実ブラウザの通しで確かめる）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HistoryManager } from './HistoryManager';
import { HistoryStore } from './HistoryStore';

/* eslint-disable @typescript-eslint/no-explicit-any */
function fakeIndexedDB(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));
  const opened: Array<{ name: string; version: number }> = [];
  const stores: string[] = [];
  const request = (work: () => unknown) => {
    const req: any = {};
    void Promise.resolve().then(() => {
      try {
        const result = work();
        req.onsuccess?.({ target: { result } });
      } catch (error) {
        req.onerror?.({ target: { error } });
      }
    });
    return req;
  };
  const db: any = {
    objectStoreNames: { contains: (name: string) => stores.includes(name) },
    createObjectStore: (name: string) => stores.push(name),
    transaction: (names: string[]) => ({
      objectStore: (name: string) => {
        if (!names.includes(name) || !stores.includes(name)) throw new Error(`no store ${name}`);
        return {
          get: (key: string) => request(() => structuredClone(data.get(key))),
          put: (value: unknown, key: string) => request(() => void data.set(key, structuredClone(value))),
          delete: (key: string) => request(() => void data.delete(key)),
        };
      },
    }),
  };
  const idb = {
    open: (name: string, version: number) => {
      opened.push({ name, version });
      const req: any = {};
      void Promise.resolve().then(() => {
        req.onupgradeneeded?.({ target: { result: db } });
        req.onsuccess?.({ target: { result: db } });
      });
      return req;
    },
  };
  return { idb, data, opened, stores };
}

const turn = (id: string, content: string) => ({ id, timestamp: 1, role: 'user' as const, content, meta: {} });

describe('HistoryStore: 会話の保存', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('DB の名前・版・store・鍵は分ける前と同じ', async () => {
    const f = fakeIndexedDB();
    vi.stubGlobal('indexedDB', f.idb);
    const store = new HistoryStore();
    await store.setCurrentMeta({ id: 's1', createdAt: 1, title: 't' });
    await store.setSessionsIndex([]);
    await store.putSession('abc', [turn('a', 'x')]);
    const history = new HistoryManager();
    await store.attach(history);
    history.append('user', 'hello');
    await store.persist();

    expect(f.opened).toEqual([{ name: 'itera_history_v2', version: 1 }]);
    expect(f.stores).toEqual(['state']);
    expect([...f.data.keys()].sort()).toEqual(['current_meta', 'session:abc', 'sessions_index', 'turns']);
  });

  it('結び付けると保存してあるターンを読み戻す（load として。保存は起こさない）', async () => {
    const saved = [turn('a', 'one'), turn('b', 'two')];
    const f = fakeIndexedDB({ turns: saved });
    vi.stubGlobal('indexedDB', f.idb);
    const store = new HistoryStore();
    const history = new HistoryManager();
    const seen: string[] = [];
    history.on('change', (p) => seen.push(p.type));

    await store.attach(history);
    expect(history.get()).toEqual(saved);
    expect(seen).toEqual(['load']);

    // 読み戻しのあとに書かれたら、この印が上書きされる
    f.data.set('turns', 'SENTINEL');
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.data.get('turns')).toBe('SENTINEL');
  });

  it('保存が無ければ会話に触らない（空のまま・知らせも出さない）', async () => {
    const f = fakeIndexedDB();
    vi.stubGlobal('indexedDB', f.idb);
    const history = new HistoryManager();
    const seen: string[] = [];
    history.on('change', (p) => seen.push(p.type));
    await new HistoryStore().attach(history);
    expect(history.get()).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('変更は 500 ms まとめて書く（続けて変わったら、最後の変更から数え直す）', async () => {
    const f = fakeIndexedDB();
    vi.stubGlobal('indexedDB', f.idb);
    const store = new HistoryStore();
    const history = new HistoryManager();
    await store.attach(history);

    const a = history.append('user', 'a');
    await vi.advanceTimersByTimeAsync(400);
    expect(f.data.has('turns')).toBe(false);
    history.update(a.id, 'a2');
    await vi.advanceTimersByTimeAsync(400);
    expect(f.data.has('turns')).toBe(false);
    await vi.advanceTimersByTimeAsync(150);
    expect((f.data.get('turns') as any[]).map((t) => t.content)).toEqual(['a2']);

    history.clear();
    await vi.advanceTimersByTimeAsync(600);
    expect(f.data.get('turns')).toEqual([]);
  });

  it('会話の差し替え（load）は保存を起こさない。persist() が予約を待たずに書く', async () => {
    const f = fakeIndexedDB();
    vi.stubGlobal('indexedDB', f.idb);
    const store = new HistoryStore();
    const history = new HistoryManager();
    await store.attach(history);

    history.load([turn('x', 'switched')]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.data.has('turns')).toBe(false);

    await store.persist();
    expect((f.data.get('turns') as any[]).map((t) => t.content)).toEqual(['switched']);

    // 予約が在っても、persist はすぐ書いて予約を取り消す
    history.append('user', 'later');
    await store.persist();
    expect((f.data.get('turns') as any[]).map((t) => t.content)).toEqual(['switched', 'later']);
    f.data.set('turns', 'SENTINEL');
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.data.get('turns')).toBe('SENTINEL');
  });

  it('保存するのは結び付けた 1 つの会話だけ（2 つ目は結び付けられず、ほかの会話の変更は書かれない）', async () => {
    const f = fakeIndexedDB();
    vi.stubGlobal('indexedDB', f.idb);
    const store = new HistoryStore();
    const root = new HistoryManager();
    const other = new HistoryManager();
    await store.attach(root);
    await expect(store.attach(other)).rejects.toThrow(/already attached/);

    other.append('user', 'not saved');
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.data.has('turns')).toBe(false);
  });

  it('退避した会話の出し入れ: 無いものは undefined／空の索引', async () => {
    const f = fakeIndexedDB();
    vi.stubGlobal('indexedDB', f.idb);
    const store = new HistoryStore();
    expect(await store.getCurrentMeta()).toBeUndefined();
    expect(await store.getSessionsIndex()).toEqual([]);
    expect(await store.getSession('nope')).toBeUndefined();
    await store.putSession('s', [turn('a', 'x')]);
    expect(await store.getSession('s')).toEqual([turn('a', 'x')]);
    await store.deleteSession('s');
    expect(await store.getSession('s')).toBeUndefined();
  });
});
