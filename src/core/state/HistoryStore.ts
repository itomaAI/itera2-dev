/**
 * src/core/state/HistoryStore.ts
 * Itera OS v2: 会話の保存（IndexedDB）
 *
 * 会話そのもの（メモリの turns と変更の知らせ）は HistoryManager。ここはその保存だけを持つ（T-0903 で分けた）:
 *   - いまの会話の保存 … 結び付けた 1 つの会話（OS のチャットの会話）を、変わるたびに書く。起動時に読み戻す
 *   - 退避した会話の出し入れ（T-0613）… 札・索引・本体。判断はしない（規則は sessionArchive.ts、手順は SessionManager）
 *
 * 保存されるのは結び付けた会話だけ。ほかの会話（ルートでないエンジンのもの）は、その持ち主が自分で保存する。
 * DB の名前・store・鍵は分ける前と同じ（移行は無い）。
 */

import type { HistoryManager, Turn } from './HistoryManager';
import type { CurrentSessionMeta, SessionMeta } from './sessionArchive';

export class HistoryStore {
  // 永続化用のIndexedDB設定
  private dbName = 'itera_history_v2';
  private storeName = 'state';
  private dbPromise: Promise<IDBDatabase>;

  /** 保存する会話（結び付けたもの）。結び付ける前は null */
  private history: HistoryManager | null = null;
  private saveTimeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.dbPromise = this._initDB();
  }

  // ==========================================
  // IndexedDB Persistence
  // ==========================================

  private _initDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);
      request.onerror = (e) => reject((e.target as any).error);
      request.onupgradeneeded = (e) => {
        const db = (e.target as any).result as IDBDatabase;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };
      request.onsuccess = (e) => {
        const db = (e.target as any).result as IDBDatabase;
        this.watchStorageLoss(db);
        resolve(db);
      };
    });
  }

  private storageLossHandler: ((reason: 'close' | 'versionchange') => void) | null = null;

  /** 動作中に DB が外から消された／閉じられたときの受け手（T-0383）。NodeStore と同じ形。 */
  setStorageLossHandler(handler: (reason: 'close' | 'versionchange') => void): void {
    this.storageLossHandler = handler;
  }

  private watchStorageLoss(db: IDBDatabase): void {
    db.onclose = () => this.storageLossHandler?.('close');
    db.onversionchange = () => {
      try {
        db.close();
      } catch {
        /* noop */
      }
      this.storageLossHandler?.('versionchange');
    };
  }

  // store `state` のキー（T-0613）。turns 以外は会話の退避に使う。
  // 版は 1 のまま（store を足して版を上げると、古いビルドで開いたとき VersionError で会話が空に見える）
  private static readonly KEY_TURNS = 'turns';
  private static readonly KEY_CURRENT_META = 'current_meta';
  private static readonly KEY_SESSIONS_INDEX = 'sessions_index';
  private static sessionKey(id: string): string {
    return `session:${id}`;
  }

  private async _dbGet<T>(key: string): Promise<T | undefined> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction([this.storeName], 'readonly');
      const req = tx.objectStore(this.storeName).get(key);
      req.onsuccess = (e) => resolve((e.target as any).result);
      req.onerror = (e) => reject((e.target as any).error);
    });
  }

  private async _dbPut(key: string, value: unknown): Promise<void> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction([this.storeName], 'readwrite');
      const req = tx.objectStore(this.storeName).put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = (e) => reject((e.target as any).error);
    });
  }

  private async _dbDelete(key: string): Promise<void> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction([this.storeName], 'readwrite');
      const req = tx.objectStore(this.storeName).delete(key);
      req.onsuccess = () => resolve();
      req.onerror = (e) => reject((e.target as any).error);
    });
  }

  // ==========================================
  // いまの会話の保存
  // ==========================================

  /**
   * 会話を結び付ける（起動時に 1 度）: 保存してあるターンを読み戻し、以後の変更を保存する。
   * 読み戻しは会話の `load`（＝保存を起こさない変更）で入れる。保存が無ければ会話には触らない。
   */
  async attach(history: HistoryManager): Promise<void> {
    if (this.history) throw new Error('HistoryStore is already attached to a conversation.');
    this.history = history;
    try {
      const turns = await this._dbGet<Turn[]>(HistoryStore.KEY_TURNS);

      if (turns && Array.isArray(turns)) {
        history.load(turns);
        console.log(`[HistoryStore] Loaded ${turns.length} turns from DB.`);
      }
    } catch (e) {
      console.warn('[HistoryStore] No previous history found or load failed.');
    }

    // ロード以外の変更時は自動でDBに保存する (デバウンス付き)
    history.on('change', (payload) => {
      if (payload.type === 'load') return;
      if (this.saveTimeoutId) {
        clearTimeout(this.saveTimeoutId);
      }
      this.saveTimeoutId = setTimeout(() => {
        this._saveToDB();
      }, 500);
    });
  }

  private async _saveToDB(): Promise<void> {
    if (!this.history) return;
    try {
      await this._dbPut(HistoryStore.KEY_TURNS, this.history.get());
    } catch (e) {
      console.error('[HistoryStore] Failed to persist history:', e);
    }
  }

  /** 予約してある保存を待たずに、いまの会話を DB へ書く（会話の `load()` は保存を起こさないので、差し替えた側が呼ぶ） */
  async persist(): Promise<void> {
    if (this.saveTimeoutId) {
      clearTimeout(this.saveTimeoutId);
      this.saveTimeoutId = null;
    }
    await this._saveToDB();
  }

  // ==========================================
  // Session archive I/O（T-0613）。判断はしない（純粋な出し入れ）。規則は sessionArchive.ts、手順は SessionManager
  // ==========================================

  async getCurrentMeta(): Promise<CurrentSessionMeta | undefined> {
    return this._dbGet<CurrentSessionMeta>(HistoryStore.KEY_CURRENT_META);
  }

  async setCurrentMeta(meta: CurrentSessionMeta): Promise<void> {
    await this._dbPut(HistoryStore.KEY_CURRENT_META, meta);
  }

  async getSessionsIndex(): Promise<SessionMeta[]> {
    const v = await this._dbGet<SessionMeta[]>(HistoryStore.KEY_SESSIONS_INDEX);
    return Array.isArray(v) ? v : [];
  }

  async setSessionsIndex(index: SessionMeta[]): Promise<void> {
    await this._dbPut(HistoryStore.KEY_SESSIONS_INDEX, index);
  }

  async getSession(id: string): Promise<Turn[] | undefined> {
    const v = await this._dbGet<Turn[]>(HistoryStore.sessionKey(id));
    return Array.isArray(v) ? v : undefined;
  }

  async putSession(id: string, turns: Turn[]): Promise<void> {
    await this._dbPut(HistoryStore.sessionKey(id), turns);
  }

  async deleteSession(id: string): Promise<void> {
    await this._dbDelete(HistoryStore.sessionKey(id));
  }
}
