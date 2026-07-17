/**
 * src/core/vfs/VfsService.ts
 * Itera OS VFS v2: Main File System API (Facade)
 */

import {
  SYSTEM_PRINCIPAL,
  type VfsNodeMeta,
  type VfsStat,
  type ListOptions,
  type ReadOptions,
  type WriteOptions,
  type DeleteOptions,
  type MkdirOptions,
  type RenameOptions,
  type CopyOptions,
  type StubOptions,
  type SyncStateTree,
  type TreeNode,
  type Principal,
  type AccessControlList,
} from './types';
import type { NodeStore } from './NodeStore';
import type { ContentStore } from './ContentStore';
import type { PathResolver } from './PathResolver';
import type { VfsEventBus } from './VfsEventBus';
import { VfsLockManager } from './VfsLockManager';
import { VfsAuth } from './VfsAuth';
import type { VfsContext } from './operations/BaseOperation';
import { WriteFileOp, AppendFileOp, MkdirOp, CreateStubOp } from './operations/WriteOps';
import { DeleteFileOp, RenameOp, CopyOp } from './operations/TransferOps';
import { SetAclOp, SetAclRecursiveOp } from './operations/AclOps';
import type { ProviderManager } from './ProviderManager';

export class VfsService {
  private nodeStore: NodeStore;
  private contentStore: ContentStore;
  private pathResolver: PathResolver;
  private lockManager: VfsLockManager;
  private auth: VfsAuth;
  private context: VfsContext;
  private providerManager?: ProviderManager;

  constructor(nodeStore: NodeStore, contentStore: ContentStore, pathResolver: PathResolver, eventBus: VfsEventBus) {
    this.nodeStore = nodeStore;
    this.contentStore = contentStore;
    this.pathResolver = pathResolver;
    this.lockManager = new VfsLockManager();
    this.auth = new VfsAuth(nodeStore);
    this.context = {
      nodeStore,
      contentStore,
      pathResolver,
      eventBus,
      lockManager: this.lockManager,
      auth: this.auth,
      vfs: this,
    };
  }

  public setProviderManager(pm: ProviderManager): void {
    this.providerManager = pm;
    this.context.providerManager = pm;
  }

  public getProviderManager(): ProviderManager | undefined {
    return this.providerManager;
  }

  public async _hydrateIfNeeded(principal: Principal, srcPath: string, destPath: string): Promise<void> {
    if (!this.providerManager) return;

    const srcInfo = this.providerManager.findProviderForPath(srcPath);
    const destInfo = this.providerManager.findProviderForPath(destPath);

    if (srcInfo?.pid === destInfo?.pid) return; // プロバイダが同じなら実体化不要
    if (!srcInfo) return; // 移動元にプロバイダが存在しなければ実体化不要

    const id = this.pathResolver.getIdByPath(srcPath);
    if (!id) return;

    const traverseAndHydrate = async (nodeId: string, currentPath: string) => {
      const node = this.nodeStore.getNode(nodeId);
      if (!node) return;

      if (node.kind === 'file') {
        if (node.meta.syncState === 'stub') {
          try {
            await this.readBlob(principal, currentPath);
          } catch (e) {
            console.warn(`[VfsService] Failed to hydrate ${currentPath} before moving/copying:`, e);
          }
        }
      } else if (node.kind === 'directory') {
        const children = this.nodeStore.getChildren(nodeId);
        for (const child of children) {
          await traverseAndHydrate(child.id, `${currentPath}/${child.name}`);
        }
      }
    };

    await traverseAndHydrate(id, srcPath);
  }

  exists(principal: Principal, path: string): boolean {
    const normPath = this.pathResolver.normalizePath(path);
    const id = this.pathResolver.getIdByPath(normPath);
    if (id === undefined) return false;

    if (id !== null) {
      const node = this.nodeStore.getNode(id);
      if (node && !this.auth.hasPermission(principal, node, 'read')) {
        return false;
      }
    }
    return true;
  }

