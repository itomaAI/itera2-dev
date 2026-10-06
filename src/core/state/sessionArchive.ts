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
import { isMediaContentNode, isTextContentNode, isToolExecutionEntry } from './TurnContentNormalizer';

/** 退避した会話の札。一覧はこれだけで描ける（ターンを読まない） */
export interface SessionMeta {
  id: string;
  /** 利用者が付けた題（無ければ空文字。表示側が会話の始まりの時刻で代える。2026-10-06 山内さん: 最初の発言は題にしない） */
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
  /** 利用者が付けた題（無ければ空文字） */
  title?: string;
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

/** 添付の置き場の根。会話ごとに `<根>/<sessionId>/`（端末に属する。同期しない。2026-10-06 山内さん） */
export const SESSIONS_TEMP_DIR = 'system/temp/sessions';
/** この版より前の添付の置き場。移行はしない（会話はこのパスで参照したまま。参照されなくなれば消える） */
export const LEGACY_MEDIA_DIR = 'system/temp/media';
/** 保存のディレクトリの中の会話の本体と、添付の置き場 */
export const EXPORT_SESSION_FILE = 'session.json';
export const EXPORT_MEDIA_DIR = 'media';

/** 会話の添付の置き場 */
export function sessionMediaDir(sessionId: string): string {
  return `${SESSIONS_TEMP_DIR}/${sessionId}`;
}

/** `system/temp/` の下の添付か（保存に同梱する・読み込みで付け替える対象） */
export function isTempAttachment(path: string): boolean {
  return path.startsWith('system/temp/');
}

/** 剪定で残す件数の既定。依頼が数字を言っているのでここだけ既定を持つ（`preferences.sessionHistoryKeep` で変える） */
export const DEFAULT_SESSION_HISTORY_KEEP = 10;

/** 題の長さの上限（付け替えのとき切る） */
export const TITLE_MAX_CHARS = 80;

/** 利用者が入れた題を整える: 前後の空白を落とし、改行は空白に、上限で切る */
export function normalizeTitle(value: unknown): string {
  if (typeof value !== 'string') return '';
  const t = value.replace(/\s+/g, ' ').trim();
  const chars = Array.from(t);
  return chars.length > TITLE_MAX_CHARS ? chars.slice(0, TITLE_MAX_CHARS).join('') : t;
}

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

/** 会話が参照する添付のうち `system/temp/` の下のもの（本文の `<user_attachment path="…">` も数える。テキストの添付はそこにしか無い） */
export function collectTempAttachmentPaths(turns: Turn[]): string[] {
  const out = new Set<string>();
  for (const p of collectMediaPaths(turns)) if (isTempAttachment(p)) out.add(p);
  for (const turn of turns) {
    const texts: string[] = [];
    if (typeof turn.content === 'string') texts.push(turn.content);
    else if (Array.isArray(turn.content)) {
      for (const node of turn.content) if (isTextContentNode(node)) texts.push(node.text);
    }
    for (const text of texts) {
      for (const m of text.matchAll(/<user_attachment\b[^>]*\bpath="([^"]+)"/g)) {
        if (isTempAttachment(m[1])) out.add(m[1]);
      }
    }
  }
  return [...out];
}

const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/**
 * 読み込みで添付の参照を新しい置き場へ向ける。`system/temp/` の下のパスで、名前が `available` に在るものだけを
 * `<targetDir>/<名前>` に付け替える（`media.path`・ツールの結果の `output.media.path`・本文の `<user_attachment path="…">`）。
 * それ以外のパス（VFS の別の場所への参照）は触らない。ターンは新しい配列・新しいオブジェクトで返す（元は変えない）。
 */
