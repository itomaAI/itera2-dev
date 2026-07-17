/**
 * src/core/vfs/operations/AclOps.ts
 * Itera OS VFS v2: ACL Operations
 */

import { BaseOperation } from './BaseOperation';
import type { Principal, AccessControlList } from '../types';

export class SetAclOp extends BaseOperation<{ path: string; acl: AccessControlList }, void> {
  async execute(principal: Principal, args: { path: string; acl: AccessControlList }): Promise<void> {
    const normPath = this.ctx.pathResolver.normalizePath(args.path);

    return this.ctx.lockManager.acquire(normPath, async () => {
      const id = this.ctx.pathResolver.getIdByPath(normPath);
      if (!id) throw new Error(`Not found: ${normPath}`);

      this.ctx.auth.checkNodePermission(principal, id, 'manage');
      const node = this.ctx.nodeStore.getNode(id)!;

      const updatedNode = { ...node, acl: JSON.parse(JSON.stringify(args.acl)) };

      const tx = this.createTransaction(principal);
      tx.put(updatedNode);
      await tx.commit();
    });
  }
}

export class SetAclRecursiveOp extends BaseOperation<{ path: string; acl: AccessControlList }, void> {
  async execute(principal: Principal, args: { path: string; acl: AccessControlList }): Promise<void> {
    const normPath = this.ctx.pathResolver.normalizePath(args.path);

    return this.ctx.lockManager.acquire(normPath, async () => {
      const id = this.ctx.pathResolver.getIdByPath(normPath);
      if (!id) throw new Error(`Not found: ${normPath}`);

      this.ctx.auth.checkNodePermission(principal, id, 'manage');

      const tx = this.createTransaction(principal);

      const applyAcl = (nodeId: string) => {
        const node = this.ctx.nodeStore.getNode(nodeId);
        if (!node) return;

        const updatedNode = { ...node, acl: JSON.parse(JSON.stringify(args.acl)) };
        tx.put(updatedNode);

        if (node.kind === 'directory') {
          const children = this.ctx.nodeStore.getChildren(nodeId);
          for (const child of children) {
            applyAcl(child.id);
          }
        }
      };

      applyAcl(id);
      await tx.commit();
    });
  }
}
