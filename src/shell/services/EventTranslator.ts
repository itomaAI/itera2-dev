/**
 * src/shell/services/EventTranslator.ts
 * Itera OS v2: Mutation to Natural Language Translator
 */

import type { VfsEventBus } from '../../core/vfs/VfsEventBus';
import type { HistoryManager } from '../../core/state/HistoryManager';
import type { VfsMutation } from '../../core/vfs/types';

export class EventTranslator {
  private eventBus: VfsEventBus;
  private history: HistoryManager;

  constructor(eventBus: VfsEventBus, history: HistoryManager) {
    this.eventBus = eventBus;
    this.history = history;
  }

  public start(): void {
    this.eventBus.subscribe((mutations) => this._processMutations(mutations));
  }

  private _processMutations(mutations: VfsMutation[]): void {
    // ログや一時ファイルの変更はAIへの通知ノイズになるため除外
    const relevantMutations = mutations.filter(
      (m) => !m.path.startsWith('system/logs/') && !m.path.startsWith('system/temp/')
    );

    if (relevantMutations.length === 0) return;

    // ノードIDごとにMutationをグループ化
    const mutationsByNode = new Map<string, VfsMutation[]>();
    for (const m of relevantMutations) {
      if (!mutationsByNode.has(m.nodeId)) mutationsByNode.set(m.nodeId, []);
      mutationsByNode.get(m.nodeId)!.push(m);
    }

    const logs: { type: string; message: string }[] = [];

    for (const [nodeId, nodeMutations] of mutationsByNode.entries()) {
      const attach = nodeMutations.find((m) => m.type === 'ATTACH');
      const detach = nodeMutations.find((m) => m.type === 'DETACH');
      const mutate = nodeMutations.find((m) => m.type === 'MUTATE');

      // 主体の特定
      let sourceName = 'System';
      const principal = nodeMutations[0].sourcePrincipal;
      if (principal.type === 'app') {
        sourceName = `App [${principal.id}]`;
      } else if (principal.type === 'user') {
        sourceName = 'User';
      } else if (principal.type === 'agent') {
        // AI自身が起こした変更は自分自身で認知しているため、ログを省略してループを防ぐ
        continue; 
      }

      // Rename or Move (DETACH と ATTACH が同時に発生)
      if (attach && detach) {
        logs.push({
          type: 'file_moved',
          message: `${sourceName} moved/renamed: ${detach.path} -> ${attach.path}`
        });
      }
      // Create (ATTACH のみ)
      else if (attach && !detach) {
        if (attach.node?.meta.syncState === 'stub') {
          logs.push({ type: 'file_sync', message: `${sourceName} created sync stub for: ${attach.path}` });
        } else {
          logs.push({ type: 'file_created', message: `${sourceName} created: ${attach.path}` });
        }
      }
      // Delete (DETACH のみ)
      else if (detach && !attach) {
        logs.push({ type: 'file_deleted', message: `${sourceName} deleted: ${detach.path}` });
      }
      // Edit (MUTATE のみ)
      else if (mutate) {
        // サイズやハッシュが変わっていれば内容変更とみなす
        if (mutate.changedProperties?.includes('hash') || mutate.changedProperties?.includes('size')) {
          logs.push({ type: 'file_edited', message: `${sourceName} edited: ${mutate.path}` });
        }
      }
    }

    // 大量ファイルの同時変更時はサマリー化する（履歴のパンク防止）
    if (logs.length > 5) {
      this._logToHistory('bulk_operation', `Detected ${logs.length} concurrent file system operations by Background Process.`);
    } else {
      for (const log of logs) {
        // ユーザーの手動操作については Explorer が別途リッチなログを出している場合があるため、
        // 重複を避けるために User 以外の操作（Appなどのバックグラウンド操作）を優先して出力する。
        if (log.message.startsWith('User')) continue; 
        
        this._logToHistory(log.type, log.message);
      }
    }
  }

  private _logToHistory(type: string, message: string): void {
    const lpml = `<event type="${type}">\n${message}\n</event>`;
    this.history.append('system', lpml, {
      type: 'event_log',
      trigger_llm: false, // バックグラウンド処理のたびにAIが発火するのを防ぐ
    });
  }
}