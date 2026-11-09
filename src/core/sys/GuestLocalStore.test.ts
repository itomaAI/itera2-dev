import { describe, it, expect } from 'vitest';
import { GuestLocalStore, GUEST_LOCAL_PREFIX } from './GuestLocalStore';

/** localStorage の最小の模型（試験は node で回る） */
class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  failNextSet: Error | null = null;
  get length() {
    return this.m.size;
  }
  clear() {
    this.m.clear();
  }
  getItem(k: string) {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  key(i: number) {
    return Array.from(this.m.keys())[i] ?? null;
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  setItem(k: string, v: string) {
    if (this.failNextSet) {
      const e = this.failNextSet;
      this.failNextSet = null;
      throw e;
    }
    this.m.set(k, v);
  }
  dump() {
    return Object.fromEntries(this.m);
  }
}

describe('GuestLocalStore', () => {
  it('JSON の値を往復させ、無い鍵は null', () => {
    const s = new GuestLocalStore(new MemoryStorage());
    expect(s.get('notes', 'openFolders')).toBeNull();
    s.set('notes', 'openFolders', ['a', 'b/c']);
    s.set('notes', 'outline', true);
    s.set('notes', 'n', 0);
    expect(s.get('notes', 'openFolders')).toEqual(['a', 'b/c']);
    expect(s.get('notes', 'outline')).toBe(true);
    expect(s.get('notes', 'n')).toBe(0);
    expect(s.keys('notes').sort()).toEqual(['n', 'openFolders', 'outline']);
  });

  it('pid ごとに別の袋（アプリ同士は見えない）、置き場は itera.guest.<pid> の 1 件', () => {
    const mem = new MemoryStorage();
    const s = new GuestLocalStore(mem);
    s.set('notes', 'k', 1);
    s.set('tasks', 'k', 2);
    expect(s.get('notes', 'k')).toBe(1);
    expect(s.get('tasks', 'k')).toBe(2);
    expect(s.keys('home')).toEqual([]);
    expect(Object.keys(mem.dump()).sort()).toEqual([`${GUEST_LOCAL_PREFIX}notes`, `${GUEST_LOCAL_PREFIX}tasks`]);
    expect(JSON.parse(mem.dump()[`${GUEST_LOCAL_PREFIX}notes`])).toEqual({ k: 1 });
  });

  it('remove は鍵を消し、袋が空になれば localStorage の項目ごと消す', () => {
    const mem = new MemoryStorage();
    const s = new GuestLocalStore(mem);
    s.set('notes', 'a', 1);
    s.set('notes', 'b', 2);
    s.remove('notes', 'a');
    expect(s.keys('notes')).toEqual(['b']);
    s.remove('notes', 'zzz'); // 無い鍵は何もしない
    s.remove('notes', 'b');
    expect(mem.length).toBe(0);
    expect(s.get('notes', 'b')).toBeNull();
  });

  it('値は JSON で正規化される（Date は文字列に、undefined の項目は落ちる）。JSON にならない値は断る', () => {
    const s = new GuestLocalStore(new MemoryStorage());
    const d = new Date('2026-11-09T00:00:00Z');
    s.set('p', 'when', { at: d, skip: undefined });
    expect(s.get('p', 'when')).toEqual({ at: d.toISOString() });
    expect(() => s.set('p', 'u', undefined)).toThrow(/JSON/);
    expect(() => s.set('p', 'f', () => 1)).toThrow(/JSON/);
  });

  it('鍵と pid を検める', () => {
    const s = new GuestLocalStore(new MemoryStorage());
    expect(() => s.get('notes', '')).toThrow(/key/);
    expect(() => s.set('notes', 42 as unknown as string, 1)).toThrow(/key/);
    expect(() => s.get('', 'k')).toThrow(/process/);
    expect(() => s.keys('  ')).toThrow(/process/);
  });

  it('壊れた控えは空として読み、次の set で書き直す', () => {
    const mem = new MemoryStorage();
    mem.setItem(`${GUEST_LOCAL_PREFIX}notes`, 'not json');
    const s = new GuestLocalStore(mem);
    expect(s.get('notes', 'k')).toBeNull();
    expect(s.keys('notes')).toEqual([]);
    s.set('notes', 'k', 'v');
    expect(JSON.parse(mem.dump()[`${GUEST_LOCAL_PREFIX}notes`])).toEqual({ k: 'v' });
    mem.setItem(`${GUEST_LOCAL_PREFIX}tasks`, '[1,2]'); // 配列も袋ではない
    expect(s.keys('tasks')).toEqual([]);
  });

  it('書けなければ投げる（容量超過など）。読み書きできない環境では available=false で投げる', () => {
    const mem = new MemoryStorage();
    const s = new GuestLocalStore(mem);
    s.set('notes', 'a', 1);
    mem.failNextSet = new Error('QuotaExceededError');
    expect(() => s.set('notes', 'big', 'x')).toThrow(/QuotaExceededError/);
    expect(s.get('notes', 'big')).toBeNull(); // 失敗した書き込みは残っていない
    expect(s.get('notes', 'a')).toBe(1);

    const none = new GuestLocalStore(null);
    expect(none.available).toBe(false);
    expect(() => none.get('notes', 'a')).toThrow(/not available/);
    expect(() => none.set('notes', 'a', 1)).toThrow(/not available/);
  });
});
