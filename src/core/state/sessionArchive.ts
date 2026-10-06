/**
 * src/core/state/sessionArchive.ts
 * Itera OS v2: 会話のセッションを退避・剪定・出し入れするための純関数（T-0613）
 *
 * 置き場（IndexedDB `itera_history_v2` / store `state`）のキー:
 *   turns          … いまの会話（従来どおり。古いビルドもここを読む）
 *   current_meta   … いまの会話の札 { id, createdAt }
 *   sessions_index … 退避した会話の札の配列（SessionMeta[]）
 *   session:<id>   … 退避した会話のターン配列
 *
 * ここには判断の規則だけを置く（IDB の読み書きは HistoryManager、手順は SessionManager）。
 * 試験はこのファイルに集める。
 */

import type { Turn, TurnMeta } from './HistoryManager';
import { isMediaContentNode, isToolExecutionEntry } from './TurnContentNormalizer';

/** 退避した会話の札。一覧はこれだけで描ける（ターンを読まない） */
export interface SessionMeta {
  id: string;
  /** 最初の利用者の発言の先頭（無ければ空文字。表示側が日時で代える） */
  title: string;
  createdAt: number;
  /** 最後のターンの時刻。「最後に触った順」の根拠 */
  updatedAt: number;
  turnCount: number;
  /** ターン配列を JSON にしたときの文字数（おおよその大きさ） */
  bytes: number;
  /** この会話が参照する添付（system/temp/media/…）。添付の掃除で毎回ターンを読まないため */
  mediaPaths: string[];
}

/** いまの会話の札 */
export interface CurrentSessionMeta {
  id: string;
  createdAt: number;
}

/** VFS へ書き出す形。ターンは加工しない（戻したとき投影の前置が変わらない） */
export const SESSION_EXPORT_FORMAT = 'itera-session/1';

export interface SessionExport {
  format: typeof SESSION_EXPORT_FORMAT;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  savedAt: number;
  turnCount: number;
  turns: Turn[];
}

/** 剪定で残す件数の既定。依頼が数字を言っているのでここだけ既定を持つ（`preferences.sessionHistoryKeep` で変える） */
export const DEFAULT_SESSION_HISTORY_KEEP = 10;

/** 題にする文字数 */
export const TITLE_MAX_CHARS = 40;

const ROLES = new Set(['user', 'model', 'system']);

/** `preferences.sessionHistoryKeep` を整える。数でない・負なら既定 */
export function normalizeKeep(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return DEFAULT_SESSION_HISTORY_KEEP;
  return Math.floor(value);
}

/**
 * 何も話していない会話か。利用者か私の発言が 1 つも無ければ空とみなす
 * （リセット直後の `tool_available` や引き継ぎの印だけの会話を退避しても、一覧に同じものが並ぶだけ）。
 */
export function isEmptySession(turns: Turn[]): boolean {
  return !turns.some((t) => t.role === 'user' || t.role === 'model');
}

/** ターンの本文を文字列に寄せる（題の導出に使う。添付の XML は外す） */
function textOf(turn: Turn): string {
  if (typeof turn.content === 'string') return turn.content;
  if (!Array.isArray(turn.content)) return '';
  return turn.content
    .map((node) =>
      node && typeof (node as { text?: unknown }).text === 'string' ? (node as { text: string }).text : '',
    )
    .join('\n');
}

/**
 * 題を導く: 最初の利用者の発言の、添付の印（<user_attachment …>…）を除いた本文の先頭 40 字。
 * 利用者の発言が無ければ空文字（表示側が日時で代える）。
 */
