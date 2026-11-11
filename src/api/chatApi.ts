/**
 * src/api/chatApi.ts
 * Itera OS v2: MetaOS.chat（ゲストからの会話操作）の規則（T-0634）
 *
 * ここには純関数だけを置く。ホストの実体（Engine / HistoryManager / SessionManager）に触るのは HostApiRouter。
 * `ai.ask / ai.task / ai.log` は guest_bridge.js の側でこの口（chat.append）の薄皮として組まれている。
 */

import type { Turn, TurnContent, TurnMeta } from '../core/state/HistoryManager';
import {
  decideAttachment,
  mimeOfPath,
  renderUserAttachmentNode,
  type AttachmentDecision,
} from '../core/chat/attachmentGate';
import { ATTACHMENT_POLICY } from '../config/attachment_policy';

export type ChatRole = 'user' | 'system';

export interface ChatAppendOpts {
  /** 起こすか（履歴の `trigger_llm`）。既定 false */
  wake?: boolean;
  /** 画面に出すか。既定 true */
  visible?: boolean;
  /** system のとき `<event type="…">` の種類（画面で隠す判定に使う）。既定 'app_event' */
  eventType?: string;
  /** VFS の添付。添付の門（core/chat/attachmentGate）を通し、画像・PDF は `{media}`、文字は先頭だけ本文に展開する */
  attachments?: string[];
}

export interface ChatAppendRequest {
  role: unknown;
  content: unknown;
  opts?: ChatAppendOpts | null;
}

export type ChatAppendPlan =
  | { ok: true; role: ChatRole; content: TurnContent; meta: TurnMeta; wake: boolean; visible: boolean }
  | { ok: false; reason: string };

export interface ChatResetOpts {
  summary?: string;
  /** 走っているアプリ・デーモンの道具の定義を積み直すか。既定 true */
  restoreTools?: boolean;
}

/**
 * reset は AI を起こさない。Engine は「止めたら利用者が次に発言するまで起きない」設計で、
 * reset は走っている生成を止めてから会話を空にするので、申し送りを trigger_llm で積んでも起きない（捨てられる）。
 * 意図と実装を揃え、申し送りは置くだけにする —— 次の発言（チャット欄でも Telegram でも）で AI が起き、申し送りを読む
 * （2026-10-10 山内さん）。
 */
export interface ChatResetPlan {
  summary: string;
  restoreTools: boolean;
}

/** 1 回の生成で、モデルに渡した長さと出力 */
export interface ContextSample {
  /** その返事を始めた時刻（ISO） */
  at: string;
  /** モデルに渡した長さ（input ＋ cached ＋ cacheWrite）。出力は含めない */
  tokens: number;
  output: number;
}

/**
 * いまの会話の文脈の長さ。**履歴**の最後の「usage を持つ model ターン」から読む（T-0806）。
 * 台帳（`system/logs/usage/`）は読まない —— 台帳は OS 全体の使用量で、どの会話のものかを答える場所ではない。
 */
export interface ContextUsage extends ContextSample {
  model: string | null;
  /** いま選んでいるモデルの文脈の上限（トークン）。モデルの一覧に書いてなければ null（推測しない） */
  limit: number | null;
  /** 直近の生成（新しい順・最大 `CONTEXT_RECENT_MAX`。先頭はこの値自身）。伸び方を見るため */
  recent: ContextSample[];
}

export const CONTEXT_RECENT_MAX = 10;

export interface ChatStatus {
  running: boolean;
  busy: boolean;
  outstandingTools: number;
  turns: number;
  lastTurnAt: number | null;
  session: { id: string; title: string; createdAt: number } | null;
  /** 最後の返事の時点の値（そのあとに積まれたターンは含まない）。この会話でまだ返事が無ければ null */
  context: ContextUsage | null;
}

/** 添付の MIME（パスだけから。画像と PDF は正しい種別、文字の候補は text/plain、他は octet-stream） */
export function mimeOfAttachment(path: string): string {
  return mimeOfPath(path);
}

/** `opts.attachments` のうち使える形のもの（文字列・空でない） */
export function attachmentPathsOf(opts: unknown): string[] {
  if (!isPlainObject(opts) || !Array.isArray(opts.attachments)) return [];
  return opts.attachments.filter((p): p is string => typeof p === 'string' && p.length > 0);
}

export interface ResolvedAttachment {
  path: string;
  decision: AttachmentDecision;
}

/**
 * 添付のパスごとに門の判定を取る（API 経路）。中身を読むのは文字の候補だけ、しかも上限以内のとき。
 * `read` は VFS から大きさとバイト列を返す。読めなければ null（→ 'unreadable' の注記になる。投げない）。
 */
