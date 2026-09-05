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
  /**
   * 実体（バイト列）が手元にあるか無いか。**それだけを意味する。**
   *
   * ★ 名前が "sync" なので「同期の状態」に見えるが、そうではない。
   *   実質は `'stub'`（実体が無い）か、未設定（実体がある）かの 2 状態で、
   *   `'synced'` は実ファイルに付くことがない（`WriteFileOp` は実体化のとき delete する）。
   *   **`stub?: boolean` という名前にすべきだった。** 保存済みのノードに入っている値なので、
   *   改名には移行が要る。名前の綺麗さのために動いているものを止めない、という判断で据え置いている。
   *
   * ★ 「同期の管轄下か」とは**直交する**。そちらは保存しない ——
   *   `VfsStat.syncProvider` / `TreeNode.isVirtual` として、
   *   問い合わせのたびに ProviderManager のマウント表から導く（T-0352）。
   *   管轄を保存された印にすると、デーモンが落ちた・マウントを外したあとも嘘が残る。
   *
   * この値を読んでいる場所: 容量に数えない（NodeStore）／実体化の引き金（VfsService.readBlob）／
   * 移動・複製前の実体化（_hydrateIfNeeded）／中身検索を飛ばす（search_tools）／
   * 名前を薄く表示（TreeView）／バックアップから除外（backupExclusion）／同期デーモン。
   * **どれも「中身が手元にあるか」を訊いている。**
   */
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
   * この節点を担当する Sync Provider（マウント表に無ければ undefined）。**保存しない。**
   * 問い合わせのたびに ProviderManager のマウント表から導くので、
   * マウントを外せば次の問い合わせで消える（T-0352）。
   * 保存された印にすると、管轄が変わったあとも嘘が残る。
   *
   * ★ alive は「登録が在る」とは別（T-0353）。**マウントの登録はプロセスの死では消えない**ため、
   *   この値が在っても中身を取りに行けるとは限らない。取りに行けるかは alive を見る。
   */
  syncProvider?: { mountPath: string; pid: string; alive: boolean };
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
