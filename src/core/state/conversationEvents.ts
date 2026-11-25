/**
 * src/core/state/conversationEvents.ts
 * 会話の口が、会話そのものに置く知らせの文（T-0908）。
 *
 * OS のチャットの会話（SessionManager）と、アプリが作ったエンジンの会話（EngineConversation）が、
 * 同じ場面で同じ文を置く。文を 2 か所に書くと、片方だけ直したときにモデルの読むものが役割でずれる。
 * ここは文と meta を作るだけで、置くのは会話の口。
 */

import type { TurnMeta } from './HistoryManager';

/** 会話に置く system のターンの中身 */
export interface ConversationEvent {
  content: string;
  meta: TurnMeta;
}

/**
 * 走っているアプリ・デーモンの道具の定義（T-0246）。会話を空にすると定義も一緒に消えるので、置き直す。
 * アプリが作ったエンジンは、始まりにもこれを置く（与えられた道具を、これで知る）。無ければ null。
 */
export function toolsRestoredEvent(definitions: string[]): ConversationEvent | null {
  if (definitions.length === 0) return null;
  const defsText = definitions.join('\n');
  return {
    content: `<event type="tool_available">\n[System: Restored Dynamic Tools]\nThe following tools are currently active from background processes:\n${defsText}\n</event>`,
    meta: {
      type: 'tool_available',
      eventType: 'tool_available',
      trigger_llm: false,
    },
  };
}

/** 空にしたあとの申し送り。起こすかどうかは、空にした者が決める */
export function sessionResetEvent(summary: string, triggerLlm: boolean): ConversationEvent {
  return {
    content: `<event type="session_reset">\n[Session Restored & Context Compressed]\n\n${summary}\n</event>`,
    meta: {
      type: 'event_log',
      trigger_llm: triggerLlm,
    },
  };
}

/**
 * 前の会話に戻った・保存から読み込んだ印。起こさない（切り替えは操作であって依頼ではない）。
 * その会話が最後に動いた時刻といまの時刻を並べ、見えている道具の定義を添える。
 */
export function sessionActivatedEvent(
  how: 'switched' | 'loaded',
  lastActivity: number,
  now: number,
  definitions: string[],
): ConversationEvent {
  const stamp = (ms: number) => new Date(ms).toISOString();
  const lines = [
    how === 'switched'
      ? `[System: Switched to an earlier session (last activity ${stamp(lastActivity)}). Time now: ${stamp(now)}.]`
      : `[System: Loaded a session from the VFS (last activity ${stamp(lastActivity)}). Time now: ${stamp(now)}.]`,
    'Files, processes and tool definitions may have changed since. Re-check before acting.',
  ];
  if (definitions.length > 0) {
    lines.push('The following tools are currently active from background processes:', definitions.join('\n'));
  }
  return {
    content: `<event type="session_${how}">\n${lines.join('\n')}\n</event>`,
    meta: {
      type: 'event_log',
      eventType: `session_${how}`,
      trigger_llm: false,
    },
  };
}