  stat(principal: Principal, path: string): VfsStat {
    const id = this.pathResolver.getIdByPath(path);
    if (id === undefined) throw new Error(`File or directory not found: ${path}`);

    this.auth.checkNodePermission(principal, id, 'read');

    if (id === null) {
      return {
        id: '',
        path: '',
        name: 'root',
        kind: 'directory',
        size: 0,
        createdAt: 0,
        updatedAt: 0,
        version: 1,
        flags: { isSystem: true, isTrashed: false },
        acl: this.auth.getDefaultAcl(SYSTEM_PRINCIPAL, null),
      };
    }

    const node = this.nodeStore.getNode(id)!;
    return {
      id: node.id,
      path: this.pathResolver.getPathById(node.id),
      name: node.name,
      kind: node.kind,
      size: node.meta.size,
      createdAt: node.meta.createdAt,
      updatedAt: node.meta.updatedAt,
      mimeType: node.meta.mimeType,
      version: node.meta.version,
      hash: node.meta.hash,
      syncState: node.meta.syncState,
      flags: JSON.parse(JSON.stringify(node.flags)),
      acl: JSON.parse(JSON.stringify(node.acl)),
    };
  }

  listFiles(principal: Principal, options: ListOptions & { path?: string } = {}): (string | VfsStat)[] {
    const rootPath = this.pathResolver.normalizePath(options.path || '');
    const rootId = this.pathResolver.getIdByPath(rootPath);

    if (rootId === undefined) throw new Error(`Path not found: ${rootPath}`);
    this.auth.checkNodePermission(principal, rootId, 'read');

    if (rootId !== null) {
      const rootNode = this.nodeStore.getNode(rootId)!;
      if (rootNode.kind === 'file') {
        return options.detail ? [this.stat(principal, rootPath)] : [rootPath];
      }
    }

    const resultIds: string[] = [];
    const traverse = (parentId: string | null) => {
      const children = this.nodeStore.getChildren(parentId);
      for (const node of children) {
        if (node.flags.isHidden) continue;
        if (!this.auth.hasPermission(principal, node, 'read')) continue;
        resultIds.push(node.id);
        if (node.kind === 'directory' && options.recursive) traverse(node.id);
      }
    };
    traverse(rootId);

    return resultIds
      .map((id) => {
        const p = this.pathResolver.getPathById(id);
        if (options.detail) {
          const node = this.nodeStore.getNode(id)!;
          return {
            id: node.id,
            path: p,
            name: node.name,
            kind: node.kind,
            size: node.meta.size,
            createdAt: node.meta.createdAt,
            updatedAt: node.meta.updatedAt,
            mimeType: node.meta.mimeType,
            version: node.meta.version,
            hash: node.meta.hash,
            syncState: node.meta.syncState,
            flags: JSON.parse(JSON.stringify(node.flags)),
            acl: JSON.parse(JSON.stringify(node.acl)),
          } as VfsStat;
        }
        return p;
      })
      .sort((a, b) => {
        const strA = typeof a === 'string' ? a : (a as VfsStat).path;
        const strB = typeof b === 'string' ? b : (b as VfsStat).path;
        return strA.localeCompare(strB);
      });
  }

  private _filterTreeByPermission(principal: Principal, nodes: TreeNode[]): TreeNode[] {
    if (principal.type === 'system') return nodes;
    return nodes.filter((node) => {
      const vfsNode = this.nodeStore.getNode(node.id);
      if (!vfsNode || !this.auth.hasPermission(principal, vfsNode, 'read')) return false;
      if (node.children) node.children = this._filterTreeByPermission(principal, node.children);
      return true;
    });
  }

  getTree(principal: Principal): TreeNode[] {
    const fullTree = this.pathResolver.buildTree();
    return this._filterTreeByPermission(principal, fullTree);
  }

  getSyncState(principal: Principal, path: string = ''): SyncStateTree {
    const rootPath = this.pathResolver.normalizePath(path);
    const rootId = this.pathResolver.getIdByPath(rootPath);

    if (rootId === undefined) throw new Error(`Path not found: ${rootPath}`);
    this.auth.checkNodePermission(principal, rootId, 'read');

    const result: SyncStateTree = {};
    const traverse = (parentId: string | null) => {
      const children = this.nodeStore.getChildren(parentId);
      for (const node of children) {
        if (node.flags.isHidden) continue;
        if (!this.auth.hasPermission(principal, node, 'read')) continue;
        const nodePath = this.pathResolver.getPathById(node.id);
        result[nodePath] = {
          kind: node.kind,
          updatedAt: node.meta.updatedAt,
          version: node.meta.version,
          hash: node.meta.hash,
          syncState: node.meta.syncState,
        };
        if (node.kind === 'directory') traverse(node.id);
      }
    };

    if (rootId !== null) {
      const rootNode = this.nodeStore.getNode(rootId)!;
      result[rootPath] = {
        kind: rootNode.kind,
        updatedAt: rootNode.meta.updatedAt,
        version: rootNode.meta.version,
        hash: rootNode.meta.hash,
        syncState: rootNode.meta.syncState,
      };
      if (rootNode.kind === 'directory') traverse(rootId);
    } else {
      result[''] = { kind: 'directory', updatedAt: 0, version: 1, syncState: 'synced' };
      traverse(null);
    }
    return result;
  }