export async function resolveAttachments(
  paths: string[],
  read: (path: string) => Promise<{ size: number; bytes: () => Promise<Uint8Array> } | null>,
): Promise<ResolvedAttachment[]> {
  const out: ResolvedAttachment[] = [];
  for (const path of paths) {
    const probe = decideAttachment({ name: path, size: 0 }, null);
    if (probe.route === 'media' && ATTACHMENT_POLICY.media.maxBytes === undefined) {
      out.push({ path, decision: probe }); // 大きさを見ない方針なら画像の実体に触らない
      continue;
    }
    let decision: AttachmentDecision;
    try {
      const f = await read(path);
      if (!f) decision = decideAttachment({ name: path, size: 0 }, null);
      else {
        // 中身を読むのは文字の候補だけ（stored・media は大きさだけ）
        const bytes =
          probe.route !== 'media' && probe.route !== 'stored' && f.size <= ATTACHMENT_POLICY.inline.skipAboveBytes
            ? await f.bytes()
            : null;
        decision = decideAttachment({ name: path, size: f.size }, bytes);
      }
    } catch {
      decision = decideAttachment({ name: path, size: 0 }, null);
    }
    out.push({ path, decision });
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * `content`（文字列 または parts の配列）を履歴の TurnContent に正規化する。
 * 文字列は `{text}` 1 つ。配列は `{text}` / `{media:{path, mimeType?}}` だけを受け、それ以外は断る。
 */
export function normalizeContent(content: unknown): { ok: true; parts: any[] } | { ok: false; reason: string } {
  if (typeof content === 'string') return { ok: true, parts: content ? [{ text: content }] : [] };
  if (content === undefined || content === null) return { ok: true, parts: [] };
  if (!Array.isArray(content)) return { ok: false, reason: 'content must be a string or an array of parts' };
  const parts: any[] = [];
  for (const p of content) {
    if (!isPlainObject(p)) return { ok: false, reason: 'each part must be {text} or {media}' };
    if (typeof p.text === 'string') {
      parts.push({ text: p.text });
      continue;
    }
    if (isPlainObject(p.media) && typeof p.media.path === 'string' && p.media.path) {
      const path = p.media.path;
      const mimeType =
        typeof p.media.mimeType === 'string' && p.media.mimeType ? p.media.mimeType : mimeOfAttachment(path);
      parts.push({ media: { path, mimeType, metadata: isPlainObject(p.media.metadata) ? p.media.metadata : {} } });
      continue;
    }
    return { ok: false, reason: 'each part must be {text} or {media:{path}}' };
  }
  return { ok: true, parts };
}

/**
 * chat.append の要求をターン 1 つの計画にする。
 * 添付は従来の ai:ask と同じ並び（media を全部 → `<user_attachment>` の注記を全部 → 本文）。
 * 文字の添付は注記の中に先頭だけ展開される（門の判定は `resolved` で渡す。無ければ中身を読まない判定）。
 * `source` は呼び手の pid。履歴の meta に残す（画面と LLM が出どころを見分けられる）。
 */
export function buildAppendPlan(
  req: ChatAppendRequest,
  source: string,
  resolved?: ResolvedAttachment[],
): ChatAppendPlan {
  const role = req.role;
  if (role !== 'user' && role !== 'system') return { ok: false, reason: "role must be 'user' or 'system'" };
  const opts = isPlainObject(req.opts) ? (req.opts as ChatAppendOpts) : {};
  const wake = opts.wake === true;
  const visible = opts.visible !== false;

  const attachments =
    resolved ??
    attachmentPathsOf(opts).map((path) => ({ path, decision: decideAttachment({ name: path, size: 0 }, null) }));
  const normalized = normalizeContent(req.content);
  if (!normalized.ok) return normalized;

  const content: any[] = [];
  for (const a of attachments) {
    if (a.decision.route === 'media')
      content.push({ media: { path: a.path, mimeType: a.decision.mimeType, metadata: {} } });
  }
  for (const a of attachments) {
    const name = a.path.split('/').pop() || a.path;
    content.push({ text: renderUserAttachmentNode(a.decision, { name, path: a.path }) });
  }
  content.push(...normalized.parts);
  if (content.length === 0) return { ok: false, reason: 'content is empty' };

  const meta: TurnMeta = { trigger_llm: wake, source };
  if (role === 'system') {
    meta.type = 'event_log';
    meta.eventType = typeof opts.eventType === 'string' && opts.eventType ? opts.eventType : 'app_event';
  }
  if (!visible) meta.visible = false;
  return { ok: true, role, content, meta, wake, visible };
}

/** chat.reset の要求を正規化する。summary の頭に呼び手を付ける（`<reset_session>` 道具と同じ形で起動手順を促す） */
export function buildResetPlan(opts: ChatResetOpts | null | undefined, source: string): ChatResetPlan {
  const o = isPlainObject(opts) ? (opts as ChatResetOpts) : {};
  const carried = typeof o.summary === 'string' ? o.summary.trim() : '';
  let summary = `[System: Session reset by ${source}]\nPlease run the Initialization Protocol first.`;
  if (carried) summary += `\n\n[Carried Over Information]\n${carried}`;
  return {
    summary,
    restoreTools: o.restoreTools !== false,
  };
}

/**
 * 履歴から、いまの会話の文脈の長さを読む。
 * 見るのは model ターンの `meta.usage`（エンジンが生成の結果を置く）。持たないターン（失敗・中断・上流が usage を
 * 返さなかった生成・この版より前の履歴）は飛ばす。1 つも無ければ null（推測値は返さない）。
 */
export function contextFromHistory(turns: Turn[], limit: number | null): ContextUsage | null {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const recent: ContextSample[] = [];
  let model: string | null = null;
  for (let i = turns.length - 1; i >= 0 && recent.length < CONTEXT_RECENT_MAX; i--) {
    const turn = turns[i];
    if (!turn || turn.role !== 'model') continue;
    const u = turn.meta ? turn.meta.usage : null;
    if (!isPlainObject(u)) continue;
    if (recent.length === 0) model = typeof turn.meta.model === 'string' ? turn.meta.model : null;
    recent.push({
      at: new Date(turn.timestamp).toISOString(),
      tokens: n(u.input) + n(u.cached) + n(u.cacheWrite),
      output: n(u.output),
    });
  }
  if (recent.length === 0) return null;
  return { ...recent[0], model, limit, recent };
}

export interface ChatStatusInput {
  engine: { running: boolean; busy: boolean; outstandingTools: number };
  turns: Turn[];
  session: { id: string; title: string; createdAt: number } | null;
  /** いま選んでいるモデルの文脈の上限。分からなければ null */
  contextLimit: number | null;
}

export function buildChatStatus(input: ChatStatusInput): ChatStatus {
  const last = input.turns.length > 0 ? input.turns[input.turns.length - 1] : null;
  return {
    running: input.engine.running,
    busy: input.engine.busy,
    outstandingTools: input.engine.outstandingTools,
    turns: input.turns.length,
    lastTurnAt: last ? last.timestamp : null,
    session: input.session,
    context: contextFromHistory(input.turns, input.contextLimit),
  };
}

/** `/status` の文面の語（配布物ごとに差し替える。共通部品に文言を埋めない） */
export interface StatusLabels {
  engine: string;
  running: string;
  idle: string;
  busy: string;
  toolsInFlight: string;
  session: string;
  untitled: string;
  turns: string;
  lastTurnMinAgo: string;
  context: string;
  tokensIn: string;
  unknown: string;
}

export const STATUS_LABELS_EN: StatusLabels = {
  engine: 'engine',
  running: 'running',
  idle: 'idle',
  busy: 'busy',
  toolsInFlight: 'tools in flight',
  session: 'session',
  untitled: 'untitled',
  turns: 'turns',
  lastTurnMinAgo: 'last turn {n} min ago',
  context: 'context',
  tokensIn: 'tokens in',
  unknown: 'unknown (no reply yet)',
};

/** chat.status を人向けの 3 行にする（`/status` の本文。語は labels から） */
export function formatChatStatus(s: ChatStatus, now: number = Date.now(), L: StatusLabels = STATUS_LABELS_EN): string {
  const age = s.lastTurnAt ? Math.round((now - s.lastTurnAt) / 60000) : null;
  const num = (v: number) => v.toLocaleString('en-US');
  const ctx = s.context
    ? `${num(s.context.tokens)}${s.context.limit ? ` / ${num(s.context.limit)}` : ''} ${L.tokensIn} (${s.context.model || '?'}, ${s.context.at})`
    : L.unknown;
  const title = s.session ? (s.session.title ? `"${s.session.title}"` : L.untitled) : '-';
  const last = age === null ? '' : `, ${L.lastTurnMinAgo.replace('{n}', String(age))}`;
  return [
    `${L.engine}: ${s.running ? L.running : L.idle}${s.busy ? ` / ${L.busy}` : ''} (${L.toolsInFlight}: ${s.outstandingTools})`,
    `${L.session}: ${title}, ${s.turns} ${L.turns}${last}`,
    `${L.context}: ${ctx}`,
  ].join('\n');
}
