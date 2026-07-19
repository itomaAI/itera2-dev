/**
 * src/core/vfs/VfsAuth.ts
 * Itera OS VFS v2: Access Control & Permissions
 */

import type { NodeStore } from './NodeStore';
import { AGENT_PRINCIPAL, type Principal, type PermissionType, type VfsNode, type AccessControlList } from './types';

export class VfsAuth {
  private nodeStore: NodeStore;

  constructor(nodeStore: NodeStore) {
    this.nodeStore = nodeStore;
  }

  hasPermission(principal: Principal, node: VfsNode, action: PermissionType): boolean {
    if (principal.type === 'system') return true;

    const acl = node.acl;
    if (!acl) return true; // Legacy nodes fallback

    // 1. オーナーは無条件で全権限を持つ
    if (acl.owner.type === principal.type && acl.owner.id === principal.id) return true;

    // 2. 具体性に基づくルールの評価
    let exactMatchRule = null;
    let typeMatchRule = null;
    let globalMatchRule = null;

    for (const rule of acl.rules) {
      if (rule.principal.type === principal.type && rule.principal.id === principal.id) {
        exactMatchRule = rule;
      } else if (rule.principal.type === principal.type && rule.principal.id === '*') {
        typeMatchRule = rule;
      } else if (rule.principal.type === 'any' && rule.principal.id === '*') {
        globalMatchRule = rule;
      }
    }

    const appliedRule = exactMatchRule || typeMatchRule || globalMatchRule;

    if (appliedRule) {
      return appliedRule.permissions.includes(action);
    }
    return false;
  }

  checkNodePermission(principal: Principal, nodeId: string | null, action: PermissionType): void {
    if (principal.type === 'system') return;

    if (nodeId === null) {
      // ルート直下は許可するポリシー
      return;
    }

    const node = this.nodeStore.getNode(nodeId);
    if (!node) return;

    if (!this.hasPermission(principal, node, action)) {
      throw new Error(
        `Permission Denied: Principal '${principal.type}:${principal.id}' cannot perform '${action}' on '${node.name}'`,
      );
    }
  }

  getDefaultAcl(principal: Principal, parentId: string | null): AccessControlList {
    if (parentId) {
      const parentNode = this.nodeStore.getNode(parentId);
      if (parentNode && parentNode.acl) {
        return {
          owner: { ...principal },
          rules: JSON.parse(JSON.stringify(parentNode.acl.rules)),
        };
      }
    }
    return {
      owner: { ...principal },
      rules: [
        { principal: { type: 'user', id: 'local_user' }, permissions: ['read', 'write', 'manage'] },
        { principal: { ...AGENT_PRINCIPAL }, permissions: ['read', 'write'] },
        { principal: { type: 'any', id: '*' }, permissions: ['read', 'write'] },
      ],
    };
  }
}
