/**
 * src/core/state/HistoryManager.ts
 * Itera OS v2: Epistemic History Manager
 */

import type { MediaContentNode, TextContentNode } from '../types/content';
import type { ToolExecutionEntry } from '../types/tools';
import { generateId } from '../../utils/id';
import type { CurrentSessionMeta, SessionMeta } from './sessionArchive';

export type Role = 'user' | 'model' | 'system';
export type TurnContent = string | Array<TextContentNode | MediaContentNode | ToolExecutionEntry>;

export interface TurnMeta {
  type?: string; // 'message' | 'tool_execution' | 'event_log' | 'error'
  /** event_log のとき、<event type="…"> の種類（tool_available / info / app_event …）。画面で隠す判定に使う */
  eventType?: string;
  visible?: boolean;
  trigger_llm?: boolean;
  status?: 'completed' | 'error' | 'pending';
  [key: string]: any;
}

export interface Turn {
  id: string;
  timestamp: number;
  role: Role;
  content: TurnContent;
  meta: TurnMeta;
}

export type HistoryEventPayload =
  | {
      type: 'append' | 'update' | 'delete';
      count: number;
      turn: Turn;
    }
  | {
      type: 'clear';
      count: number;
      previousCount: number;
      turn: null;
    }
  | {
      type: 'load';
      count: number;
      turn: null;
    };

export type HistorySubscriber = (payload: HistoryEventPayload) => void;

export class HistoryManager {
  private turns: Turn[] = [];
  private listeners: HistorySubscriber[] = [];

  // 永続化用のIndexedDB設定
  private dbName = 'itera_history_v2';
  private storeName = 'state';
  private dbPromise: Promise<IDBDatabase>;

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

  private async _saveToDB(): Promise<void> {
    try {
      await this._dbPut(HistoryManager.KEY_TURNS, this.turns);
    } catch (e) {
      console.error('[HistoryManager] Failed to persist history:', e);
    }
  }

  /** 予約してある保存を待たずに、いまの会話を DB へ書く（`load()` は自動で保存しないので、差し替えた側が呼ぶ） */
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
    return this._dbGet<CurrentSessionMeta>(HistoryManager.KEY_CURRENT_META);
  }

  async setCurrentMeta(meta: CurrentSessionMeta): Promise<void> {
    await this._dbPut(HistoryManager.KEY_CURRENT_META, meta);
  }

  async getSessionsIndex(): Promise<SessionMeta[]> {
    const v = await this._dbGet<SessionMeta[]>(HistoryManager.KEY_SESSIONS_INDEX);
    return Array.isArray(v) ? v : [];
  }

  async setSessionsIndex(index: SessionMeta[]): Promise<void> {
    await this._dbPut(HistoryManager.KEY_SESSIONS_INDEX, index);
  }

  async getSession(id: string): Promise<Turn[] | undefined> {
    const v = await this._dbGet<Turn[]>(HistoryManager.sessionKey(id));
    return Array.isArray(v) ? v : undefined;
  }

  async putSession(id: string, turns: Turn[]): Promise<void> {
    await this._dbPut(HistoryManager.sessionKey(id), turns);
  }

  async deleteSession(id: string): Promise<void> {
    await this._dbDelete(HistoryManager.sessionKey(id));
  }

  async loadFromDB(): Promise<void> {
    try {
      const turns = await this._dbGet<Turn[]>(HistoryManager.KEY_TURNS);

      if (turns && Array.isArray(turns)) {
        this.turns = turns;
        this._notify({
          type: 'load',
          count: this.turns.length,
          turn: null,
        });
        console.log(`[HistoryManager] Loaded ${this.turns.length} turns from DB.`);
      }
    } catch (e) {
      console.warn('[HistoryManager] No previous history found or load failed.');
    }
  }

  // ==========================================
  // Event System
  // ==========================================

  on(event: 'change', callback: HistorySubscriber): () => void {
    if (event === 'change') {
      this.listeners.push(callback);
    }
    return () => {
      this.listeners = this.listeners.filter((cb) => cb !== callback);
    };
  }

  private saveTimeoutId: ReturnType<typeof setTimeout> | null = null;

  private _notify(payload: HistoryEventPayload): void {
    this.listeners.forEach((cb) => cb(payload));

    // ロード以外の変更時は自動でDBに保存する (デバウンス付き)
    if (payload.type !== 'load') {
      if (this.saveTimeoutId) {
        clearTimeout(this.saveTimeoutId);
      }
      this.saveTimeoutId = setTimeout(() => {
        this._saveToDB();
      }, 500);
    }
  }

  // ==========================================
  // Core Methods
  // ==========================================

  load(historyData: Turn[]): void {
    if (Array.isArray(historyData)) {
      this.turns = historyData;
    } else {
      this.turns = [];
    }
    this._notify({
      type: 'load',
      count: this.turns.length,
      turn: null,
    });
  }

  append(role: Role, content: TurnContent, meta: TurnMeta = {}): Turn {
    const turn: Turn = {
      id: generateId(),
      timestamp: Date.now(),
      role: role,
      content: content,
      meta: {
        type: 'message',
        visible: true,
        trigger_llm: true, // デフォルトでAIを発火
        ...meta,
      },
    };
    this.turns.push(turn);
    this._notify({
      type: 'append',
      count: this.turns.length,
      turn,
    });
    return turn;
  }

  update(id: string, content?: TurnContent, meta: TurnMeta = {}): Turn | null {
    const index = this.turns.findIndex((t) => t.id === id);
    if (index !== -1) {
      if (content !== undefined) {
        this.turns[index].content = content;
      }
      this.turns[index].meta = {
        ...this.turns[index].meta,
        ...meta,
      };
      this._notify({
        type: 'update',
        count: this.turns.length,
        turn: this.turns[index],
      });
      return this.turns[index];
    }
    return null;
  }

  delete(id: string): void {
    const initialLen = this.turns.length;
    const deletedTurn = this.turns.find((t) => t.id === id);
    this.turns = this.turns.filter((t) => t.id !== id);
    if (this.turns.length !== initialLen && deletedTurn) {
      this._notify({
        type: 'delete',
        count: this.turns.length,
        turn: deletedTurn,
      });
    }
  }

  clear(): void {
    const previousCount = this.turns.length;
    this.turns = [];
    this._notify({
      type: 'clear',
      count: this.turns.length,
      previousCount,
      turn: null,
    });
  }

  get(): Turn[] {
    return this.turns;
  }

  getLast(): Turn | null {
    return this.turns.length > 0 ? this.turns[this.turns.length - 1] : null;
  }
}
