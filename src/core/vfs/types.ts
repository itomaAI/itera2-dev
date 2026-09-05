/**
 * src/core/vfs/types.ts
 * Itera OS VFS v2: Core Types and Interfaces
 */

// ==========================================
// 1. Core Data Models (Metadata)
// ==========================================

export type PrincipalType = 'system' | 'user' | 'agent' | 'group' | 'app' | 'any';

export interface Principal {
  type: PrincipalType;
  id: string;
}

export type PermissionType = 'read' | 'write' | 'manage';

export interface AclRule {
  principal: Principal;
  permissions: PermissionType[];
}

export interface AccessControlList {
  owner: Principal;
  rules: AclRule[];
}

// OS全体で使い回す共通のPrincipal定数
export const SYSTEM_PRINCIPAL: Principal = { type: 'system', id: 'kernel' };
export const USER_PRINCIPAL: Principal = { type: 'user', id: 'local_user' };
export const AGENT_PRINCIPAL: Principal = { type: 'agent', id: 'Itera_AI' };

export interface VfsNode {
  id: string;
  name: string;
  parentId: string | null;
  kind: 'file' | 'directory';
  contentRef?: ContentRef;
  flags: VfsNodeFlags;
  meta: VfsNodeMeta;
  appHints?: AppHints;
  acl: AccessControlList;
}

export interface VfsNodeFlags {
  isSystem: boolean;
  isTrashed: boolean;
  isReadonly?: boolean;
  isHidden?: boolean;
}

export interface VfsNodeMeta {
  size: number;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
  mimeType?: string;
  version: number;
  hash?: string;
  syncState?: 'synced' | 'stub';
}

export interface ContentRef {
  backend: 'opfs' | 'memory';
  key: string;
}

export interface AppHints {
  preferredAppId?: string;
}

// ==========================================
// 2. Mutation System (CDC for UI & Sync)
// ==========================================

export type VfsMutationType = 'ATTACH' | 'DETACH' | 'MUTATE';

export interface VfsMutation {
  type: VfsMutationType;
  nodeId: string;

  /**
   * ATTACH/MUTATE の場合は、変更後の最新ノードが含まれる
   * DETACH の場合は null となる
   */
  node: VfsNode | null;

  /**
   * ATTACH/MUTATE の場合は現在のパス
   * DETACH の場合は削除される直前のパス
   */
  path: string;

  /**
   * MUTATE の場合、変更されたプロパティのキーの一覧が格納される
   * 例: ['size', 'hash', 'updatedAt']
   */
  changedProperties?: string[];

  /**
   * Mutation の発生元となる Principal
   * これにより OS レベルでのエコーキャンセル（自身が起こした変更は自身に通知しない）を実現する
   */
  sourcePrincipal: Principal;
}

export interface SyncProviderConfig {
  onMutate: (mutations: VfsMutation[]) => Promise<void>;
  onFetchContent: (path: string) => Promise<boolean>;
}

// ==========================================
// 3. API Boundary Types (For UI, AI, and Guest Apps)
// ==========================================

export interface VfsStat {
  id: string;
  path: string;
  name: string;
  kind: 'file' | 'directory';
  size: number;
  createdAt: number;
  updatedAt: number;
  mimeType?: string;
  version: number;
  hash?: string;
  /**
   * 実体が手元にあるか無いか（'stub' ＝ 無い）。**ファイル自身の性質**であり、node.meta に保存される。
   * 「同期の管轄下か」とは直交する（そちらは syncProvider を見る）。
   */
  syncState?: 'synced' | 'stub';
  flags: VfsNodeFlags;
  acl: AccessControlList;
  isMountPoint?: boolean;
  /**
   * この節点を担当する Sync Provider（居なければ undefined）。**保存しない。**
   * 問い合わせのたびに ProviderManager のマウント表から導くので、
   * デーモンが落ちた・マウントを外したときは次の問い合わせで自然に消える（T-0352）。
   * 保存された印にすると、管轄が変わったあとも嘘が残る。
   */
  syncProvider?: { mountPath: string; pid: string };
}

export interface TreeNode {
  id: string;
  name: string;
  path: string;
  kind: 'file' | 'directory';
  meta: VfsNodeMeta;
  children?: TreeNode[];
  /** このノード自身が Sync Provider のマウント地点である */
  isMountPoint?: boolean;
  /** Sync Provider の管轄下にある（マウント地点とその配下すべて） */
  isVirtual?: boolean;
}

export interface SyncStateItem {
  kind: 'file' | 'directory';
  /** バイト数。同期プロバイダはこれを索引へ書く。無いと相手側のスタブが 0 バイトになる（T-0351） */
  size?: number;
  createdAt?: number;
  updatedAt: number;
  version: number;
  hash?: string;
  syncState?: 'synced' | 'stub';
}

export type SyncStateTree = Record<string, SyncStateItem>;

export interface ListOptions {
  recursive?: boolean;
  detail?: boolean;
  ignoreHidden?: boolean;
}

export interface ReadOptions {
  bypassFetch?: boolean;
  encoding?: 'binary' | 'base64' | 'dataurl' | 'utf8';
}

export interface WriteOptions {
  overwrite?: boolean;
  system?: boolean;
  /**
   * 日付を明示して書く（T-0351）。スタブの中身を取り寄せる「実体化」で使う。
   * 指定が無ければ従来どおり、書いた時刻が updatedAt になる。
   */
  meta?: { createdAt?: number; updatedAt?: number };
}

export interface DeleteOptions {
  permanent?: boolean;
}

export interface MkdirOptions {}

export interface RenameOptions {}

export interface CopyOptions {}

export interface StubOptions {}
