/**
 * src/core/vfs/operations/BaseOperation.ts
 * Itera OS VFS v2: Base Operation Pipeline
 */

import type { Principal, VfsNode } from '../types';
import type { NodeStore } from '../NodeStore';
import type { ContentStore } from '../ContentStore';
import type { PathResolver } from '../PathResolver';
import type { VfsEventBus } from '../VfsEventBus';
import type { VfsLockManager } from '../VfsLockManager';
import type { VfsAuth } from '../VfsAuth';
import type { VfsService } from '../VfsService';
import { VfsTransaction } from '../VfsTransaction';
import type { ProviderManager } from '../ProviderManager';
import { generateId } from '../../../utils/id';
import { VFS_HARD_LIMITS } from '../../../config/constants';

export interface VfsContext {
  nodeStore: NodeStore;
  contentStore: ContentStore;
  pathResolver: PathResolver;
  eventBus: VfsEventBus;
  lockManager: VfsLockManager;
  auth: VfsAuth;
  vfs: VfsService; // 再帰的なhydrateなどに必要
  providerManager?: ProviderManager;
}

export abstract class BaseOperation<TArgs, TReturn> {
  protected ctx: VfsContext;

  constructor(ctx: VfsContext) {
    this.ctx = ctx;
  }

  abstract execute(principal: Principal, args: TArgs): Promise<TReturn>;

  protected generateId(): string {
    return generateId();
  }

  protected async calculateHash(content: string | Uint8Array | Blob): Promise<string> {
    let data: ArrayBuffer;
    if (typeof content === 'string') {
      data = new TextEncoder().encode(content).buffer as ArrayBuffer;
    } else if (content instanceof Uint8Array) {
      data = content.buffer as ArrayBuffer;
    } else if (content instanceof Blob) {
      data = await content.arrayBuffer();
    } else {
      return '';
    }
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  protected checkQuota(sizeDelta: number, isSystem: boolean): void {
    if (sizeDelta <= 0) return; // 削除や縮小の場合は無条件で許可

    const currentSize = this.ctx.nodeStore.getTotalSize();
    const newSize = currentSize + sizeDelta;
    let limit = VFS_HARD_LIMITS.MAX_STORAGE_BYTES;

    // ユーザー/Guest操作の場合はシステム予約領域を差し引いた値を上限とする
    if (!isSystem) {
      limit -= VFS_HARD_LIMITS.SYSTEM_RESERVE_BYTES;
    }

    if (newSize > limit) {
      throw new Error(`VFS Quota Exceeded. Storage is full.`);
    }
  }

  protected calculateSize(content: string | Uint8Array | Blob): number {
    if (typeof content === 'string') {
      return new Blob([content]).size;
    } else if (content instanceof Uint8Array) {
      return content.byteLength;
    } else if (content instanceof Blob) {
      return content.size;
    }
    return 0;
  }

  protected createTransaction(principal: Principal): VfsTransaction {
    return new VfsTransaction(this.ctx.nodeStore, this.ctx.pathResolver, this.ctx.eventBus, principal);
  }

  protected async ensureDir(principal: Principal, path: string): Promise<string | null> {
    const normPath = this.ctx.pathResolver.normalizePath(path);
    if (!normPath) return null; // root

    const existingId = this.ctx.pathResolver.getIdByPath(normPath);
    if (existingId !== undefined && existingId !== null) {
      const node = this.ctx.nodeStore.getNode(existingId);
      if (node?.kind !== 'directory') throw new Error(`Path exists but is not a directory: ${normPath}`);
      return existingId;
    }

    const parts = normPath.split('/');
    const name = parts.pop()!;
    const parentPath = parts.join('/');

    const parentId = await this.ensureDir(principal, parentPath);

    return this.ctx.lockManager.acquire(normPath, async () => {
      const reCheckId = this.ctx.pathResolver.getIdByPath(normPath);
      if (reCheckId !== undefined && reCheckId !== null) {
        const node = this.ctx.nodeStore.getNode(reCheckId);
        if (node?.kind !== 'directory') throw new Error(`Path exists but is not a directory: ${normPath}`);
        return reCheckId;
      }

      this.ctx.auth.checkNodePermission(principal, parentId, 'write');

      const newNode: VfsNode = {
        id: this.generateId(),
        name,
        parentId,
        kind: 'directory',
        flags: { isSystem: false, isTrashed: false },
        meta: { size: 0, createdAt: Date.now(), updatedAt: Date.now(), version: 1 },
        acl: this.ctx.auth.getDefaultAcl(principal, parentId),
      };

      const tx = this.createTransaction(principal);
      tx.put(newNode);
      await tx.commit();

      return newNode.id;
    });
  }
}