export function relocateTempAttachments(turns: Turn[], targetDir: string, available: Iterable<string>): Turn[] {
  const names = new Set(available);
  const map = (p: string): string => {
    if (!isTempAttachment(p)) return p;
    const n = basename(p);
    return names.has(n) ? `${targetDir}/${n}` : p;
  };
  const mapText = (text: string): string =>
    text.replace(/(<user_attachment\b[^>]*\bpath=")([^"]+)(")/g, (_m, a, p, c) => `${a}${map(p)}${c}`);
  return turns.map((turn) => {
    if (typeof turn.content === 'string') return { ...turn, content: mapText(turn.content) };
    if (!Array.isArray(turn.content)) return turn;
    const content = turn.content.map((node) => {
      if (isTextContentNode(node)) return { ...node, text: mapText(node.text) };
      if (isMediaContentNode(node)) return { ...node, media: { ...node.media, path: map(node.media.path) } };
      if (isToolExecutionEntry(node) && node.output?.media?.path) {
        return {
          ...node,
          output: { ...node.output, media: { ...node.output.media, path: map(node.output.media.path) } },
        };
      }
      return node;
    });
    return { ...turn, content };
  });
}

/** 札を組む。updatedAt は最後のターンの時刻（無ければ createdAt）。題は渡されたもの（既定は空） */
export function buildSessionMeta(id: string, createdAt: number, turns: Turn[], title = ''): SessionMeta {
  const last = turns.length > 0 ? turns[turns.length - 1] : null;
  return {
    id,
    title: normalizeTitle(title),
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
  const m = buildSessionMeta(meta.id, meta.createdAt, turns, meta.title);
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
  { ok: true; id: string; title: string; createdAt: number; turns: Turn[] } | { ok: false; reason: string };

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
  return { ok: true, id, title: normalizeTitle(r.title), createdAt, turns };
}

/**
 * 保存のファイル名: `YYYYMMDD_HHMM_<題の先頭>.json`（題は名前に使える字だけ残す）。
 * 日時は**会話の始まり（createdAt）**で付ける —— 同じ会話を保存し直せば同じ名前になり、上書きされる
 * （最後に触った時刻で付けると、続きを話すたびに別のファイルが増える）。
 */
export function exportFileName(meta: { title: string; createdAt: number }, now: Date = new Date()): string {
  const d = new Date(meta.createdAt || now.getTime());
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

/** 保存のディレクトリの名前（`exportFileName` から `.json` を取ったもの）。中に `session.json` と `media/` */
export function exportDirName(meta: { title: string; createdAt: number }, now: Date = new Date()): string {
  return exportFileName(meta, now).replace(/\.json$/i, '');
}

/** VFS に保存してある会話の一覧の 1 行。**ファイルの名前と stat だけ**から作る（中身は読まない） */
export interface SavedSessionEntry {
  path: string;
  name: string;
  /** 名前から戻した題（無ければ空文字。表示側が日時で代える） */
  title: string;
  /** 名前の日時（会話の始まり）。読めなければ null */
  startedAt: number | null;
  size: number;
  updatedAt: number;
  /** 実体が手元に無い（同期のスタブ）。読み込むときに取り寄せられる */
  stub: boolean;
  /** 'dir' = `<名前>/session.json`＋`media/` の形、'file' = 旧形式の単一 `.json`（添付は無い） */
  form: 'dir' | 'file';
}

const EXPORT_NAME = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(?:_(.+))?\.json$/i;

/** `exportFileName` の逆: 名前から 日時と題 を戻す。形が違えば題は名前そのもの（拡張子抜き）、日時は null */
export function parseExportFileName(name: string): { title: string; startedAt: number | null } {
  const m = EXPORT_NAME.exec(name);
  if (!m) return { title: name.replace(/\.json$/i, ''), startedAt: null };
  const [, y, mo, d, h, mi, slug] = m;
  const t = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)).getTime();
  return { title: (slug || '').replace(/_/g, ' '), startedAt: Number.isFinite(t) ? t : null };
}

/**
 * 保存先の一覧（**再帰の** stat の配列）から、保存してある会話の行を組む。
 * - `<root>/<名前>/session.json` があるディレクトリ … 1 行（大きさはその下の全ファイルの和）
 * - `<root>/<名前>.json`（旧形式の単一ファイル） … 1 行
 * 名前と stat だけで組む（中身は読まない）。新しい順（名前の日時、無ければ updatedAt）
 */
export function listSavedSessions(
  root: string,
  stats: Array<{ path: string; name: string; kind: string; size: number; updatedAt: number; syncState?: string }>,
): SavedSessionEntry[] {
  const prefix = root.replace(/\/+$/, '') + '/';
  const rows: SavedSessionEntry[] = [];
  const dirs = new Map<string, { size: number; updatedAt: number; stub: boolean; hasSession: boolean }>();
  for (const s of stats) {
    if (!s.path.startsWith(prefix)) continue;
    const rel = s.path.slice(prefix.length);
    const slash = rel.indexOf('/');
    if (slash < 0) {
      if (s.kind !== 'file' || !/\.json$/i.test(s.name)) continue;
      const parsed = parseExportFileName(s.name);
      rows.push({
        path: s.path,
        name: s.name,
        title: parsed.title,
        startedAt: parsed.startedAt,
        size: s.size,
        updatedAt: s.updatedAt,
        stub: s.syncState === 'stub',
        form: 'file',
      });
      continue;
    }
    const top = rel.slice(0, slash);
    const d = dirs.get(top) ?? { size: 0, updatedAt: 0, stub: false, hasSession: false };
    if (s.kind === 'file') {
      d.size += s.size;
      d.updatedAt = Math.max(d.updatedAt, s.updatedAt);
      if (s.syncState === 'stub') d.stub = true;
      if (rel === `${top}/${EXPORT_SESSION_FILE}`) d.hasSession = true;
    }
    dirs.set(top, d);
  }
  for (const [name, d] of dirs) {
    if (!d.hasSession) continue;
    const parsed = parseExportFileName(`${name}.json`);
    rows.push({
      path: prefix + name,
      name,
      title: parsed.title,
      startedAt: parsed.startedAt,
      size: d.size,
      updatedAt: d.updatedAt,
      stub: d.stub,
      form: 'dir',
    });
  }
  return rows.sort(
    (a, b) => (b.startedAt ?? b.updatedAt) - (a.startedAt ?? a.updatedAt) || a.name.localeCompare(b.name),
  );
}
