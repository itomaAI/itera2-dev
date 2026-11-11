/**
 * src/core/cognitive/Projector.ts
 * Itera OS v2: State to Prompt Conversion（履歴 → 中立の要求）
 *
 * 層の向きは一方向:  履歴（ここ）→ 中立の要求（LlmRequest）→ 各社の本文（Renderer）→ 送信（Adapter）
 * ここが知っているのはエージェントのこと（システムプロンプトの組み立て・LPML の包み・道具の結果の書き方・
 * 送れなかった添付をエージェントにどう伝えるか）だけ。各社の器は知らない（T-0804）。
 */

import type { VfsService } from '../vfs/VfsService';
import type { ConfigManager } from '../sys/ConfigManager';
import type { HistoryManager, Turn } from '../state/HistoryManager';
import type { MediaRef } from '../types/content';
import { SYSTEM_PRINCIPAL } from '../vfs/types';
import { buildTextPromptNodes, buildToolPromptNodes, buildUserPromptNodes } from './PromptContentBuilder';
import { wrapUserInput } from './LpmlSerializer';
import type { LlmMessage, LlmPart, LlmRequest, MediaFailure } from './LlmRequest';
import type { BaseRenderer, MediaAttachFailure } from './Renderer';

/** 投影が読む状態（Engine の state と同じ形） */
export interface ProjectionState {
  history: HistoryManager;
  vfs: VfsService;
  configManager: ConfigManager;
}

/**
 * 添付を付けられなかったときに、代わりにプロンプトへ入れる注記。
 *
 * **黙って落とさないこと**と、**理由を取り違えないこと**の両方が要る。
 * 「VFS から読めなかった」と誤って出すと、実際には鍵が無いだけなのに保存先を疑わせる。
 */
export function buildMediaFailureNotice(path: string, reason: MediaAttachFailure): string {
  switch (reason) {
    case 'no_credentials':
      return `\n[System: The file '${path}' was NOT sent. This provider needs a file-upload API key, which is not configured or has expired.]\n`;
    case 'upload_failed':
      return `\n[System: The file '${path}' was NOT sent. Uploading it to the provider failed.]\n`;
    case 'missing':
    default:
      return `\n[System: The file '${path}' was NOT sent. It could not be loaded from VFS.]\n`;
  }
}

/** 上限を表示用に丸める（3.75 のような値も、無駄な桁を付けずに出す）。 */
function formatLimitMB(mb: number): string {
  return String(Math.round(mb * 100) / 100);
}

/** 上流が受け取れない添付（種類・大きさ）の代わりに、プロンプトへ入れる注記。 */
export function buildUnsupportedMediaNotice(
  path: string,
  mimeType: string,
  failure: { reason: 'mime' } | { reason: 'size'; limitMB: number },
): string {
  const reasonText =
    failure.reason === 'size'
      ? `it exceeds the file size limit (${formatLimitMB(failure.limitMB)}MB)`
      : `its format is not directly supported by this model's vision/file API`;

  return `\n[System: Attached file '${path}' (${mimeType}) cannot be processed directly because ${reasonText}. To analyze its content, please write and execute a script to process it from the VFS.]\n`;
}

/**
 * 送れなかった添付を、エージェントにどう伝えるか（Renderer に渡す `mediaFallback`）。
 * 注記は「スクリプトで VFS から読め」と促すので、送れなかったファイルもエージェントは別の道で扱える。
 */
export function agentMediaNotice(media: MediaRef, failure: MediaFailure): string {
  if (failure.reason === 'mime' || failure.reason === 'size') {
    return buildUnsupportedMediaNotice(media.path, media.mimeType, failure);
  }
  return buildMediaFailureNotice(media.path, failure.reason);
}

/** システムプロンプトの雛形に、利用者の設定とセッションの開始時刻を入れる。 */
export function buildSessionSystemPrompt(template: string, configManager: ConfigManager, turns: Turn[]): string {
  const prefs = configManager.get('preferences');
  const user = prefs?.username || 'User';
  const agent = prefs?.agentName || 'Itera';
  const language = prefs?.language || 'English';

  let effectivePrompt = template.replace(/{{language}}/g, language);
  effectivePrompt = effectivePrompt.replace(/{{agentName}}/g, agent);
  effectivePrompt = effectivePrompt.replace(/{{username}}/g, user);

  const firstTurn = turns.length > 0 ? turns[0] : null;
  const sessionStart = firstTurn ? new Date(firstTurn.timestamp) : new Date();

  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const timePrompt = `\n\n<system type="time">\nSession Started: ${sessionStart.toLocaleString()} (${days[sessionStart.getDay()]})\nTimestamp: ${sessionStart.toISOString()}\n</system>`;

  return effectivePrompt + timePrompt;
}

/** 履歴の 1 ターンを、中立の部品の並びにする（LPML の包み・道具の結果の直列化はここ）。 */
export function projectTurn(turn: Turn): LlmPart[] {
  if (typeof turn.content === 'string') {
    return [{ text: turn.role === 'user' ? wrapUserInput(turn.content) : turn.content }];
  }
  if (!Array.isArray(turn.content)) return [];

  if (turn.meta && turn.meta.type === 'tool_execution') {
    const parts: LlmPart[] = [];
    for (const node of buildToolPromptNodes(turn)) {
      if (!node.shouldEmit) continue;
      parts.push({ text: node.text });
      if (node.media) parts.push({ media: node.media });
    }
    return parts;
  }

  if (turn.role === 'user') {
    return buildUserPromptNodes(turn).map((node) =>
      node.kind === 'text' ? { text: node.text } : { media: node.media },
    );
  }

  return buildTextPromptNodes(turn).map((node) => ({ text: node.text }));
}

/**
 * 履歴を中立のメッセージの並びにする。部品の無いターンは送らない。
 * 履歴の `system` ターン（イベント・道具の結果）は、LLM から見ると利用者の側の発話。
 */
export function projectHistory(turns: Turn[]): LlmMessage[] {
  const messages: LlmMessage[] = [];
  for (const turn of turns) {
    const parts = projectTurn(turn);
    if (parts.length === 0) continue;
    messages.push({ role: turn.role === 'model' ? 'model' : 'user', parts });
  }
  return messages;
}

/**
 * エージェントの履歴を、選ばれている上流の本文にする。
 * 前半（履歴 → 中立の要求）はここ、後半（中立の要求 → 各社の本文）は Renderer。
 */
export class Projector {
  private systemPrompt: string;
  readonly renderer: BaseRenderer;

  constructor(systemPrompt: string, renderer: BaseRenderer) {
    this.systemPrompt = systemPrompt;
    this.renderer = renderer;
  }

  /** 履歴 → 中立の要求。 */
  createRequest(state: Pick<ProjectionState, 'history' | 'configManager'>): LlmRequest {
    const turns = [...state.history.get()];
    return {
      system: buildSessionSystemPrompt(this.systemPrompt, state.configManager, turns),
      messages: projectHistory(turns),
    };
  }

  /** 履歴 → 各社の本文（Adapter に渡す形）。添付はエージェントの権限で読み、送れなければ注記を入れる。 */
  async createContext(state: ProjectionState, signal?: AbortSignal): Promise<any> {
    return this.renderer.render(this.createRequest(state), {
      vfs: state.vfs,
      principal: SYSTEM_PRINCIPAL,
      signal,
      mediaFallback: agentMediaNotice,
    });
  }
}
