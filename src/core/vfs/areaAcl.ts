/**
 * src/core/vfs/areaAcl.ts
 * 起動のたびに領域へかける ACL を、宣言（`system/config/acl.json`）から組む（T-0614）。
 *
 * ■ 形
 *   { "areas": [ { "path": "system", "policy": "readonly" }, { "ref": "agent.home", "policy": "agent-only" }, … ] }
 *   - 上から順に当てる。広い領域を先に閉じ、中の開ける場所を後から上塗りする（順序が意味を持つ）
 *   - `path` は VFS の相対パス、`ref` は `paths.json` の鍵（`GuestPaths.ts`）。`ref` の先が null の配布物では飛ばす
 *   - `policy` は語彙を固定した 4 つ。生の rules は書かせない（増やしたくなったときに足す）
 *   - `ensure: true` なら、無ければ先にディレクトリを作る（AI の書き捨てのように、親が閉じていて利用者・アプリが自分では作れない場所）
 *
 * ■ 無い／読めないとき
 *   `acl.json` が配布物にもファイルにも無ければ `BUILTIN_SYSTEM_AREAS`（OS が規定する `system/` の守りだけ）。
 *   壊れていれば同じく組み込みに落として警告する。「読めない」を「開放」にしない。
 */

import { AGENT_PRINCIPAL, SYSTEM_PRINCIPAL, USER_PRINCIPAL, type AccessControlList } from './types';
import { resolveGuestPathRef, type GuestPaths } from '../sys/GuestPaths';

export type AclPolicy = 'readonly' | 'open' | 'agent-only' | 'agent-shared';

export const ACL_POLICIES: readonly AclPolicy[] = ['readonly', 'open', 'agent-only', 'agent-shared'];

export interface AreaAclEntry {
  path?: string;
  ref?: string;
  policy: AclPolicy;
  /** 無ければ作ってから当てる（既定 false＝無ければ飛ばす） */
  ensure?: boolean;
}

/** 方針の実体。ここが唯一の置き場（以前は VfsInitializer に 3 つの ACL が直書きされていた）。 */
export function aclOfPolicy(policy: AclPolicy): AccessControlList {
  switch (policy) {
    case 'readonly':
      // OS の配信物。AI・ゲストアプリからの破壊を防ぐ
      return {
        owner: { ...SYSTEM_PRINCIPAL },
        rules: [
          { principal: { ...USER_PRINCIPAL }, permissions: ['read'] },
          { principal: { ...AGENT_PRINCIPAL }, permissions: ['read'] },
          { principal: { type: 'any', id: '*' }, permissions: ['read'] },
        ],
      };
    case 'open':
      // 利用者が管理し、AI とアプリも書ける（設定・登録簿・一時領域…）
      return {
        owner: { ...SYSTEM_PRINCIPAL },
        rules: [
          { principal: { ...USER_PRINCIPAL }, permissions: ['read', 'write', 'manage'] },
          { principal: { ...AGENT_PRINCIPAL }, permissions: ['read', 'write'] },
          { principal: { type: 'any', id: '*' }, permissions: ['read', 'write'] },
        ],
      };
    case 'agent-only':
      // AI の領域。AI だけが書き、利用者・アプリは読むだけ
      return {
        owner: { ...AGENT_PRINCIPAL },
        rules: [
          { principal: { ...AGENT_PRINCIPAL }, permissions: ['read', 'write', 'manage'] },
          { principal: { type: 'any', id: '*' }, permissions: ['read'] },
        ],
      };
    case 'agent-shared':
      // AI の書き捨て。アプリが成果を返す経路のため、利用者・アプリも書ける
      return {
        owner: { ...AGENT_PRINCIPAL },
        rules: [
          { principal: { ...AGENT_PRINCIPAL }, permissions: ['read', 'write', 'manage'] },
          { principal: { ...USER_PRINCIPAL }, permissions: ['read', 'write'] },
          { principal: { type: 'any', id: '*' }, permissions: ['read', 'write'] },
        ],
      };
  }
}

/**
 * `acl.json` が無いときの組み込み。OS が規定する `system/` の守りだけ（ゲスト空間のことは知らない）。
 * 配布物の `acl.json` はこれに AI の領域の行を足したものになる。
 */
