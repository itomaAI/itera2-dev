/**
 * src/shell/services/HistoryEventRecorder.ts
 * Itera OS v2: Text-only History Event Recorder
 */

import type {
  HistoryEventPayload,
  HistoryManager,
  Role,
  Turn,
  TurnMeta,
} from '../../core/state/HistoryManager';
import type { SystemLogger } from '../../core/state/SystemLogger';
import {
  isMediaContentNode,
  isTextContentNode,
} from '../../core/state/TurnContentNormalizer';

interface HistoryLogMeta {
  type?: string;
  visible?: boolean;
  trigger_llm?: boolean;
  status?: TurnMeta['status'];
}

interface HistoryTurnLogEntry {
  action: 'append' | 'update';
  totalTurns: number;
  turnId: string;
  turnTimestamp: number;
  role: Role;
  text: string;
  attachments: {
    count: number;
  };
  meta: HistoryLogMeta;
}

interface HistoryDeleteLogEntry {
  action: 'delete';
  totalTurns: number;
  turnId: string;
}

interface HistoryClearLogEntry {
  action: 'clear';
  totalTurns: number;
  removedTurns: number;
}

type HistoryLogEntry =
  | HistoryTurnLogEntry
  | HistoryDeleteLogEntry
  | HistoryClearLogEntry;

interface TextProjection {
  text: string;
  attachmentCount: number;
}

const USER_ATTACHMENT_NODE_PREFIX = /^\s*<user_attachment(?:\s|>)/;

export class HistoryEventRecorder {
  private readonly history: HistoryManager;
  private readonly logger: SystemLogger;
  private unsubscribe: (() => void) | null = null;
  private readonly pendingModelUpdates = new Map<string, HistoryTurnLogEntry>();
  private readonly scheduledModelTurnIds = new Set<string>();

  constructor(history: HistoryManager, logger: SystemLogger) {
    this.history = history;
    this.logger = logger;
    this.handleHistoryChange = this.handleHistoryChange.bind(this);
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.history.on('change', this.handleHistoryChange);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.pendingModelUpdates.clear();
    this.scheduledModelTurnIds.clear();
  }

  private handleHistoryChange(payload: HistoryEventPayload): void {
    if (payload.type === 'load') return;

    if (payload.type === 'clear') {
      // クリア以前に予約されたモデル更新が、clearログの後へ遅延記録されることを防ぐ。
      this.pendingModelUpdates.clear();
      this.scheduledModelTurnIds.clear();
      this.record({
        action: 'clear',
        totalTurns: payload.count,
        removedTurns: payload.previousCount,
      });
      return;
    }

    if (payload.type === 'delete') {
      this.pendingModelUpdates.delete(payload.turn.id);
      this.record({
        action: 'delete',
        totalTurns: payload.count,
        turnId: payload.turn.id,
      });
      return;
    }

    const turn = payload.turn;
    if (this.isToolExecutionTurn(turn)) return;

    const entry = this.createTurnLogEntry(payload.type, payload.count, turn);

    // Engineはモデル生成開始時に空Turnをappendする。最終テキストではないため記録しない。
    if (payload.type === 'append' && turn.role === 'model' && entry.text === '') {
      return;
    }

    if (payload.type === 'update' && turn.role === 'model') {
      // 未完了の生成内容は最終的なチャット履歴ではないため記録しない。
      if (turn.meta.status === 'pending') return;

      // Engineは同一タスク内で、生応答とLPML切り詰め後の応答を連続更新する場合がある。
      // 任意時間の待機を使わず、現在のタスク内の最終更新だけを記録する。
      this.scheduleLatestModelUpdate(entry);
      return;
    }

    this.record(entry);
  }

  private isToolExecutionTurn(turn: Turn): boolean {
    return turn.meta.type === 'tool_execution';
  }

  private createTurnLogEntry(
    action: 'append' | 'update',
    totalTurns: number,
    turn: Turn,
  ): HistoryTurnLogEntry {
    const projection = this.projectTextOnly(turn);

    return {
      action,
      totalTurns,
      turnId: turn.id,
      turnTimestamp: turn.timestamp,
      role: turn.role,
      text: projection.text,
      attachments: {
        count: projection.attachmentCount,
      },
      meta: {
        type: turn.meta.type,
        visible: turn.meta.visible,
        trigger_llm: turn.meta.trigger_llm,
        status: turn.meta.status,
      },
    };
  }

  private scheduleLatestModelUpdate(entry: HistoryTurnLogEntry): void {
    this.pendingModelUpdates.set(entry.turnId, entry);
    if (this.scheduledModelTurnIds.has(entry.turnId)) return;

    this.scheduledModelTurnIds.add(entry.turnId);
    queueMicrotask(() => {
      this.scheduledModelTurnIds.delete(entry.turnId);
      const latestEntry = this.pendingModelUpdates.get(entry.turnId);
      this.pendingModelUpdates.delete(entry.turnId);
      if (latestEntry) this.record(latestEntry);
    });
  }

  private projectTextOnly(turn: Turn): TextProjection {
    if (typeof turn.content === 'string') {
      return this.projectStringContent(turn.role, turn.content);
    }

    let mediaNodeCount = 0;
    let attachmentMarkerCount = 0;
    const textParts: string[] = [];

    for (const node of turn.content) {
      if (isMediaContentNode(node)) {
        mediaNodeCount += 1;
        continue;
      }

      if (!isTextContentNode(node)) {
        // ToolExecutionEntryおよび未知のノードはログへ投影しない。
        continue;
      }

      if (turn.role === 'user' && this.isAttachmentMarkerNode(node.text)) {
        // 1添付につき専用ノードが1つ生成される。本文内のタグらしき文字列は数えない。
        attachmentMarkerCount += 1;
        continue;
      }

      if (node.text.length > 0) textParts.push(node.text);
    }

    return {
      text: textParts.join('\n'),
      // バイナリ添付はMedia nodeとテキストmarkerの両方を持つため、合算しない。
      attachmentCount: Math.max(mediaNodeCount, attachmentMarkerCount),
    };
  }

  private projectStringContent(role: Role, content: string): TextProjection {
    if (role === 'user' && this.isAttachmentMarkerNode(content)) {
      // 文字列形式では添付境界を安全に特定できないため、漏洩防止を優先して全体を破棄する。
      return { text: '', attachmentCount: 1 };
    }
    return { text: content, attachmentCount: 0 };
  }

  private isAttachmentMarkerNode(content: string): boolean {
    return USER_ATTACHMENT_NODE_PREFIX.test(content);
  }

  private record(entry: HistoryLogEntry): void {
    void this.logger.log('history', entry);
  }
}