/**
 * src/core/vfs/VfsTransaction.ts
 * Itera OS VFS v2: Unit of Work and Mutation Generator
 */

import type { VfsNode, VfsMutation, Principal } from './types';
import type { NodeStore } from './NodeStore';
import type { PathResolver } from './PathResolver';
import type { VfsEventBus } from './VfsEventBus';

export class VfsTransaction {
  private nodeStore: NodeStore;
  private pathResolver: PathResolver;
  private eventBus: VfsEventBus;
  private principal: Principal;

  private puts: Map<string, VfsNode> = new Map();
  private deletes: Set<string> = new Set();

  constructor(nodeStore: NodeStore, pathResolver: PathResolver, eventBus: VfsEventBus, principal: Principal) {
    this.nodeStore = nodeStore;
    this.pathResolver = pathResolver;
    this.eventBus = eventBus;
    this.principal = principal;
  }

  /**
   * ノードの追加または更新をトランザクションに登録する
   */
  put(node: VfsNode): void {
    this.puts.set(node.id, node);
    this.deletes.delete(node.id);
  }

  /**
   * ノードの削除をトランザクションに登録する
   */
  delete(id: string): void {
    this.deletes.add(id);
    this.puts.delete(id);
  }

  /**
   * トランザクションをIndexedDBにコミットし、成功時にMutationイベントを発行する
   */
  async commit(): Promise<void> {
    if (this.puts.size === 0 && this.deletes.size === 0) return;

    // 1. コミット前の状態（Old State）を保存
    const originalNodes = new Map<string, VfsNode>();
    const oldPaths = new Map<string, string>();

    const allIds = new Set([...this.puts.keys(), ...this.deletes.keys()]);
    for (const id of allIds) {
      const node = this.nodeStore.getNode(id);
      if (node) {
        originalNodes.set(id, JSON.parse(JSON.stringify(node))); // ディープコピーで保存
        oldPaths.set(id, this.pathResolver.getPathById(id));
      }
    }

    const putsArray = Array.from(this.puts.values());
    const deletesArray = Array.from(this.deletes.values());

    // 2. データベースへの一括コミット（アトミックな書き込み）
    await this.nodeStore.commitTransaction(putsArray, deletesArray);

    // 3. Mutation の生成（差分の計算）
    const mutations: VfsMutation[] = [];

    // [DETACH] 削除されたノードの処理
    for (const id of deletesArray) {
      const oldPath = oldPaths.get(id);
      if (oldPath) {
        mutations.push({
          type: 'DETACH',
          nodeId: id,
          node: null,
          path: oldPath,
          sourcePrincipal: this.principal,
        });
      }
    }

    // [ATTACH / MUTATE] 追加・更新されたノードの処理
    for (const node of putsArray) {
      const oldNode = originalNodes.get(node.id);
      const newPath = this.pathResolver.getPathById(node.id);

      if (!oldNode) {
        // 新規作成
        mutations.push({
          type: 'ATTACH',
          nodeId: node.id,
          node: node,
          path: newPath,
          sourcePrincipal: this.principal,
        });
      } else {
        const oldPath = oldPaths.get(node.id)!;

        if (oldPath !== newPath) {
          // 移動・リネームは「旧パスからのDETACH」と「新パスへのATTACH」として表現
          mutations.push({
            type: 'DETACH',
            nodeId: node.id,
            node: null,
            path: oldPath,
            sourcePrincipal: this.principal,
          });
          mutations.push({
            type: 'ATTACH',
            nodeId: node.id,
            node: node,
            path: newPath,
            sourcePrincipal: this.principal,
          });
        } else {
          // パスが同じならプロパティの差分を計算
          const changed: string[] = [];
          if (oldNode.meta.size !== node.meta.size) changed.push('size');
          if (oldNode.meta.updatedAt !== node.meta.updatedAt) changed.push('updatedAt');
          if (oldNode.meta.hash !== node.meta.hash) changed.push('hash');
          if (oldNode.meta.syncState !== node.meta.syncState) changed.push('syncState');
          if (oldNode.contentRef?.key !== node.contentRef?.key) changed.push('contentRef');
          if (JSON.stringify(oldNode.acl) !== JSON.stringify(node.acl)) changed.push('acl');
          if (JSON.stringify(oldNode.flags) !== JSON.stringify(node.flags)) changed.push('flags');

          if (changed.length > 0) {
            mutations.push({
              type: 'MUTATE',
              nodeId: node.id,
              node: node,
              path: newPath,
              changedProperties: changed,
              sourcePrincipal: this.principal,
            });
          }
        }
      }
    }

    // 4. イベントバスへのディスパッチ
    for (const mutation of mutations) {
      this.eventBus.publish(mutation);
    }
  }
}
