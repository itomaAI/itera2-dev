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
  type RestoreOptions,
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
import { DeleteFileOp, RenameOp, CopyOp, RestoreOp } from './operations/TransferOps';
import { SetAclOp, SetAclRecursiveOp } from './operations/AclOps';
import type { ProviderManager } from './ProviderManager';
import { VFS_HARD_LIMITS } from '../../config/constants';
import { VfsError } from './VfsError';

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

  /**
   * パスを変える操作（改名・移動・ゴミ箱・復元・複製）の前に、部分木の stub をすべて実体化する（T-0689）。
   *
   * ★ 移動元と移動先のプロバイダが同じでも実体化する。
   *   以前は「同じプロバイダなら向こうで追従できる」として飛ばしていたが、追従できるプロバイダは 1 本も無い
   *   （firebase_sync / gdrive_sync / local_bridge はいずれもパスを鍵にした 3-way 照合で、
   *   ディレクトリの改名は親 1 件の DETACH / ATTACH しか出ない）。stub の中身を取りに行く鍵はパスだけなので、
   *   パスを変えた瞬間に新パスでは取れず、旧パスは次の照合で「ローカルで消された」と読まれて向こう側からも消える
   *   —— 唯一の実体が失われる（ミャク楽で実際に起きた）。
   * ★ 1 本でも取れなければ VfsError('ESTUB') を投げ、操作そのものを止める（何も動かさない）。
   *   取れない stub を運ぶと、その時点で中身を取り戻す手段が無くなる。以前は warn して続行していた。
   * ★ 量では断らない（2026-10-21 山内さん）。「向こう側で動かす」は利用者にはできないので、断ると詰む。
   *   遅くても落とし切る。
   * ★ 例外は、プロバイダ自身が「向こう側でも動かせる」と申し出ている改名・移動（`opts.delegateMove`。
   *   RenameOp だけが付ける）。同じプロバイダの中で、行き先がゴミ箱でなく、動かすのがそのプロバイダ自身でなければ、
   *   先に onMove を頼み、true なら実体化せずに動かす（向こうを先に動かし、成功してから手元を動かす。
   *   逆だと手元の巻き戻しが要る）。false／例外は「何も変えていない」と読み、実体化の経路に戻る。
   *   複製・ゴミ箱・復元・プロバイダ跨ぎは常に実体化（複製には向こうに口が無く、trash/ は同期の外）。
   */
  public async _hydrateIfNeeded(
    principal: Principal,
    srcPath: string,
    destPath: string,
    opts: { delegateMove?: boolean } = {},
  ): Promise<void> {
    const id = this.pathResolver.getIdByPath(srcPath);
    if (!id) return;

    if (opts.delegateMove && (await this._delegateMove(principal, srcPath, destPath))) return;

    const stubs: string[] = [];
    const collect = (nodeId: string, currentPath: string) => {
      const node = this.nodeStore.getNode(nodeId);
      if (!node) return;
      if (node.kind === 'file') {
        if (node.meta.syncState === 'stub') stubs.push(currentPath);
      } else if (node.kind === 'directory') {
        for (const child of this.nodeStore.getChildren(nodeId)) collect(child.id, `${currentPath}/${child.name}`);
      }
    };
    collect(id, srcPath);
    if (stubs.length === 0) return;

    if (!this.providerManager) {
      throw new VfsError(
        'ESTUB',
        `Cannot move or copy ${srcPath} to ${destPath}: ${stubs[0]} has no contents on this device and no provider can fetch it. Nothing was changed.`,
      );
    }

    for (const path of stubs) {
      try {
        await this.readBlob(principal, path);
      } catch (e: any) {
        throw new VfsError(
          'ESTUB',
          `Cannot move or copy ${srcPath} to ${destPath}: the contents of ${path} are not on this device and could not be fetched` +
            ` (${stubs.length} stub file(s) under ${srcPath}). Nothing was changed. Fetch it first (is its sync provider running?)` +
            ` or delete it permanently ({ permanent: true }). Reason: ${e?.message || e}`,
        );
      }
    }
  }

  /** 改名・移動を担当プロバイダに任せられるか試す（T-0689）。条件が揃わなければ頼まずに false */
  private async _delegateMove(principal: Principal, srcPath: string, destPath: string): Promise<boolean> {
    if (!this.providerManager) return false;
    if (destPath === 'trash' || destPath.startsWith('trash/')) return false;
    if (this.pathResolver.getIdByPath(destPath) !== undefined) return false; // 行き先が在れば改名は失敗する。向こうを先に動かさない

    const srcInfo = this.providerManager.findProviderForPath(srcPath);
    const destInfo = this.providerManager.findProviderForPath(destPath);
    if (!srcInfo || !destInfo || srcInfo.pid !== destInfo.pid) return false;
    if (!srcInfo.capabilities.move) return false;
    // プロバイダ自身の改名（衝突の写し `(Conflicted Copy)` など）は手元だけの操作。向こうへ跳ね返さない（エコー）
    if (principal.id === srcInfo.pid) return false;

    return await this.providerManager.moveContent(srcPath, destPath);
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
    if (id === undefined) throw new VfsError('ENOENT', `File or directory not found: ${path}`);

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
    const nodePath = this.pathResolver.getPathById(node.id);
    const stat: VfsStat = {
      id: node.id,
      path: nodePath,
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
    // ゴミ箱の中身だけが持つ 2 つ（T-0470）。無いものを undefined で並べない
    if (node.meta.deletedAt !== undefined) stat.deletedAt = node.meta.deletedAt;
    if (node.meta.trashedFrom !== undefined) stat.trashedFrom = node.meta.trashedFrom;

    // 「同期の管轄下か」は保存せず、ここで毎回導く（T-0352）。
    // syncState（実体の有無）とは直交する量である。
    //
    // ★ getTree の isVirtual と違い、ルートマウント（mountPath === ''）も隠さない。
    //   木では「全ディレクトリが該当して印の情報量がゼロになる」ため境界から先だけに印を付けるが、
    //   stat は 1 件を名指しで問う場面なので、担当が居るかどうかを省くと
    //   「取りに行ける stub」と「取りに行けない stub（孤児）」を区別できなくなる。
    if (this.providerManager) {
      if (this.providerManager.isMountPoint(nodePath)) stat.isMountPoint = true;
      const info = this.providerManager.findProviderForPath(nodePath);
      if (info) {
        stat.syncProvider = {
          mountPath: info.mountPath,
          pid: info.pid,
          // 「登録が在る」と「いま取りに行ける」は別（T-0353）。
          // マウントはプロセスの死では消えないので、ここも毎回導く。
          alive: this.providerManager.isProviderAlive(info.pid),
        };
      }
    }

    return stat;
  }

  listFiles(principal: Principal, options: ListOptions & { path?: string } = {}): (string | VfsStat)[] {
    const rootPath = this.pathResolver.normalizePath(options.path || '');
    const rootId = this.pathResolver.getIdByPath(rootPath);

    if (rootId === undefined) throw new VfsError('ENOENT', `Path not found: ${rootPath}`);
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
        if (options.ignoreHidden && (node.flags.isHidden || node.name.startsWith('.'))) continue;
        else if (!options.ignoreHidden && node.flags.isHidden) continue;

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
    const filtered = this._filterTreeByPermission(principal, fullTree);

    if (this.providerManager) {
      // マウントポイント自身の印（isMountPoint）に加えて、
      // 「ルート以外の同期プロバイダの管轄下にあるか」（isVirtual）を配る。
      //
      // ★ ルートマウント（mountPath === ''）は印を付けない。
      //   Google ドライブ同期は VFS 全体をマウントしうる。その構成では
      //   「プロバイダの管轄下か」で印を付けると**全ディレクトリが該当**し、
      //   印としての情報量がゼロになる（実際にそうなった）。
      //   印が意味を持つのは、管轄が**切り替わる境界**から先だけである。
      //
      // マウントは最長前置一致なので、親が非ルートのマウント配下なら
      // 子も必ず同じマウントの配下になる。その性質を使って親から伝播させる。
      const attachMountInfo = (nodes: TreeNode[], parentIsVirtual: boolean) => {
        for (const node of nodes) {
          if (this.providerManager!.isMountPoint(node.path)) {
            node.isMountPoint = true;
          }
          const info = parentIsVirtual ? null : this.providerManager!.findProviderForPath(node.path);
          const isVirtual = parentIsVirtual || (!!info && info.mountPath !== '');
          if (isVirtual) node.isVirtual = true;
          if (node.children) attachMountInfo(node.children, isVirtual);
        }
      };
      attachMountInfo(filtered, false);
    }

    return filtered;
  }

  getSyncState(principal: Principal, path: string = ''): SyncStateTree {
    const rootPath = this.pathResolver.normalizePath(path);
    const rootId = this.pathResolver.getIdByPath(rootPath);

    if (rootId === undefined) throw new VfsError('ENOENT', `Path not found: ${rootPath}`);
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
          size: node.meta.size,
          createdAt: node.meta.createdAt,
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
        size: rootNode.meta.size,
        createdAt: rootNode.meta.createdAt,
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
    if (!id) throw new VfsError('ENOENT', `Not found: ${normPath}`);

    this.auth.checkNodePermission(principal, id, 'read');
    const node = this.nodeStore.getNode(id)!;
    return JSON.parse(JSON.stringify(node.acl));
  }

  /**
   * この端末の VFS の容量。`used` は索引（NodeStore）の総量で system の分を含む。
   * `reserved` は system 予約（利用者・ゲストが書ける上限は `max - reserved`。BaseOperation.checkQuota と同じ数）。
   * シェルの表示は percent / isFull を使い、ゲストへは `fs:get_usage` が used / max / reserved だけを配る（T-0354）。
   */
  getUsage(): { used: number; max: number; reserved: number; percent: number; isFull: boolean } {
    const used = this.nodeStore.getTotalSize();
    const max = VFS_HARD_LIMITS.MAX_STORAGE_BYTES;
    const reserved = VFS_HARD_LIMITS.SYSTEM_RESERVE_BYTES;
    const percent = Math.min(100, (used / max) * 100);
    const isFull = used >= max;

    return { used, max, reserved, percent, isFull };
  }

  async readFile(principal: Principal, path: string, opts: ReadOptions = {}): Promise<string> {
    const blob = await this.readBlob(principal, path, opts);
    return await blob.text();
  }

  async readBlob(principal: Principal, path: string, opts: ReadOptions = {}): Promise<Blob> {
    const normPath = this.pathResolver.normalizePath(path);
    const id = this.pathResolver.getIdByPath(normPath);

    if (id === undefined || id === null) throw new VfsError('ENOENT', `File not found: ${normPath}`);
    this.auth.checkNodePermission(principal, id, 'read');

    let node = this.nodeStore.getNode(id)!;
    if (node.kind !== 'file') throw new VfsError('EISDIR', `Cannot read directory as file: ${normPath}`);

    if (node.meta.syncState === 'stub' && !opts.bypassFetch) {
      if (!this.providerManager) throw new Error(`File is a stub but ProviderManager is not initialized.`);

      const success = await this.providerManager.fetchContent(normPath);
      if (!success) throw new VfsError('ESTUB', `Failed to fetch missing content for ${normPath}`);

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

  /** ゴミ箱から元の場所（か opts.to）へ戻す。戻した先のパスを返す（T-0470） */
  async restore(principal: Principal, path: string, opts: RestoreOptions = {}): Promise<string> {
    return new RestoreOp(this.context).execute(principal, { path, opts });
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