  getAcl(principal: Principal, path: string): AccessControlList {
    const normPath = this.pathResolver.normalizePath(path);
    const id = this.pathResolver.getIdByPath(normPath);
    if (!id) throw new Error(`Not found: ${normPath}`);

    this.auth.checkNodePermission(principal, id, 'read');
    const node = this.nodeStore.getNode(id)!;
    return JSON.parse(JSON.stringify(node.acl));
  }

  getUsage(principal: Principal): { used: number; max: number; percent: number; isFull: boolean } {
    let used = 0;
    for (const node of this.nodeStore.getAllNodes()) {
      if (node.kind === 'file' && node.meta.size && this.auth.hasPermission(principal, node, 'read')) {
        used += node.meta.size;
      }
    }
    const MAX_SIZE = 1024 * 1024 * 1024;
    return { used, max: MAX_SIZE, percent: Math.min(100, (used / MAX_SIZE) * 100), isFull: used >= MAX_SIZE };
  }

  async readFile(principal: Principal, path: string, opts: ReadOptions = {}): Promise<string> {
    const blob = await this.readBlob(principal, path, opts);
    return await blob.text();
  }

  async readBlob(principal: Principal, path: string, opts: ReadOptions = {}): Promise<Blob> {
    const normPath = this.pathResolver.normalizePath(path);
    const id = this.pathResolver.getIdByPath(normPath);

    if (id === undefined || id === null) throw new Error(`File not found: ${normPath}`);
    this.auth.checkNodePermission(principal, id, 'read');

    let node = this.nodeStore.getNode(id)!;
    if (node.kind !== 'file') throw new Error(`Cannot read directory as file: ${normPath}`);

    if (node.meta.syncState === 'stub' && !opts.bypassFetch) {
      if (!this.providerManager) throw new Error(`File is a stub but ProviderManager is not initialized.`);

      const success = await this.providerManager.fetchContent(normPath);
      if (!success) throw new Error(`Failed to fetch missing content for ${normPath}`);

      node = this.nodeStore.getNode(id)!;
      if (!node || node.meta.syncState === 'stub')
        throw new Error(`Provider claimed success but file is still a stub.`);
    }

    if (!node.contentRef) return new Blob([]);
    return await this.contentStore.readBlob(node.contentRef);
  }

  async createStub(
    principal: Principal,
    path: string,
    meta: Partial<VfsNodeMeta>,
    opts: StubOptions = {},
  ): Promise<string> {
    return new CreateStubOp(this.context).execute(principal, { path, meta, opts });
  }

  async appendFile(principal: Principal, path: string, content: string, opts: WriteOptions = {}): Promise<string> {
    return new AppendFileOp(this.context).execute(principal, { path, content, opts });
  }

  async writeFile(
    principal: Principal,
    path: string,
    content: string | Uint8Array | Blob,
    opts: WriteOptions = {},
  ): Promise<string> {
    return new WriteFileOp(this.context).execute(principal, { path, content, opts });
  }

  async mkdir(principal: Principal, path: string, opts: MkdirOptions = {}): Promise<string> {
    return new MkdirOp(this.context).execute(principal, { path, opts });
  }

  async deleteFile(principal: Principal, path: string, opts: DeleteOptions = {}): Promise<string> {
    return new DeleteFileOp(this.context).execute(principal, { path, opts });
  }

  async rename(principal: Principal, oldPath: string, newPath: string, opts: RenameOptions = {}): Promise<string> {
    return new RenameOp(this.context).execute(principal, { oldPath, newPath, opts });
  }

  async copyFile(principal: Principal, srcPath: string, destPath: string, opts: CopyOptions = {}): Promise<string> {
    return new CopyOp(this.context).execute(principal, { srcPath, destPath, opts });
  }

  async setAcl(principal: Principal, path: string, acl: AccessControlList): Promise<void> {
    return new SetAclOp(this.context).execute(principal, { path, acl });
  }

  async setAclRecursive(principal: Principal, path: string, acl: AccessControlList): Promise<void> {
    return new SetAclRecursiveOp(this.context).execute(principal, { path, acl });
  }
}
