/**
 * src/core/sys/GuestPaths.ts
 * ゲスト空間（利用者と AI の領域）の「どこに何があるか」を、ホストが設定から知るための型と純関数（T-0614）。
 *
 * ■ 思想（2026-10-06 山内さん）
 * ホストがゲストの形に依存するところは減らす。`system/` と `trash/` の形は OS が規定する。
 * それ以外の場所（AI の領域・利用者の領域・設定の 2 段目の層・会話の保存先…）は
 * **`system/config/paths.json` が指すところだけ**をホストが知る。ホストのコードに `memory/` `data/` `user/`
 * `agent/` `個人/` のような名前を書かない（守りは `guestPathLiterals.test.ts`）。
 *
 * ■ 無いときは「知らない」（推測しない）
 * コードの既定は全部 null（1 層・AI の領域なし・会話の保存先なし）。配布物が itera2-dev の形だと決めつけると、
 * ミャク楽や itera2 で黙って他所の形が効く。ゲストが空でもホストだけで起動する性質（実測済み）はこれで保たれる。
 *
 * ■ 層の場所だけは起動時に固定
 * `user.config` / `user.registry` / `user.locales` は **`system/config/paths.json` の値**で決まる
 * （層を読む前に層の場所が要るので、利用者の層の `paths.json` では動かせない）。他の鍵は普通の設定として層で上書きできる。
 */

export interface AgentPaths {
  /** AI の領域の根。ACL「AI だけ書く」をかける場所（itera2-dev `memory`、itera2 `agent`、ミャク楽 `エージェント`） */
  home: string | null;
  /** 起動のとき AI が最初に読む文書（システムプロンプトに差し込む）。無ければ起動手順は無い */
  init: string | null;
  /** AI の書き捨て。アプリ・利用者も書ける（ミャク楽 `エージェント/作業`） */
  scratch: string | null;
}

export interface UserPaths {
  /** 利用者の領域の根（itera2-dev `data`、itera2 `user`、ミャク楽 `個人`） */
  home: string | null;
  /** 設定の 2 段目の層（itera2 `user/config`）。🔴 system 層の値だけが効く */
  config: string | null;
  /** 登録簿の 2 段目の層（itera2 `user/registry`）。🔴 system 層の値だけが効く */
  registry: string | null;
  /** 言語ファイルの 2 段目の層（itera2-dev `user/locales`、ミャク楽 `個人/言語`）。🔴 system 層の値だけが効く */
  locales: string | null;
  /** 利用者のアプリ登録簿（ミャク楽 `個人/アプリ/registry.json`。登録簿の層で持つ配布物では null） */
  appRegistry: string | null;
  /** 会話を VFS に保存する既定の場所（T-0613） */
  sessions: string | null;
}

export interface GuestPaths {
  agent: AgentPaths;
  user: UserPaths;
}

/** 何も知らない形。コードの既定であり、`paths.json` が無い配布物の挙動でもある。 */
export const EMPTY_GUEST_PATHS: GuestPaths = Object.freeze({
  agent: Object.freeze({ home: null, init: null, scratch: null }),
  user: Object.freeze({ home: null, config: null, registry: null, locales: null, appRegistry: null, sessions: null }),
}) as GuestPaths;

/** `paths.json` の置き場。OS が規定する側（`system/`）なので直書きしてよい唯一の場所。 */
export const GUEST_PATHS_FILE = 'system/config/paths.json';

/** OS が規定する 1 段目の層。 */
export const SYSTEM_CONFIG_DIR = 'system/config';
export const SYSTEM_REGISTRY_DIR = 'system/registry';
export const SYSTEM_LOCALES_DIR = 'system/locales';

const AGENT_KEYS = ['home', 'init', 'scratch'] as const;
const USER_KEYS = ['home', 'config', 'registry', 'locales', 'appRegistry', 'sessions'] as const;

export interface NormalizedGuestPaths {
  paths: GuestPaths;
  /** 捨てた値とその理由。黙って null にしない（読む側がログに出す） */
  problems: string[];
}

