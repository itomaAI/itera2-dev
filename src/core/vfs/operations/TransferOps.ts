/**
 * src/core/vfs/operations/TransferOps.ts
 * Itera OS VFS v2: File/Directory Move, Copy, and Delete Operations
 */

import { BaseOperation } from './BaseOperation';
import type { Principal, VfsNode, DeleteOptions, RenameOptions, CopyOptions } from '../types';

export class DeleteFileOp extends BaseOperation<{ path: string; opts: DeleteOptions }, string> {
  async execute(principal: Principal, args: { path: string; opts: DeleteOptions }): Promise<string> {
    const { path, opts } = args;
    const normPath = this.ctx.pathResolver.normalizePath(path);
    const isPermanent = opts.permanent || normPath === 'trash' || normPath.startsWith('trash/') || 
                        normPath.startsWith('system/temp/') || normPath.startsWith('system/logs/');

    if (!isPermanent) {
      await this.ctx.vfs._hydrateIfNeeded(principal, normPath, 'trash');
    }

    while (true) {
      let shouldRetry = false;
      let trashDirId: string | null = null;
      if (!isPermanent) trashDirId = await this.ensureDir(principal, 'trash');

      const res = await this.ctx.lockManager.acquire(normPath, async () => {
        if (!isPermanent && trashDirId !== null && !this.ctx.nodeStore.getNode(trashDirId)) {
          shouldRetry = true; return null;
        }

        const id = this.ctx.pathResolver.getIdByPath(normPath);
        if (id === undefined) throw new Error(`Not found: ${normPath}`);
        if (id === null) throw new Error(`Cannot delete root directory.`);

        this.ctx.auth.checkNodePermission(principal, id, 'write');
        const node = this.ctx.nodeStore.getNode(id)!;
        if (node.parentId !== null) this.ctx.auth.checkNodePermission(principal, node.parentId, 'write');

        const tx = this.createTransaction(principal);

        if (isPermanent) {
          await this._deleteRecursive(principal, id, tx);
          await tx.commit();
          return `Permanently deleted: ${normPath}`;
        } else {
          const timestamp = Date.now();
          const newName = `${timestamp}_${node.name}`;
          const updatedNode: VfsNode = {
            ...node, name: newName, parentId: trashDirId!,
            flags: { ...node.flags, isTrashed: true },
            meta: { ...node.meta, deletedAt: timestamp, version: node.meta.version + 1 },
          };
          tx.put(updatedNode);
          await tx.commit();
          return `Moved to trash: ${normPath}`;
        }
      });

      if (shouldRetry) continue;
      return res!;
    }
  }

  private async _deleteRecursive(principal: Principal, nodeId: string, tx: any): Promise<void> {
    const node = this.ctx.nodeStore.getNode(nodeId);
    if (!node) return;

    this.ctx.auth.checkNodePermission(principal, nodeId, 'write');

    if (node.kind === 'directory') {
      const children = this.ctx.nodeStore.getChildren(nodeId);
      for (const child of children) {
        await this._deleteRecursive(principal, child.id, tx);
      }
    } else {
      if (node.contentRef) await this.ctx.contentStore.delete(node.contentRef);
    }
    tx.delete(nodeId);
  }
}

export class RenameOp extends BaseOperation<{ oldPath: string; newPath: string; opts: RenameOptions }, string> {
  async execute(principal: Principal, args: { oldPath: string; newPath: string; opts: RenameOptions }): Promise<string> {
    const { oldPath, newPath } = args;
    const normOld = this.ctx.pathResolver.normalizePath(oldPath);
    const normNew = this.ctx.pathResolver.normalizePath(newPath);

    if (!normOld) throw new Error('Cannot rename root.');
    if (!normNew) throw new Error('Invalid destination path.');

    await this.ctx.vfs._hydrateIfNeeded(principal, normOld, normNew);

    const parts = normNew.split('/');
    const newName = parts.pop()!;
    const newParentPath = parts.join('/');

    while (true) {
      let shouldRetry = false;
      const newParentId = await this.ensureDir(principal, newParentPath);

      const res = await this.ctx.lockManager.acquireMultiple([normOld, normNew], async () => {
        if (newParentId !== null && !this.ctx.nodeStore.getNode(newParentId)) {
          shouldRetry = true; return null;
        }

        const oldId = this.ctx.pathResolver.getIdByPath(normOld);
        if (oldId === undefined || oldId === null) throw new Error(`Source not found or cannot be root: ${normOld}`);

        this.ctx.auth.checkNodePermission(principal, oldId, 'write');
        const node = this.ctx.nodeStore.getNode(oldId)!;
        if (node.parentId !== null) this.ctx.auth.checkNodePermission(principal, node.parentId, 'write');

        const newId = this.ctx.pathResolver.getIdByPath(normNew);
        if (newId !== undefined) throw new Error(`Destination already exists: ${normNew}`);
        this.ctx.auth.checkNodePermission(principal, newParentId, 'write');

        if (node.kind === 'directory') {
          let cur: string | null = newParentId;
          while (cur !== null) {
            if (cur === node.id) throw new Error('Cannot move a directory into its own subfolder.');
            const parentNode = this.ctx.nodeStore.getNode(cur);
            cur = parentNode ? parentNode.parentId : null;
          }
        }

        const updatedNode: VfsNode = {
          ...node, name: newName, parentId: newParentId,
          meta: { ...node.meta, updatedAt: Date.now(), version: node.meta.version + 1 },
        };

        const tx = this.createTransaction(principal);
        tx.put(updatedNode);
        await tx.commit();

        return `Moved/Renamed: ${normOld} -> ${normNew}`;
      });

      if (shouldRetry) continue;
      return res!;
    }
  }
}

