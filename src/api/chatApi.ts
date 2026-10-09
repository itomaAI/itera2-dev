/**
 * src/api/chatApi.ts
 * Itera OS v2: MetaOS.chat（ゲストからの会話操作）の規則（T-0634）
 *
 * ここには純関数だけを置く。ホストの実体（Engine / HistoryManager / SessionManager）に触るのは HostApiRouter。
 * `ai.ask / ai.task / ai.log` は guest_bridge.js の側でこの口（chat.append）の薄皮として組まれている。
 */

import type { Turn, TurnContent, TurnMeta } from '../core/state/HistoryManager';
import { SYSTEM_PRINCIPAL, type Principal } from '../core/vfs/types';

export type ChatRole = 'user' | 'system';

export interface ChatAppendOpts {
  /** 起こすか（履歴の `trigger_llm`）。既定 false */
  wake?: boolean;
  /** 画面に出すか。既定 true */
  visible?: boolean;
  /** system のとき `<event type="…">` の種類（画面で隠す判定に使う）。既定 'app_event' */
  eventType?: string;
  /** VFS の添付。`{media}` と `<user_attachment>` の注記に展開する */
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
  /** 空にしたあと起こすか。既定 true（起動手順を踏んで戻ってくるため） */
  wake?: boolean;
  /** 走っているアプリ・デーモンの道具の定義を積み直すか。既定 true */
  restoreTools?: boolean;
}

export interface ChatResetPlan {
  summary: string;
  wake: boolean;
  restoreTools: boolean;
}

/** `system/logs/usage/` の 1 行から読む「直近の文脈の長さ」 */
export interface ContextUsage {
  /** モデルに渡した長さ（input ＋ cached ＋ cacheWrite）。出力は含めない */
  tokens: number;
  output: number;
  model: string | null;
  at: string;
}

export interface ChatStatus {
  running: boolean;
  busy: boolean;
  outstandingTools: number;
  turns: number;
  lastTurnAt: number | null;
  session: { id: string; title: string; createdAt: number } | null;
  /** 観測は 1 ターン遅れる（ログは応答のあとに書かれる）。読めなければ null */
  context: ContextUsage | null;
}

/** 添付の MIME。従来（ai:ask）と同じ判定: 画像の拡張子なら image/png、それ以外は octet-stream */
export function mimeOfAttachment(path: string): string {
  return /\.(png|jpg|jpeg|gif|webp)$/i.test(path) ? 'image/png' : 'application/octet-stream';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * `content`（文字列 または parts の配列）を履歴の TurnContent に正規化する。
 * 文字列は `{text}` 1 つ。配列は `{text}` / `{media:{path, mimeType?}}` だけを受け、それ以外は断る。
 */
function normalizeContent(content: unknown): { ok: true; parts: any[] } | { ok: false; reason: string } {
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
 * `source` は呼び手の pid。履歴の meta に残す（画面と LLM が出どころを見分けられる）。
 */
export function buildAppendPlan(req: ChatAppendRequest, source: string): ChatAppendPlan {
  const role = req.role;
  if (role !== 'user' && role !== 'system') return { ok: false, reason: "role must be 'user' or 'system'" };
  const opts = isPlainObject(req.opts) ? (req.opts as ChatAppendOpts) : {};
  const wake = opts.wake === true;
  const visible = opts.visible !== false;

  const attachments = Array.isArray(opts.attachments)
    ? opts.attachments.filter((p): p is string => typeof p === 'string' && p.length > 0)
    : [];
  const normalized = normalizeContent(req.content);
  if (!normalized.ok) return normalized;

  const content: any[] = [];
  for (const path of attachments) content.push({ media: { path, mimeType: mimeOfAttachment(path), metadata: {} } });
  for (const path of attachments)
    content.push({ text: `<user_attachment path="${path}">[Attachment]</user_attachment>` });
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
    wake: o.wake !== false,
    restoreTools: o.restoreTools !== false,
  };
}

/**
 * usage ログ（jsonl）の末尾から直近の 1 件を読む。壊れた行・tokens の無い行は飛ばす。
 * 文脈の長さは input ＋ cached ＋ cacheWrite（モデルに渡した分）。
 */
export function latestContextUsage(jsonl: string): ContextUsage | null {
  const lines = jsonl.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const t = e && isPlainObject(e.tokens) ? e.tokens : null;
    if (!t) continue;
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const tokens = n(t.input) + n(t.cached) + n(t.cacheWrite);
    return {
      tokens,
      output: n(t.output),
      model: typeof e.model === 'string' ? e.model : null,
      at: typeof e.timestamp === 'string' ? e.timestamp : '',
    };
  }
  return null;
}