/**
 * 1 つの値を VFS の相対パスとして整える。受け付けないものは null と理由を返す。
 *
 * 受け付けないもの: 文字列でない／空／絶対パス／`..` を含む／`system`・`trash` の下（OS が規定する側を
 * ゲスト空間の置き場として指すと、ACL や配信の規則とぶつかる）。
 */
export function normalizeGuestPath(value: unknown): { path: string | null; problem?: string } {
  if (value === null || value === undefined) return { path: null };
  if (typeof value !== 'string') return { path: null, problem: `not a string (${typeof value})` };
  let p = value.trim();
  if (p.startsWith('./')) p = p.slice(2);
  while (p.startsWith('/')) p = p.slice(1);
  while (p.endsWith('/')) p = p.slice(0, -1);
  if (!p) return { path: null, problem: 'empty' };
  const segments = p.split('/');
  if (segments.some((s) => s === '..' || s === '.' || s === ''))
    return { path: null, problem: `invalid segment in ${JSON.stringify(value)}` };
  if (segments[0] === 'system' || segments[0] === 'trash') {
    return { path: null, problem: `${JSON.stringify(value)} points inside an OS-regulated area (system/ or trash/)` };
  }
  return { path: p };
}

/** `paths.json` の生の中身（JSON.parse 済み）を型のとおりに整える。知らない鍵は無視する。 */
export function normalizeGuestPaths(raw: unknown): NormalizedGuestPaths {
  const problems: string[] = [];
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (raw !== undefined && raw !== null && src !== raw) problems.push('paths is not an object');

  const pick = <K extends string>(section: 'agent' | 'user', keys: readonly K[]): Record<K, string | null> => {
    const sec = src[section];
    const obj = sec && typeof sec === 'object' && !Array.isArray(sec) ? (sec as Record<string, unknown>) : {};
    if (sec !== undefined && sec !== null && obj !== sec) problems.push(`${section} is not an object`);
    const out = {} as Record<K, string | null>;
    for (const k of keys) {
      const r = normalizeGuestPath(obj[k]);
      if (r.problem) problems.push(`${section}.${k}: ${r.problem}`);
      out[k] = r.path;
    }
    return out;
  };

  return {
    paths: { agent: pick('agent', AGENT_KEYS), user: pick('user', USER_KEYS) },
    problems,
  };
}

/** 設定の層（読む順。後が勝つ。書き先は最後）。 */
export function configLayersOf(paths: GuestPaths): string[] {
  return paths.user.config ? [SYSTEM_CONFIG_DIR, paths.user.config] : [SYSTEM_CONFIG_DIR];
}

/** 登録簿の層。 */
export function registryLayersOf(paths: GuestPaths): string[] {
  return paths.user.registry ? [SYSTEM_REGISTRY_DIR, paths.user.registry] : [SYSTEM_REGISTRY_DIR];
}

/** 言語ファイルの層。 */
export function localeLayersOf(paths: GuestPaths): string[] {
  return paths.user.locales ? [SYSTEM_LOCALES_DIR, paths.user.locales] : [SYSTEM_LOCALES_DIR];
}

/** `"agent.home"` のような参照を引く。知らない鍵は undefined（null は「この配布物には無い」）。 */
export function resolveGuestPathRef(paths: GuestPaths, ref: string): string | null | undefined {
  const [section, key, ...rest] = ref.split('.');
  if (rest.length > 0) return undefined;
  if (section === 'agent' && (AGENT_KEYS as readonly string[]).includes(key))
    return paths.agent[key as keyof AgentPaths];
  if (section === 'user' && (USER_KEYS as readonly string[]).includes(key)) return paths.user[key as keyof UserPaths];
  return undefined;
}

/** 参照として受け付ける鍵の一覧（`acl.json` の検査と手引きのため）。 */
export const GUEST_PATH_REFS: readonly string[] = [
  ...AGENT_KEYS.map((k) => `agent.${k}`),
  ...USER_KEYS.map((k) => `user.${k}`),
];