export function deriveTitle(turns: Turn[]): string {
  for (const turn of turns) {
    if (turn.role !== 'user') continue;
    const text = textOf(turn)
      .replace(/<user_attachment\b[^>]*>[\s\S]*?<\/user_attachment>/g, ' ')
      .replace(/<user_attachment\b[^>]*\/>/g, ' ')
      .replace(/<\/?user_input[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    const chars = Array.from(text);
    return chars.length > TITLE_MAX_CHARS ? chars.slice(0, TITLE_MAX_CHARS).join('') + '…' : text;
  }
  return '';
}

/** 会話が参照する添付のパス（利用者の添付と、ツールの結果の media の両方）。重複は 1 つに */
export function collectMediaPaths(turns: Turn[]): string[] {
  const out = new Set<string>();
  for (const turn of turns) {
    if (!Array.isArray(turn.content)) continue;
    for (const node of turn.content) {
      if (isMediaContentNode(node)) out.add(node.media.path);
      else if (isToolExecutionEntry(node) && node.output?.media?.path) out.add(node.output.media.path);
    }
  }
  return [...out];
}

/** 札を組む。updatedAt は最後のターンの時刻（無ければ createdAt） */
export function buildSessionMeta(id: string, createdAt: number, turns: Turn[]): SessionMeta {
  const last = turns.length > 0 ? turns[turns.length - 1] : null;
  return {
    id,
    title: deriveTitle(turns),
    createdAt,
    updatedAt: last ? last.timestamp : createdAt,
    turnCount: turns.length,
    bytes: JSON.stringify(turns).length,
    mediaPaths: collectMediaPaths(turns),
  };
}

/** 新しい順（updatedAt 降順）。同じ時刻は id で安定させる */
export function sortSessions(index: SessionMeta[]): SessionMeta[] {
  return [...index].sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** `keep` 件を超えた分を古い方から剪定の対象にする */
export function pruneSessions(index: SessionMeta[], keep: number): { kept: SessionMeta[]; pruned: SessionMeta[] } {
  const sorted = sortSessions(index);
  const k = Math.max(0, Math.floor(keep));
  return { kept: sorted.slice(0, k), pruned: sorted.slice(k) };
}

/**
 * 掃除してよい添付: 置き場にあるファイルのうち、残る会話（退避中の会話といまの会話）のどれにも参照されていないもの。
 * 「誰も参照していないものを消す」の 1 つの規則で、リセット・剪定・削除・切り替えのすべてを賄う。
 */
export function unreferencedMedia(filesInStore: string[], referencedPaths: Iterable<string>): string[] {
  const keep = new Set(referencedPaths);
  return filesInStore.filter((p) => !keep.has(p));
}

/** 退避中の会話といまの会話が参照する添付の和 */
export function referencedMediaPaths(index: SessionMeta[], currentTurns: Turn[]): Set<string> {
  const out = new Set<string>();
  for (const meta of index) for (const p of meta.mediaPaths || []) out.add(p);
  for (const p of collectMediaPaths(currentTurns)) out.add(p);
  return out;
}

/** VFS へ書き出す形を組む */
export function buildSessionExport(meta: CurrentSessionMeta, turns: Turn[], savedAt: number): SessionExport {
  const m = buildSessionMeta(meta.id, meta.createdAt, turns);
  return {
    format: SESSION_EXPORT_FORMAT,
    id: m.id,
    title: m.title,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    savedAt,
    turnCount: m.turnCount,
    turns,
  };
}

function isTurn(value: unknown): value is Turn {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || typeof v.timestamp !== 'number') return false;
  if (typeof v.role !== 'string' || !ROLES.has(v.role)) return false;
  if (!(typeof v.content === 'string' || Array.isArray(v.content))) return false;
  if (v.meta !== undefined && (typeof v.meta !== 'object' || v.meta === null)) return false;
  return true;
}

export type ParsedSessionImport =
  { ok: true; id: string; createdAt: number; turns: Turn[] } | { ok: false; reason: string };

/**
 * 読み込んだ JSON を検査する。形が違えば理由を返して拒む（黙って空の会話にしない）。
 * `meta` が無いターンは `{}` で埋める（古い書き出しへの備え）。
 */
export function parseSessionImport(text: string): ParsedSessionImport {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: `not JSON (${(e as Error).message})` };
  }
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'not an object' };
  const r = raw as Record<string, unknown>;
  if (r.format !== SESSION_EXPORT_FORMAT) {
    return { ok: false, reason: `unsupported format: ${JSON.stringify(r.format ?? null)}` };
  }
  if (!Array.isArray(r.turns)) return { ok: false, reason: 'turns is not an array' };
  const turns: Turn[] = [];
  for (let i = 0; i < r.turns.length; i++) {
    const t = r.turns[i];
    if (!isTurn(t)) return { ok: false, reason: `turn #${i + 1} has an invalid shape` };
    turns.push({ ...t, meta: (t.meta ?? {}) as TurnMeta });
  }
  const id = typeof r.id === 'string' && r.id ? r.id : '';
  const createdAt =
    typeof r.createdAt === 'number' && Number.isFinite(r.createdAt)
      ? r.createdAt
      : turns.length > 0
        ? turns[0].timestamp
        : Date.now();
  return { ok: true, id, createdAt, turns };
}

/** 既定のファイル名: `YYYYMMDD_HHMM_<題の先頭>.json`（題は名前に使える字だけ残す） */
export function defaultExportName(meta: { title: string; updatedAt: number }, now: Date = new Date()): string {
  const d = new Date(meta.updatedAt || now.getTime());
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  const slug = Array.from(
    meta.title
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
    .slice(0, 24)
    .join('')
    .trim()
    .replace(/\s/g, '_');
  return slug ? `${stamp}_${slug}.json` : `${stamp}.json`;
}
