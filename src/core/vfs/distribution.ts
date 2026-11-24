/**
 * src/core/vfs/distribution.ts
 * 「配信物である」の判定（T-0904）。
 *
 * ホストが信頼する宣言（system の特権・ホストの窓で動くアダプタ）は、配信物だけがする。
 * 配信物とは、readonly の領域に在るファイルのこと（`areaAcl.ts` の方針 `readonly`）——
 * 書けるのは system の主体だけ（OS の配信と、Sudo にした利用者）で、ゲストも AI も書けない。
 *
 * パスが `system/` で始まることは、配信物の印にならない。`system/` の下には誰でも書ける領域が在る
 * （config・themes・registry・temp・upstream・credentials）。判定は名前ではなく、
 * そのノードに掛かっている ACL で行う。
 */
import { SYSTEM_PRINCIPAL, type AccessControlList, type Principal } from './types';

/** system のほかに書ける者が居ない ACL か。ACL の無い古いノードは誰でも書けるので false */
export function isReadonlyAcl(acl: AccessControlList | null | undefined): boolean {
  if (!acl || !acl.owner || !Array.isArray(acl.rules)) return false;
  // 持ち主は無条件で全権を持つ（VfsAuth）
  if (acl.owner.type !== 'system') return false;
  return acl.rules.every(
    (rule) => Array.isArray(rule.permissions) && rule.permissions.every((permission) => permission === 'read'),
  );
}

/** 判定に要る VFS の口（VfsService が満たす。試験では小さな偽物を差す） */
export interface DistributionVfs {
  exists(principal: Principal, path: string): boolean;
  stat(principal: Principal, path: string): { kind: string; acl?: AccessControlList | null };
}

/**
 * そのパスが配信物のファイルか。ファイル自身と、それを置くディレクトリの両方が readonly であること
 * （ディレクトリが書ければ、ファイルを置き換えられる）。無い・読めない・ディレクトリは false。
 */
export function isDistributionFile(vfs: DistributionVfs, path: string): boolean {
  const asked = String(path ?? '').replace(/^\/+|\/+$/g, '');
  const cut = asked.lastIndexOf('/');
  if (cut <= 0) return false; // 空・ルート直下（ルート直下に readonly の領域は無い）
  try {
    if (!vfs.exists(SYSTEM_PRINCIPAL, asked)) return false;
    const file = vfs.stat(SYSTEM_PRINCIPAL, asked);
    if (file.kind !== 'file' || !isReadonlyAcl(file.acl)) return false;
    const dir = vfs.stat(SYSTEM_PRINCIPAL, asked.slice(0, cut));
    return dir.kind === 'directory' && isReadonlyAcl(dir.acl);
  } catch {
    return false;
  }
}
