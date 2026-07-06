/**
 * src/core/vfs/PathResolver.ts
 * Itera OS VFS v2: Path to NodeID Resolution and Tree Building
 */

import type { VfsNode, TreeNode } from "./types";
import type { NodeStore } from "./NodeStore";

export class PathResolver {
  private nodeStore: NodeStore;

  constructor(nodeStore: NodeStore) {
    this.nodeStore = nodeStore;
  }

  normalizePath(path: string): string {
    if (!path) return "";
    const parts = path
      .replace(/\\/g, "/")
      .split("/")
      .filter((p) => p !== "." && p !== "");
    const stack: string[] = [];

    for (const part of parts) {
      if (part === "..") {
        if (stack.length > 0) stack.pop();
      } else {
        stack.push(part);
      }
    }
    return stack.join("/");
  }

  getIdByPath(path: string): string | null | undefined {
    const normPath = this.normalizePath(path);
    if (normPath === "") return null; // ルートを示す

    const parts = normPath.split("/");
    let currentParentId: string | null = null;

    for (const part of parts) {
      let foundNode: VfsNode | undefined;

      for (const node of this.nodeStore.getAllNodes()) {
        if (node.parentId === currentParentId && node.name === part) {
          foundNode = node;
          break;
        }
      }

      if (!foundNode) {
        return undefined; // 途中で見つからなければ存在しない
      }
      currentParentId = foundNode.id;
    }

    return currentParentId;
  }

  getPathById(nodeId: string | null): string {
    if (nodeId === null) return "";

    const parts: string[] = [];
    let currentId: string | null = nodeId;
    const visited = new Set<string>(); // 循環参照防止用

    while (currentId !== null) {
      if (visited.has(currentId)) {
        console.error(
          `[PathResolver] Circular reference detected at NodeID: ${currentId}`,
        );
        break;
      }
      visited.add(currentId);

      const node = this.nodeStore.getNode(currentId);
      if (!node) {
        console.warn(
          `[PathResolver] Broken link detected at NodeID: ${currentId}`,
        );
        break;
      }
      parts.unshift(node.name);
      currentId = node.parentId;
    }

    return parts.join("/");
  }

  buildTree(): TreeNode[] {
    const childrenMap = new Map<string | null, VfsNode[]>();

    for (const node of this.nodeStore.getAllNodes()) {
      const pId = node.parentId;
      if (!childrenMap.has(pId)) {
        childrenMap.set(pId, []);
      }
      childrenMap.get(pId)!.push(node);
    }

    const buildNode = (node: VfsNode, currentPath: string): TreeNode => {
      const fullPath = currentPath ? `${currentPath}/${node.name}` : node.name;
      const treeNode: TreeNode = {
        id: node.id,
        name: node.name,
        path: fullPath,
        kind: node.kind,
        meta: node.meta,
      };

      if (node.kind === "directory") {
        const children = childrenMap.get(node.id) || [];
        treeNode.children = children.map((child) => buildNode(child, fullPath));

        treeNode.children.sort((a, b) => {
          if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      }

      return treeNode;
    };

    const rootNodes = childrenMap.get(null) || [];
    const result = rootNodes.map((node) => buildNode(node, ""));

    result.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return result;
  }
}
