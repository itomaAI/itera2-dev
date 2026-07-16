/**
 * src/core/vfs/types.ts
 * Itera OS VFS v2: Core Types and Interfaces
 */

// ==========================================
// 1. Core Data Models (Metadata)
// ==========================================

export type PrincipalType = 'system' | 'user' | 'agent' | 'group' | 'any';

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
// 2. Event System (Pub/Sub for UI & Sync)
// ==========================================

export type VfsEventType = 'create' | 'update' | 'rename' | 'move' | 'trash' | 'restore' | 'delete';

export interface VfsEvent {
  type: VfsEventType;
  nodeId: string;
  node: VfsNode | null;
  path: string;
  oldPath?: string;
  source?: string;
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
  syncState?: 'synced' | 'stub';
  flags: VfsNodeFlags;
  acl: AccessControlList;
}

export interface TreeNode {
  id: string;
  name: string;
  path: string;
  kind: 'file' | 'directory';
  meta: VfsNodeMeta;
  children?: TreeNode[];
}

export interface SyncStateItem {
  kind: 'file' | 'directory';
  updatedAt: number;
  version: number;
  hash?: string;
  syncState?: 'synced' | 'stub';
}

export type SyncStateTree = Record<string, SyncStateItem>;

export interface ListOptions {
  recursive?: boolean;
  detail?: boolean;
}

export interface ReadOptions {
  bypassFetch?: boolean;
  encoding?: 'binary' | 'base64' | 'dataurl' | 'utf8';
}

export interface WriteOptions {
  overwrite?: boolean;
  system?: boolean;
  source?: string;
}

export interface DeleteOptions {
  permanent?: boolean;
  source?: string;
}

export interface MkdirOptions {
  source?: string;
}

export interface RenameOptions {
  source?: string;
}

export interface CopyOptions {
  source?: string;
}

export interface StubOptions {
  source?: string;
}