export class CopyOp extends BaseOperation<{ srcPath: string; destPath: string; opts: CopyOptions }, string> {
  async execute(principal: Principal, args: { srcPath: string; destPath: string; opts: CopyOptions }): Promise<string> {
    const { srcPath, destPath } = args;
    const normSrc = this.ctx.pathResolver.normalizePath(srcPath);
    const normDest = this.ctx.pathResolver.normalizePath(destPath);

    await this.ctx.vfs._hydrateIfNeeded(principal, normSrc, normDest);

    const parts = normDest.split('/');
    const newName = parts.pop()!;
    const destParentPath = parts.join('/');

    while (true) {
      let shouldRetry = false;
      const destParentId = await this.ensureDir(principal, destParentPath);

      const res = await this.ctx.lockManager.acquireMultiple([normSrc, normDest], async () => {
        if (destParentId !== null && !this.ctx.nodeStore.getNode(destParentId)) {
          shouldRetry = true; return null;
        }

        const srcId = this.ctx.pathResolver.getIdByPath(normSrc);
        if (srcId === undefined || srcId === null) throw new Error(`Source not found or cannot be root: ${normSrc}`);

        this.ctx.auth.checkNodePermission(principal, srcId, 'read');

        const destId = this.ctx.pathResolver.getIdByPath(normDest);
        if (destId !== undefined) throw new Error(`Destination already exists: ${normDest}`);
        
        this.ctx.auth.checkNodePermission(principal, destParentId, 'write');
        const srcNode = this.ctx.nodeStore.getNode(srcId)!;

        const tx = this.createTransaction(principal);

        if (srcNode.kind === 'file') {
          if (!srcNode.contentRef) throw new Error('Source file has no content.');
          const blob = await this.ctx.contentStore.readBlob(srcNode.contentRef);

          const newNode: VfsNode = {
            id: this.generateId(), name: newName, parentId: destParentId, kind: 'file',
            flags: { isSystem: srcNode.flags.isSystem, isTrashed: false },
            meta: { size: blob.size, createdAt: Date.now(), updatedAt: Date.now(), version: 1, hash: srcNode.meta.hash },
            acl: this.ctx.auth.getDefaultAcl(principal, destParentId),
          };
          newNode.contentRef = await this.ctx.contentStore.write(newNode.id, blob);
          tx.put(newNode);
          await tx.commit();
          return `Copied file: ${normSrc} -> ${normDest}`;
        } else {
          let count = 0;
          const copyRecursive = async (sourceDirId: string, currentDestParentId: string | null) => {
            const children = this.ctx.nodeStore.getChildren(sourceDirId);
            for (const child of children) {
              if (child.flags.isTrashed) continue;
              if (!this.ctx.auth.hasPermission(principal, child, 'read')) continue;

              const newId = this.generateId();
              const newNode: VfsNode = {
                id: newId, name: child.name, parentId: currentDestParentId, kind: child.kind,
                flags: { ...child.flags },
                meta: { ...child.meta, createdAt: Date.now(), updatedAt: Date.now(), version: 1 },
                acl: this.ctx.auth.getDefaultAcl(principal, currentDestParentId),
              };

              if (child.kind === 'file') {
                if (child.contentRef) {
                  const blob = await this.ctx.contentStore.readBlob(child.contentRef);
                  newNode.contentRef = await this.ctx.contentStore.write(newId, blob);
                }
                tx.put(newNode);
                count++;
              } else {
                tx.put(newNode);
                await copyRecursive(child.id, newId);
              }
            }
          };

          const rootNewId = this.generateId();
          const rootNewNode: VfsNode = {
            id: rootNewId, name: newName, parentId: destParentId, kind: 'directory',
            flags: { isSystem: srcNode.flags.isSystem, isTrashed: false },
            meta: { size: 0, createdAt: Date.now(), updatedAt: Date.now(), version: 1 },
            acl: this.ctx.auth.getDefaultAcl(principal, destParentId),
          };
          tx.put(rootNewNode);

          await copyRecursive(srcId, rootNewId);
          await tx.commit();
          return `Copied directory: ${normSrc} -> ${normDest} (${count} files)`;
        }
      });

      if (shouldRetry) continue;
      return res!;
    }
  }
}