export interface ChatStatusInput {
  engine: { running: boolean; busy: boolean; outstandingTools: number };
  turns: Turn[];
  session: { id: string; title: string; createdAt: number } | null;
  context: ContextUsage | null;
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
    context: input.context,
  };
}

/** usage ログを読むのに要る VFS の口（VfsService が満たす） */
export interface UsageLogReader {
  exists(principal: Principal, path: string): boolean;
  readFile(principal: Principal, path: string): Promise<string>;
}

/**
 * 直近の文脈の長さを usage ログから読む。ログは UTC の日付で切られ、応答のあとに書かれる（観測は 1 ターン遅れる）。
 * 今日に無ければ昨日を読む。読めなければ null（推測値は返さない）。
 */
export async function readLatestContextUsage(
  vfs: UsageLogReader,
  now: number = Date.now(),
): Promise<ContextUsage | null> {
  for (const back of [0, 1]) {
    const day = new Date(now - back * 86400000).toISOString().slice(0, 10);
    const path = `system/logs/usage/${day}.jsonl`;
    try {
      if (!vfs.exists(SYSTEM_PRINCIPAL, path)) continue;
      const found = latestContextUsage(await vfs.readFile(SYSTEM_PRINCIPAL, path));
      if (found) return found;
    } catch {
      /* 読めなければ無いのと同じ */
    }
  }
  return null;
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
  lagsOneTurn: string;
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
  lagsOneTurn: 'lags one turn',
  unknown: 'unknown (no usage log yet)',
};

/** chat.status を人向けの 3 行にする（`/status` の本文。語は labels から） */
export function formatChatStatus(s: ChatStatus, now: number = Date.now(), L: StatusLabels = STATUS_LABELS_EN): string {
  const age = s.lastTurnAt ? Math.round((now - s.lastTurnAt) / 60000) : null;
  const ctx = s.context
    ? `${s.context.tokens.toLocaleString('en-US')} ${L.tokensIn} (${s.context.model || '?'}, ${s.context.at}; ${L.lagsOneTurn})`
    : L.unknown;
  const title = s.session ? (s.session.title ? `"${s.session.title}"` : L.untitled) : '-';
  const last = age === null ? '' : `, ${L.lastTurnMinAgo.replace('{n}', String(age))}`;
  return [
    `${L.engine}: ${s.running ? L.running : L.idle}${s.busy ? ` / ${L.busy}` : ''} (${L.toolsInFlight}: ${s.outstandingTools})`,
    `${L.session}: ${title}, ${s.turns} ${L.turns}${last}`,
    `${L.context}: ${ctx}`,
  ].join('\n');
}

/** chat.reset / `/reset` が使う実体の口 */
export interface ResetDeps {
  engine: { stop(): void; requestEvaluation(): void };
  sessionManager: {
    clearSession(opts: { summary?: string; triggerLlm?: boolean; restoreTools?: boolean }): Promise<{
      archived: boolean;
      sessionId: string;
    }>;
  };
}

/**
 * 会話を空にして（必要なら）起こす。chat:reset と /reset の両方がここを通る（手順を 2 か所に置かない）。
 *
 * 🔴 `engine.stop()` は停止要求（`stopRequested`）を立て、それが立っている間は履歴の変更が評価を予約しない。
 * `clearSession` が積む申し送り（`trigger_llm: true`）はその経路で黙って捨てられるので、
 * **止めたあとに空にしたら `requestEvaluation()` で明示的に起こす**（2026-10-10 山内さん「/reset は起こさない」で発覚）。
 * `<reset_session>` 道具は stop を呼ばないので、この一手が無くても起きていた。
 */
export async function runChatReset(
  deps: ResetDeps,
  plan: ChatResetPlan,
): Promise<{ archived: boolean; sessionId: string }> {
  deps.engine.stop();
  const r = await deps.sessionManager.clearSession({
    summary: plan.summary,
    triggerLlm: plan.wake,
    restoreTools: plan.restoreTools,
  });
  if (plan.wake) deps.engine.requestEvaluation();
  return r;
}
