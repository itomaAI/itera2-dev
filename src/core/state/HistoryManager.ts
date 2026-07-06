/**
 * src/core/state/HistoryManager.ts
 * Itera OS v2: Epistemic History Manager
 */

export type Role = "user" | "model" | "system";

export interface TurnMeta {
  type?: string; // 'message' | 'tool_execution' | 'event_log' | 'error'
  visible?: boolean;
  trigger_llm?: boolean;
  status?: "completed" | "error" | "pending";
  [key: string]: any;
}

export interface Turn {
  id: string;
  timestamp: number;
  role: Role;
  content: any; // string または array
  meta: TurnMeta;
}

export interface HistoryEventPayload {
  type: "append" | "update" | "delete" | "clear" | "load";
  count: number;
  turn: Turn | null;
}

export type HistorySubscriber = (payload: HistoryEventPayload) => void;

function generateId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID)
    return crypto.randomUUID();
  return (
    Math.random().toString(36).substring(2, 15) +
    Math.random().toString(36).substring(2, 15)
  );
}

export class HistoryManager {
  private turns: Turn[] = [];
  private listeners: HistorySubscriber[] = [];

  // 永続化用のIndexedDB設定
  private dbName = "itera_history_v2";
  private storeName = "state";
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
      request.onsuccess = (e) =>
        resolve((e.target as any).result as IDBDatabase);
    });
  }

  private async _saveToDB(): Promise<void> {
    try {
      const db = await this.dbPromise;
      return new Promise((resolve, reject) => {
        const tx = db.transaction([this.storeName], "readwrite");
        const store = tx.objectStore(this.storeName);
        const req = store.put(this.turns, "turns");
        req.onsuccess = () => resolve();
        req.onerror = (e) => reject((e.target as any).error);
      });
    } catch (e) {
      console.error("[HistoryManager] Failed to persist history:", e);
    }
  }

  async loadFromDB(): Promise<void> {
    try {
      const db = await this.dbPromise;
      const turns: Turn[] | undefined = await new Promise((resolve, reject) => {
        const tx = db.transaction([this.storeName], "readonly");
        const store = tx.objectStore(this.storeName);
        const req = store.get("turns");
        req.onsuccess = (e) => resolve((e.target as any).result);
        req.onerror = (e) => reject((e.target as any).error);
      });

      if (turns && Array.isArray(turns)) {
        this.turns = turns;
        this._notify("load");
        console.log(
          `[HistoryManager] Loaded ${this.turns.length} turns from DB.`,
        );
      }
    } catch (e) {
      console.warn(
        "[HistoryManager] No previous history found or load failed.",
      );
    }
  }

  // ==========================================
  // Event System
  // ==========================================

  on(event: "change", callback: HistorySubscriber): () => void {
    if (event === "change") {
      this.listeners.push(callback);
    }
    return () => {
      this.listeners = this.listeners.filter((cb) => cb !== callback);
    };
  }

  private _notify(
    action: HistoryEventPayload["type"],
    turn: Turn | null = null,
  ): void {
    const payload: HistoryEventPayload = {
      type: action,
      count: this.turns.length,
      turn,
    };
    this.listeners.forEach((cb) => cb(payload));

    // ロード以外の変更時は自動でDBに保存する
    if (action !== "load") {
      this._saveToDB();
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
    this._notify("load");
  }

  append(role: Role, content: any, meta: TurnMeta = {}): Turn {
    const turn: Turn = {
      id: generateId(),
      timestamp: Date.now(),
      role: role,
      content: content,
      meta: {
        type: "message",
        visible: true,
        trigger_llm: true, // デフォルトでAIを発火
        ...meta,
      },
    };
    this.turns.push(turn);
    this._notify("append", turn);
    return turn;
  }

  update(id: string, content?: any, meta: TurnMeta = {}): Turn | null {
    const index = this.turns.findIndex((t) => t.id === id);
    if (index !== -1) {
      if (content !== undefined) {
        this.turns[index].content = content;
      }
      this.turns[index].meta = {
        ...this.turns[index].meta,
        ...meta,
      };
      this._notify("update", this.turns[index]);
      return this.turns[index];
    }
    return null;
  }

  delete(id: string): void {
    const initialLen = this.turns.length;
    this.turns = this.turns.filter((t) => t.id !== id);
    if (this.turns.length !== initialLen) {
      this._notify("delete");
    }
  }

  clear(): void {
    this.turns = [];
    this._notify("clear");
  }

  get(): Turn[] {
    return this.turns;
  }

  getLast(): Turn | null {
    return this.turns.length > 0 ? this.turns[this.turns.length - 1] : null;
  }
}
