/**
 * src/core/sys/LocalReset.ts
 * 起動失敗画面からの「修復して起動」「工場出荷状態に戻す」（T-0381）。
 *
 * ■ なぜ予約なのか
 * 起動に失敗した時点では NodeStore が IndexedDB を開いていることがあり、その場で deleteDatabase すると
 * blocked になる。だから予約だけ localStorage に書いてリロードし、次の起動の最初（DB 接続もデーモンも無い時点）で
 * 実行する。ミャク楽の OwnershipGuard と同じ順序。
 *
 * ■ Itera にはクラウドが無い
 * 消したものは戻らない。だから予約は「1 回だけ」効く —— 実行前に予約を消し、失敗しても勝手に繰り返さない。
 * もう一度消すのは利用者が押したときだけ。
 */

const RESET_PENDING_KEY = 'itera_local_reset_pending';
const REPAIR_PENDING_KEY = 'itera_local_repair_pending';
const NOTICE_KEY = 'itera_local_reset_notice';

const VFS_DB_NAME = 'itera_vfs_v2';
const HISTORY_DB_NAME = 'itera_history_v2';

/** 起動後に 1 度だけ利用者へ見せるもの。 */
export type LocalResetNotice =
  | { kind: 'reset_done' }
  | { kind: 'reset_failed'; reason: string }
  | { kind: 'repair_clean' }
  | { kind: 'repaired'; fixed: number }
  | { kind: 'repair_failed'; reason: string };

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    console.error('[LocalReset] Failed to write localStorage:', key, e);
  }
}

function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* noop */
  }
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => {
      settled = true;
      resolve();
    };
    req.onerror = (e) => {
      settled = true;
      reject((e.target as any)?.error || new Error(`deleteDatabase failed: ${name}`));
    };
    // 他タブが同じ DB を開いていると blocked になる。黙って待たず失敗させる。
    req.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new Error(`deleteDatabase blocked (another tab may be open): ${name}`));
    };
    setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`deleteDatabase timed out: ${name}`));
    }, 10000);
  });
}

async function clearOpfs(): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.getDirectory) return;
  const root = await navigator.storage.getDirectory();
  // @ts-ignore - 環境によって AsyncIterable の型定義が不足するため保護
  for await (const key of (root as any).keys()) {
    await root.removeEntry(key, { recursive: true });
  }
}

export class LocalReset {
  /** 起動失敗画面の「工場出荷状態に戻す」。ここでは何も消さない。 */
  static requestFactoryReset(): void {
    safeSet(RESET_PENDING_KEY, '1');
  }

  /** 起動失敗画面の「修復して起動」。次の起動で NodeStore を読んだ直後に fsck を走らせる。 */
  static requestRepair(): void {
    safeSet(REPAIR_PENDING_KEY, '1');
  }

  static isResetPending(): boolean {
    return safeGet(RESET_PENDING_KEY) === '1';
  }

  /**
   * 予約された消去を実行する。
   * ★ ブートの最初、NodeStore / HistoryManager を構築するより前に呼ぶこと。
   * @returns 消去を実行して成功した場合 true
   */
  static async enforceAtBoot(): Promise<boolean> {
    if (!this.isResetPending()) return false;
    // 予約は先に消す。失敗しても次の起動で勝手に繰り返さない（消えるのは取り返しがつかない）。
    safeRemove(RESET_PENDING_KEY);
    console.warn('[LocalReset] Factory reset requested. Discarding all local data before boot.');
    try {
      await clearOpfs();
      await deleteDatabase(VFS_DB_NAME);
      await deleteDatabase(HISTORY_DB_NAME);
      this.setNotice({ kind: 'reset_done' });
      return true;
    } catch (e) {
      const reason = (e as { message?: string } | null)?.message || String(e);
      console.error('[LocalReset] Factory reset failed.', e);
      this.setNotice({ kind: 'reset_failed', reason });
      return false;
    }
  }

  /** 修復の予約を 1 度だけ取り出す。 */
  static consumeRepairRequest(): boolean {
    const pending = safeGet(REPAIR_PENDING_KEY) === '1';
    if (pending) safeRemove(REPAIR_PENDING_KEY);
    return pending;
  }

  static setNotice(notice: LocalResetNotice): void {
    safeSet(NOTICE_KEY, JSON.stringify(notice));
  }

  /** 起動後の通知を 1 度だけ取り出す。 */
  static consumeNotice(): LocalResetNotice | null {
    const raw = safeGet(NOTICE_KEY);
    if (!raw) return null;
    safeRemove(NOTICE_KEY);
    try {
      return JSON.parse(raw) as LocalResetNotice;
    } catch {
      return null;
    }
  }
}
