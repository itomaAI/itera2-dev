/**
 * src/core/vfs/operations/WriteOps.ts
 * Itera OS VFS v2: File and Directory Creation/Write Operations
 */

import { BaseOperation } from './BaseOperation';
import type { Principal, VfsNode, VfsNodeMeta, WriteOptions, MkdirOptions, StubOptions } from '../types';

export class MkdirOp extends BaseOperation<{ path: string; opts: MkdirOptions }, string> {
  async execute(principal: Principal, args: { path: string; opts: MkdirOptions }): Promise<string> {
    const { path } = args;
    const normPath = this.ctx.pathResolver.normalizePath(path);
    if (!normPath) return 'root';

    const parts = normPath.split('/');
    const name = parts.pop()!;
    const parentPath = parts.join('/');

    while (true) {
      let shouldRetry = false;
      const parentId = await this.ensureDir(principal, parentPath);

      const res = await this.ctx.lockManager.acquire(normPath, async () => {
        if (parentId !== null && !this.ctx.nodeStore.getNode(parentId)) {
          shouldRetry = true; return null;
        }

        const existingId = this.ctx.pathResolver.getIdByPath(normPath);
        if (existingId !== undefined) throw new Error(`Path already exists: ${normPath}`);

        this.ctx.auth.checkNodePermission(principal, parentId, 'write');

        const newNode: VfsNode = {
          id: this.generateId(), name, parentId, kind: 'directory',
          flags: { isSystem: false, isTrashed: false },
          meta: { size: 0, createdAt: Date.now(), updatedAt: Date.now(), version: 1 },
          acl: this.ctx.auth.getDefaultAcl(principal, parentId),
        };

        const tx = this.createTransaction(principal);
        tx.put(newNode);
        await tx.commit();

        return `Created directory: ${normPath}`;
      });

      if (shouldRetry) continue;
      return res!;
    }
  }
}

export class WriteFileOp extends BaseOperation<{ path: string; content: string | Uint8Array | Blob; opts: WriteOptions }, string> {
  async execute(principal: Principal, args: { path: string; content: string | Uint8Array | Blob; opts: WriteOptions }): Promise<string> {
    const { path, content, opts } = args;
    const normPath = this.ctx.pathResolver.normalizePath(path);
    if (!normPath) throw new Error('Cannot write to root path.');

    const parts = normPath.split('/');
    const name = parts.pop()!;
    const parentPath = parts.join('/');

    while (true) {
      let shouldRetry = false;
      const parentId = await this.ensureDir(principal, parentPath);

      const res = await this.ctx.lockManager.acquire(normPath, async () => {
        if (parentId !== null && !this.ctx.nodeStore.getNode(parentId)) {
          shouldRetry = true; return null;
        }

        const existingId = this.ctx.pathResolver.getIdByPath(normPath);
        let node: VfsNode;
        const now = Date.now();
        let eventType = 'create';

        if (existingId !== undefined && existingId !== null) {
          if (!opts.overwrite) throw new Error(`File already exists at ${normPath}. Set overwrite=true to overwrite.`);
          this.ctx.auth.checkNodePermission(principal, existingId, 'write');
          
          const existingNode = this.ctx.nodeStore.getNode(existingId)!;
          if (existingNode.kind === 'directory') throw new Error(`Cannot write file: A directory exists at ${normPath}`);

          node = { ...existingNode };
          node.meta = { ...node.meta, updatedAt: now, version: node.meta.version + 1 };
          delete node.meta.syncState;
          eventType = 'update';
        } else {
          this.ctx.auth.checkNodePermission(principal, parentId, 'write');
          node = {
            id: this.generateId(), name, parentId, kind: 'file',
            flags: { isSystem: !!opts.system, isTrashed: false },
            meta: { size: 0, createdAt: now, updatedAt: now, version: 1 },
            acl: this.ctx.auth.getDefaultAcl(principal, parentId),
          };
        }

        const contentRef = await this.ctx.contentStore.write(node.id, content);
        let size = 0;
        if (typeof content === 'string') size = new Blob([content]).size;
        else if (content instanceof Uint8Array) size = content.byteLength;
        else if (content instanceof Blob) size = content.size;

        node.contentRef = contentRef;
        node.meta.size = size;
        node.meta.hash = await this.calculateHash(content);

        const tx = this.createTransaction(principal);
        tx.put(node);
        await tx.commit();

        return eventType === 'create' ? `Created ${normPath}` : `Overwrote ${normPath}`;
      });

      if (shouldRetry) continue;
      return res!;
    }
  }
}

