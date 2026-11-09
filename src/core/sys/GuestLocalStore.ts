/**
 * src/core/sys/GuestLocalStore.ts
 * ゲストの「端末ローカルの小さな状態」の置き場（MetaOS.storage.local。T-0771）。
 *
 * ホストは状態を 2 つに分けて持っている:
 *   - 利用者の設定 … 設定の層（VFS の `*.json`。クラウド同期のある配布では他の端末へ運ばれる）
 *   - 端末ごとの見え方 … ホストの `localStorage`（PanelLayout の開閉と幅がこれ。同期されない）
 * ゲストには前者の口（getConfig / updateConfig）しか無く、後者を言う語彙が無かったので、
 * アプリが `localStorage` を直接触っていた。それはホストと同一オリジンであることに頼る書き方で、
 * ゲストを別オリジンにすると SecurityError で落ちる。ここはその後者をゲストへ届ける口。
 *
 * - pid ごとに 1 件の JSON（`itera.guest.<pid>`）。アプリ同士は互いの鍵を見られない
 * - 値は JSON にできるもの。容量は localStorage の範囲（数 MB）。大きな物は VFS に置く
 * - 書けなければ投げる（黙って落とさない。利用者のアプリが「保存した」と信じるのが最悪）
 */

export const GUEST_LOCAL_PREFIX = 'itera.guest.';

type Bag = Record<string, unknown>;

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export class GuestLocalStore {
  private readonly storage: Storage | null;

  constructor(storage: Storage | null = defaultStorage()) {
    this.storage = storage;
  }

  /** この端末で使えるか（localStorage が無い・触れない環境では false） */
  get available(): boolean {
    return this.storage !== null;
  }

  get(pid: string, key: string): unknown {
    const bag = this.read(this.slot(pid));
    const k = this.key(key);
    return Object.prototype.hasOwnProperty.call(bag, k) ? bag[k] : null;
  }

  set(pid: string, key: string, value: unknown): void {
    const slot = this.slot(pid);
    const k = this.key(key);
    if (value === undefined) {
      throw new Error('storage.local: value must be JSON-serializable (undefined is not)');
    }
    const bag = this.read(slot);
    // JSON の往復で正規化する（Date や関数など、JSON にならないものはここで露わになる）
    const text = JSON.stringify(value);
    if (text === undefined) {
      throw new Error('storage.local: value must be JSON-serializable');
    }
    bag[k] = JSON.parse(text);
    this.write(slot, bag);
  }

  remove(pid: string, key: string): void {
    const slot = this.slot(pid);
    const k = this.key(key);
    const bag = this.read(slot);
    if (!Object.prototype.hasOwnProperty.call(bag, k)) return;
    delete bag[k];
    if (Object.keys(bag).length === 0) {
      this.need().removeItem(slot);
    } else {
      this.write(slot, bag);
    }
  }

  keys(pid: string): string[] {
    return Object.keys(this.read(this.slot(pid)));
  }

  // ------------------------------------------------------------------

  private need(): Storage {
    if (!this.storage) {
      throw new Error('storage.local is not available on this device (no localStorage)');
    }
    return this.storage;
  }

  private slot(pid: string): string {
    if (typeof pid !== 'string' || pid.trim() === '') {
      throw new Error('storage.local: unknown process');
    }
    return GUEST_LOCAL_PREFIX + pid;
  }

  private key(key: unknown): string {
    if (typeof key !== 'string' || key === '') {
      throw new Error('storage.local: key must be a non-empty string');
    }
    return key;
  }

  private read(slot: string): Bag {
    const raw = this.need().getItem(slot);
    if (raw === null) return {};
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Bag;
    } catch {
      /* 壊れた控えは空として扱う（次の set で書き直される） */
    }
    console.warn(`[GuestLocalStore] ${slot} is not a JSON object; treating it as empty`);
    return {};
  }

  private write(slot: string, bag: Bag): void {
    try {
      this.need().setItem(slot, JSON.stringify(bag));
    } catch (e) {
      // QuotaExceededError など。何が起きたかをゲストへそのまま伝える
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`storage.local: could not write ${slot}: ${msg}`);
    }
  }
}
