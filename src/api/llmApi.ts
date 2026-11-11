/**
 * src/api/llmApi.ts
 * Itera OS v2: MetaOS.llm（ゲストから LLM を 1 回呼ぶ口）の規則（T-0807）
 *
 * ここには純関数だけを置く。ホストの実体（組み立て・VFS・通知）に触るのは `LlmCalls` と HostApiRouter。
 *
 * この口は会話もエンジンも通らない: 渡された messages がそのまま中立の要求（`LlmRequest`）になり、
 * 上流の返事が戻る。LPML も道具も履歴も無い。設定（`config`）は呼び手が毎回渡す —— OS の `llm.json` は引き継がない
 * （引き継ぐと、利用者がチャットのモデルを替えたときに、関係のないアプリの挙動まで変わる）。
 */

import type { LlmMessage, LlmPart, LlmRequest } from '../core/cognitive/LlmRequest';
import { normalizeContent } from './chatApi';

/** 呼び出しの id（ゲストが採る）と tag の長さの上限 */
export const LLM_ID_MAX = 100;
export const LLM_TAG_MAX = 200;

export interface LlmCallPlan {
  id: string;
  /** `llm.json` と同じ形。`model` は `provider/model` */
  config: { model: string; [key: string]: unknown };
  request: LlmRequest;
  /** 台帳の行に書く、呼び手の任意の文字列。無ければ null */
  tag: string | null;
}

export type LlmCallParse = ({ ok: true } & LlmCallPlan) | { ok: false; reason: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * `llm:start` の要求（`{ id, request: { config, system, messages }, tag }`）を検査し、中立の要求にする。
 * メッセージの中身は `chat.append` と同じ形（文字列、または `{text}`／`{media:{path, mimeType?}}` の並び）。
 * ゲストが添付に付けてきた `metadata` は捨てる（上流へ上げたファイルの控えが入る場所で、呼び手に書かせない）。
 */
export function buildLlmCall(payload: unknown): LlmCallParse {
  if (!isPlainObject(payload)) return { ok: false, reason: 'invalid request' };
  const id = payload.id;
  if (typeof id !== 'string' || !id || id.length > LLM_ID_MAX) return { ok: false, reason: 'invalid call id' };

  const req = payload.request;
  if (!isPlainObject(req)) return { ok: false, reason: 'request must be { config, system?, messages }' };

  const config = req.config;
  if (!isPlainObject(config) || typeof config.model !== 'string' || !config.model.trim()) {
    return { ok: false, reason: "config.model is required (e.g. { model: 'provider/model' })" };
  }

  if (req.system !== undefined && req.system !== null && typeof req.system !== 'string') {
    return { ok: false, reason: 'system must be a string' };
  }

  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    return { ok: false, reason: 'messages must be a non-empty array' };
  }
  const messages: LlmMessage[] = [];
  for (const m of req.messages) {
    if (!isPlainObject(m)) return { ok: false, reason: 'each message must be { role, content }' };
    if (m.role !== 'user' && m.role !== 'model') return { ok: false, reason: "role must be 'user' or 'model'" };
    const normalized = normalizeContent(m.content);
    if (!normalized.ok) return { ok: false, reason: normalized.reason };
    const parts: LlmPart[] = normalized.parts.map((p) =>
      typeof p.text === 'string'
        ? { text: p.text }
        : { media: { path: p.media.path, mimeType: p.media.mimeType, metadata: {} } },
    );
    messages.push({ role: m.role, parts });
  }

  const request: LlmRequest = { messages };
  if (typeof req.system === 'string') request.system = req.system;

  const tag = typeof payload.tag === 'string' && payload.tag.trim() ? payload.tag.trim().slice(0, LLM_TAG_MAX) : null;
  return { ok: true, id, config: { ...config, model: config.model.trim() }, request, tag };
}

/** 失敗の種類。`aborted`＝呼び手が止めた・プロセスが終わった／`media`＝送れない添付がある／`failed`＝それ以外 */
export type LlmErrorCode = 'aborted' | 'media' | 'failed';

export function llmErrorOf(err: unknown, aborted: boolean): { message: string; code: LlmErrorCode } {
  const e = err as { name?: unknown; message?: unknown } | null;
  if (aborted || e?.name === 'AbortError') return { message: 'Aborted', code: 'aborted' };
  const message = typeof e?.message === 'string' && e.message ? e.message : String(err);
  return { message, code: e?.name === 'LlmMediaError' ? 'media' : 'failed' };
}
