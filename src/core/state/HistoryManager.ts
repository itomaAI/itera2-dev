/**
 * src/core/state/HistoryManager.ts
 * Itera OS v2: Epistemic History Manager
 */

import type { MediaContentNode, TextContentNode } from '../types/content';
import type { ToolExecutionEntry } from '../types/tools';
import { generateId } from '../../utils/id';

export type Role = 'user' | 'model' | 'system';
export type TurnContent = string | Array<TextContentNode | MediaContentNode | ToolExecutionEntry>;

export interface TurnMeta {
  type?: string; // 'message' | 'tool_execution' | 'event_log' | 'error'
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
      request.onsuccess = (e) => resolve((e.target as any).result as IDBDatabase);
    });
  }

  private async _saveToDB(): Promise<void> {
    try {
      const db = await this.dbPromise;
      return new Promise((resolve, reject) => {
        const tx = db.transaction([this.storeName], 'readwrite');
        const store = tx.objectStore(this.storeName);
        const req = store.put(this.turns, 'turns');
        req.onsuccess = () => resolve();
        req.onerror = (e) => reject((e.target as any).error);
      });
    } catch (e) {
      console.error('[HistoryManager] Failed to persist history:', e);
    }
  }

  async loadFromDB(): Promise<void> {
    try {
      const db = await this.dbPromise;
      const turns: Turn[] | undefined = await new Promise((resolve, reject) => {
        const tx = db.transaction([this.storeName], 'readonly');
        const store = tx.objectStore(this.storeName);
        const req = store.get('turns');
        req.onsuccess = (e) => resolve((e.target as any).result);
        req.onerror = (e) => reject((e.target as any).error);
      });

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
