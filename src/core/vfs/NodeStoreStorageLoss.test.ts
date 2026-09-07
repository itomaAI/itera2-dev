import { describe, it, expect, afterEach } from 'vitest';
import { NodeStore } from './NodeStore';

/**
 * src/core/vfs/NodeStoreStorageLoss.test.ts
 * 動作中のストレージ消失の検知 — T-0382
 *
 * 押さえるのは 2 点。
 *  1. 接続に close / versionchange の見張りが付き、受け手に理由が届く
 *  2. versionchange では先に自分の接続を閉じる（閉じないと相手の deleteDatabase が blocked のまま）
 */

function fakeIndexedDb() {
  const db: any = {
    closed: 0,
    objectStoreNames: { contains: () => true },
    close() {
      this.closed++;
    },
  };
  const idb = {
    open() {
      const req: any = {};
      setTimeout(() => req.onsuccess && req.onsuccess({ target: { result: db } }), 0);
      return req;
    },
  };
  return { idb, db };
}

describe('NodeStore の接続の見張り', () => {
  const original = (globalThis as any).indexedDB;
  afterEach(() => {
    (globalThis as any).indexedDB = original;
  });

  it('close と versionchange が受け手に届き、versionchange では先に閉じる', async () => {
    const f = fakeIndexedDb();
    (globalThis as any).indexedDB = f.idb;

    const store = new NodeStore();
    const reasons: string[] = [];
    store.setStorageLossHandler((r) => reasons.push(r));
    await new Promise((r) => setTimeout(r, 5));

    expect(typeof f.db.onclose).toBe('function');
    expect(typeof f.db.onversionchange).toBe('function');

    f.db.onclose();
    expect(reasons).toEqual(['close']);

    f.db.onversionchange();
    expect(f.db.closed).toBe(1);
    expect(reasons).toEqual(['close', 'versionchange']);
  });

  it('受け手が無ければ黙って捨てる（起動中）', async () => {
    const f = fakeIndexedDb();
    (globalThis as any).indexedDB = f.idb;
    new NodeStore();
    await new Promise((r) => setTimeout(r, 5));
    expect(() => f.db.onclose()).not.toThrow();
  });
});