export const BUILTIN_SYSTEM_AREAS: readonly AreaAclEntry[] = Object.freeze([
  { path: 'system', policy: 'readonly' },
  { path: 'system/config', policy: 'open' },
  { path: 'system/themes', policy: 'open' },
  { path: 'system/registry', policy: 'open' },
  { path: 'system/temp', policy: 'open' },
  // 再起動で元に戻るため、一時的な書き換えや実験を許す
  { path: 'system/upstream', policy: 'open' },
  // 認証情報。デーモンが読み、認証アダプタが書く。🔴 クラウド同期に含めてはならない（1 ディレクトリで除外できるように独立させてある）
  { path: 'system/credentials', policy: 'open' },
]) as readonly AreaAclEntry[];

export interface ParsedAreaAcl {
  entries: AreaAclEntry[];
  problems: string[];
}

/** `acl.json` の生の中身を検査して並びにする。壊れた行は捨てて理由を残す（並び全体は捨てない）。 */
export function parseAreaAcl(raw: unknown): ParsedAreaAcl {
  const problems: string[] = [];
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!obj) return { entries: [], problems: ['acl is not an object'] };
  if (!Array.isArray(obj.areas)) return { entries: [], problems: ['acl.areas is not an array'] };

  const entries: AreaAclEntry[] = [];
  obj.areas.forEach((item, i) => {
    const e = item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : null;
    if (!e) {
      problems.push(`areas[${i}]: not an object`);
      return;
    }
    const policy = e.policy;
    if (typeof policy !== 'string' || !(ACL_POLICIES as readonly string[]).includes(policy)) {
      problems.push(`areas[${i}]: unknown policy ${JSON.stringify(policy)} (allowed: ${ACL_POLICIES.join(', ')})`);
      return;
    }
    const hasPath = typeof e.path === 'string' && e.path.trim() !== '';
    const hasRef = typeof e.ref === 'string' && e.ref.trim() !== '';
    if (hasPath === hasRef) {
      problems.push(`areas[${i}]: exactly one of path / ref is required`);
      return;
    }
    const entry: AreaAclEntry = hasPath
      ? { path: (e.path as string).trim(), policy: policy as AclPolicy }
      : { ref: (e.ref as string).trim(), policy: policy as AclPolicy };
    if (e.ensure === true) entry.ensure = true;
    entries.push(entry);
  });
  return { entries, problems };
}

export interface ResolvedArea {
  path: string;
  policy: AclPolicy;
  acl: AccessControlList;
  ensure: boolean;
}

/** 参照を `paths.json` の値に解いて、実際に当てる並びにする。先が null の参照は飛ばし、知らない参照は理由を残す。 */
export function resolveAreaAcl(
  entries: readonly AreaAclEntry[],
  paths: GuestPaths,
): { areas: ResolvedArea[]; problems: string[] } {
  const areas: ResolvedArea[] = [];
  const problems: string[] = [];
  for (const e of entries) {
    let path: string | null | undefined = e.path;
    if (e.ref !== undefined) {
      path = resolveGuestPathRef(paths, e.ref);
      if (path === undefined) {
        problems.push(`unknown ref ${JSON.stringify(e.ref)}`);
        continue;
      }
      if (path === null) continue; // この配布物には無い領域
    }
    if (!path) continue;
    const normalized = path.replace(/^\/+|\/+$/g, '');
    if (!normalized) continue;
    areas.push({ path: normalized, policy: e.policy, acl: aclOfPolicy(e.policy), ensure: e.ensure === true });
  }
  return { areas, problems };
}

/** 当て先に求める最小の口（試験で偽物に差し替える）。 */
export interface AclTarget {
  exists(principal: typeof SYSTEM_PRINCIPAL, path: string): boolean;
  mkdir(principal: typeof SYSTEM_PRINCIPAL, path: string): Promise<unknown>;
  setAclRecursive(principal: typeof SYSTEM_PRINCIPAL, path: string, acl: AccessControlList): Promise<unknown>;
}

/** 並びのとおりに当てる。無い場所は飛ばす（`ensure` なら作る）。戻り値は実際に当てたパス。 */
export async function applyAreaAcls(vfs: AclTarget, areas: readonly ResolvedArea[]): Promise<string[]> {
  const applied: string[] = [];
  for (const area of areas) {
    if (!vfs.exists(SYSTEM_PRINCIPAL, area.path)) {
      if (!area.ensure) continue;
      await vfs.mkdir(SYSTEM_PRINCIPAL, area.path);
    }
    await vfs.setAclRecursive(SYSTEM_PRINCIPAL, area.path, area.acl);
    applied.push(area.path);
  }
  return applied;
}