export class AppendFileOp extends BaseOperation<{ path: string; content: string; opts: WriteOptions }, string> {
  async execute(principal: Principal, args: { path: string; content: string; opts: WriteOptions }): Promise<string> {
    const { path, content, opts } = args;
    const normPath = this.ctx.pathResolver.normalizePath(path);
    if (!normPath) throw new Error('Cannot write to root path.');

    const parts = normPath.split('/');
    const name = parts.pop()!;
    const parentPath = parts.join('/');

    while (true) {
      let shouldRetry = false;
      const parentId = await this.ensureDir(principal, parentPath);

      const res = await this.ctx.lockManager.acquire(normPath, async () => {
        if (parentId !== null && !this.ctx.nodeStore.getNode(parentId)) {
          shouldRetry = true; return null;
        }

        const existingId = this.ctx.pathResolver.getIdByPath(normPath);
        let node: VfsNode;
        const now = Date.now();
        let existingContent = '';

        if (existingId !== undefined && existingId !== null) {
          this.ctx.auth.checkNodePermission(principal, existingId, 'write');
          const existingNode = this.ctx.nodeStore.getNode(existingId)!;
          if (existingNode.kind === 'directory') throw new Error(`Cannot append: A directory exists at ${normPath}`);
          
          if (existingNode.contentRef) {
            existingContent = await this.ctx.contentStore.readText(existingNode.contentRef);
          }
          node = { ...existingNode };
          node.meta = { ...node.meta, updatedAt: now, version: node.meta.version + 1 };
          delete node.meta.syncState;
        } else {
          this.ctx.auth.checkNodePermission(principal, parentId, 'write');
          node = {
            id: this.generateId(), name, parentId, kind: 'file',
            flags: { isSystem: !!opts.system, isTrashed: false },
            meta: { size: 0, createdAt: now, updatedAt: now, version: 1 },
            acl: this.ctx.auth.getDefaultAcl(principal, parentId),
          };
        }

        const newContent = existingContent + (existingContent && !existingContent.endsWith('\n') ? '\n' : '') + content;
        node.contentRef = await this.ctx.contentStore.write(node.id, newContent);
        node.meta.size = new Blob([newContent]).size;
        node.meta.hash = await this.calculateHash(newContent);

        const tx = this.createTransaction(principal);
        tx.put(node);
        await tx.commit();

        return `Appended to ${normPath}`;
      });

      if (shouldRetry) continue;
      return res!;
    }
  }
}

export class CreateStubOp extends BaseOperation<{ path: string; meta: Partial<VfsNodeMeta>; opts: StubOptions }, string> {
  async execute(principal: Principal, args: { path: string; meta: Partial<VfsNodeMeta>; opts: StubOptions }): Promise<string> {
    const { path, meta, opts } = args;
    const normPath = this.ctx.pathResolver.normalizePath(path);

    if (!normPath) throw new Error('Cannot create stub at root.');

    const parts = normPath.split('/');
    const name = parts.pop()!;
    const parentPath = parts.join('/');

    while (true) {
      let shouldRetry = false;
      const parentId = await this.ensureDir(principal, parentPath);

      const res = await this.ctx.lockManager.acquire(normPath, async () => {
        if (parentId !== null && !this.ctx.nodeStore.getNode(parentId)) {
          shouldRetry = true; return null;
        }

        const existingId = this.ctx.pathResolver.getIdByPath(normPath);
        let node: VfsNode;
        const now = Date.now();

        if (existingId !== undefined && existingId !== null) {
          this.ctx.auth.checkNodePermission(principal, existingId, 'write');
          const existingNode = this.ctx.nodeStore.getNode(existingId)!;
          if (existingNode.kind === 'directory') throw new Error(`Cannot create stub: Directory exists at ${normPath}`);

          if (existingNode.contentRef) {
            await this.ctx.contentStore.delete(existingNode.contentRef);
          }
          node = { ...existingNode };
          node.meta = { ...node.meta, ...meta, syncState: 'stub', version: node.meta.version + 1, updatedAt: now };
          delete node.contentRef;
        } else {
          this.ctx.auth.checkNodePermission(principal, parentId, 'write');
          node = {
            id: this.generateId(), name, parentId, kind: 'file',
            flags: { isSystem: false, isTrashed: false },
            meta: {
              size: meta.size || 0, createdAt: meta.createdAt || now, updatedAt: meta.updatedAt || now,
              version: meta.version || 1, hash: meta.hash, syncState: 'stub',
            },
            acl: this.ctx.auth.getDefaultAcl(principal, parentId),
          };
        }

        const tx = this.createTransaction(principal);
        tx.put(node);
        await tx.commit();

        return `Stub created at ${normPath}`;
      });

      if (shouldRetry) continue;
      return res!;
    }
  }
}