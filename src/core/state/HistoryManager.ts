/**
 * src/core/state/HistoryManager.ts
 * Itera OS v2: Epistemic History Manager
 *
 * 1 つの会話: メモリの turns と、変更の知らせ。エンジンごとに 1 つ持つ。
 * 保存はここには無い（T-0903 で分けた）。OS のチャットの会話は HistoryStore が聞いて IndexedDB に書く。
 * ほかの会話を保存するかどうかは、その持ち主が決める。
 */

import type { MediaContentNode, TextContentNode } from '../types/content';
import type { ToolExecutionEntry } from '../types/tools';
import { generateId } from '../../utils/id';

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

  private _notify(payload: HistoryEventPayload): void {
    this.listeners.forEach((cb) => cb(payload));
  }

  // ==========================================
  // Core Methods
  // ==========================================

  /** 会話を丸ごと差し替える（保存からの読み戻し・退避した会話への切り替え）。知らせは `load` */
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
