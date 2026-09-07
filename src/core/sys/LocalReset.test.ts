// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LocalReset } from './LocalReset';

/**
 * src/core/sys/LocalReset.test.ts
 * 起動失敗画面からの消去・修復の予約 — T-0381
 *
 * 押さえるのは 3 点。
 *  1. 予約は何も消さない。消すのは enforceAtBoot（DB 接続が無い時点）
 *  2. 予約は 1 回だけ効く —— 失敗しても次の起動で繰り返さず、通知に理由を残す
 *  3. 修復の予約と通知は 1 度だけ取り出せる
 */

function fakeIndexedDb(fail = false) {
  const deleted: string[] = [];
  const idb = {
    deleteDatabase(name: string) {
      deleted.push(name);
      const req: any = {};
      setTimeout(() => {
        if (fail) req.onblocked && req.onblocked();
        else req.onsuccess && req.onsuccess();
      }, 0);
      return req;
    },
  };
  return { idb, deleted };
}

describe('LocalReset', () => {
  const originalIdb = (globalThis as any).indexedDB;
  const originalStorage = Object.getOwnPropertyDescriptor(navigator, 'storage');

  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(navigator, 'storage', { value: undefined, configurable: true });
  });

  afterEach(() => {
    (globalThis as any).indexedDB = originalIdb;
    if (originalStorage) Object.defineProperty(navigator, 'storage', originalStorage);
    else delete (navigator as any).storage;
    localStorage.clear();
  });

  it('予約だけでは消えず、enforceAtBoot が消して通知を残す', async () => {
    const f = fakeIndexedDb();
    (globalThis as any).indexedDB = f.idb;

    LocalReset.requestFactoryReset();
    expect(f.deleted).toEqual([]);
    expect(LocalReset.isResetPending()).toBe(true);

    expect(await LocalReset.enforceAtBoot()).toBe(true);
    expect(f.deleted).toEqual(['itera_vfs_v2', 'itera_history_v2']);
    expect(LocalReset.isResetPending()).toBe(false);
    expect(LocalReset.consumeNotice()).toEqual({ kind: 'reset_done' });
    expect(LocalReset.consumeNotice()).toBeNull();
  });

  it('失敗しても予約は消え、理由が通知に残る（次の起動で繰り返さない）', async () => {
    const f = fakeIndexedDb(true);
    (globalThis as any).indexedDB = f.idb;

    LocalReset.requestFactoryReset();
    expect(await LocalReset.enforceAtBoot()).toBe(false);
    expect(LocalReset.isResetPending()).toBe(false);
    const notice = LocalReset.consumeNotice();
    expect(notice?.kind).toBe('reset_failed');
    expect((notice as any).reason).toMatch(/blocked/);
  });

  it('予約が無ければ何もしない', async () => {
    const f = fakeIndexedDb();
    (globalThis as any).indexedDB = f.idb;
    expect(await LocalReset.enforceAtBoot()).toBe(false);
    expect(f.deleted).toEqual([]);
  });

  it('修復の予約は 1 度だけ取り出せる', () => {
    expect(LocalReset.consumeRepairRequest()).toBe(false);
    LocalReset.requestRepair();
    expect(LocalReset.consumeRepairRequest()).toBe(true);
    expect(LocalReset.consumeRepairRequest()).toBe(false);
  });
});
