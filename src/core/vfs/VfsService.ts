/**
 * src/core/vfs/VfsService.ts
 * Itera OS VFS v2: Main File System API (Facade)
 */

import type {
  VfsNode,
  VfsStat,
  ListOptions,
  WriteOptions,
  DeleteOptions,
  TreeNode,
  Principal,
  PermissionType,
  AccessControlList,
} from "./types";
import type { NodeStore } from "./NodeStore";
import type { ContentStore } from "./ContentStore";
import type { PathResolver } from "./PathResolver";
import type { VfsEventBus } from "./VfsEventBus";
import { VfsLockManager } from "./VfsLockManager";

function generateId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return (
    Math.random().toString(36).substring(2, 15) +
    Math.random().toString(36).substring(2, 15)
  );
}

export class VfsService {
  private nodeStore: NodeStore;
  private contentStore: ContentStore;
  private pathResolver: PathResolver;
  private eventBus: VfsEventBus;
  private lockManager: VfsLockManager;

  constructor(
    nodeStore: NodeStore,
    contentStore: ContentStore,
    pathResolver: PathResolver,
    eventBus: VfsEventBus,
  ) {
    this.nodeStore = nodeStore;
    this.contentStore = contentStore;
    this.pathResolver = pathResolver;
    this.eventBus = eventBus;
    this.lockManager = new VfsLockManager();
  }

  private _hasPermission(
    principal: Principal,
    node: VfsNode,
    action: PermissionType,
  ): boolean {
    if (principal.type === "system") return true;

    const acl = node.acl;
    if (!acl) return true; // Legacy nodes fallback

    // 1. オーナーは無条件で全権限を持つ
    if (acl.owner.type === principal.type && acl.owner.id === principal.id)
      return true;

    // 2. 具体性（Specificity）に基づくルールの評価
    // ルールを探索し、最も条件が限定的な（具体的な）ものを優先的に適用する。
    let exactMatchRule = null; // 例: { type: "agent", id: "Itera_AI" }
    let typeMatchRule = null; // 例: { type: "agent", id: "*" }
    let globalMatchRule = null; // 例: { type: "any", id: "*" }

    for (const rule of acl.rules) {
      if (
        rule.principal.type === principal.type &&
        rule.principal.id === principal.id
      ) {
        exactMatchRule = rule;
      } else if (
        rule.principal.type === principal.type &&
        rule.principal.id === "*"
      ) {
        typeMatchRule = rule;
      } else if (rule.principal.type === "any" && rule.principal.id === "*") {
        globalMatchRule = rule;
      }
    }

    // 優先度順に適用するルールを一つだけ決定する
    const appliedRule = exactMatchRule || typeMatchRule || globalMatchRule;

    if (appliedRule) {
      // 適用されるルールに指定のアクションが含まれていれば許可
      // （※ appliedRule.permissions が空配列 [] の場合は、明示的なアクセス拒否となる）
      return appliedRule.permissions.includes(action);
    }

    // 該当するルールが一切ない場合はデフォルトで拒否（ホワイトリスト方式）
    return false;
  }

  private _checkNodePermission(
    principal: Principal,
    nodeId: string | null,
    action: PermissionType,
  ): void {
    if (principal.type === "system") return;

    if (nodeId === null) {
      // Root directory checks
      // Itera OS のコンセプト上、ルート直下へのファイル・ディレクトリ作成は許可する
      // system などの重要ディレクトリは、各ノードの ACL によって個別に保護される
      return;
    }

    const node = this.nodeStore.getNode(nodeId);
    if (!node) return;

    if (!this._hasPermission(principal, node, action)) {
      throw new Error(
        `Permission Denied: Principal '${principal.type}:${principal.id}' cannot perform '${action}' on '${node.name}'`,
      );
    }
  }

  private _getDefaultAcl(
    principal: Principal,
    parentId: string | null,
  ): AccessControlList {
    if (parentId) {
      const parentNode = this.nodeStore.getNode(parentId);
      if (parentNode && parentNode.acl) {
        // 親のルールを継承しつつ、オーナーは自分にする
        return {
          owner: { ...principal },
          rules: JSON.parse(JSON.stringify(parentNode.acl.rules)),
        };
      }
    }
    // 親がない(ルート直下)などフォールバック
    return {
      owner: { ...principal },
      rules: [
        { principal: { type: "any", id: "*" }, permissions: ["read", "write"] },
      ],
    };
  }

  exists(principal: Principal, path: string): boolean {
    const normPath = this.pathResolver.normalizePath(path);
    const id = this.pathResolver.getIdByPath(normPath);
    if (id === undefined) return false;

    if (id !== null) {
      const node = this.nodeStore.getNode(id);
      if (node && !this._hasPermission(principal, node, "read")) {
        return false; // 権限がない場合は存在を隠蔽（セキュリティ確保）
      }
    }
    return true;
  }

  stat(principal: Principal, path: string): VfsStat {
    const id = this.pathResolver.getIdByPath(path);
    if (id === undefined)
      throw new Error(`File or directory not found: ${path}`);

    this._checkNodePermission(principal, id, "read");

    if (id === null) {
      return {
        id: "",
        path: "",
        name: "root",
        kind: "directory",
        size: 0,
        createdAt: 0,
        updatedAt: 0,
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
    };
  }

  listFiles(
    principal: Principal,
    options: ListOptions & { path?: string } = {},
  ): (string | VfsStat)[] {
    const rootPath = this.pathResolver.normalizePath(options.path || "");
    const rootId = this.pathResolver.getIdByPath(rootPath);

    if (rootId === undefined) throw new Error(`Path not found: ${rootPath}`);
    this._checkNodePermission(principal, rootId, "read");

    if (rootId !== null) {
      const rootNode = this.nodeStore.getNode(rootId)!;
      if (rootNode.kind === "file") {
        return options.detail ? [this.stat(principal, rootPath)] : [rootPath];
      }
    }

    const resultIds: string[] = [];

    const traverse = (parentId: string | null) => {
      const children = this.nodeStore.getChildren(parentId);
      for (const node of children) {
        if (node.flags.isHidden) continue;
        if (!this._hasPermission(principal, node, "read")) continue; // 読めないファイルはリストから除外

        resultIds.push(node.id);
        if (node.kind === "directory" && options.recursive) {
          traverse(node.id);
        }
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
          } as VfsStat;
        }
        return p;
      })
      .sort((a, b) => {
        const strA = typeof a === "string" ? a : (a as VfsStat).path;
        const strB = typeof b === "string" ? b : (b as VfsStat).path;
        return strA.localeCompare(strB);
      });
  }

  private _filterTreeByPermission(
    principal: Principal,
    nodes: TreeNode[],
  ): TreeNode[] {
    if (principal.type === "system") return nodes;
    return nodes.filter((node) => {
      const vfsNode = this.nodeStore.getNode(node.id);
      if (!vfsNode || !this._hasPermission(principal, vfsNode, "read"))
        return false;
      if (node.children) {
        node.children = this._filterTreeByPermission(principal, node.children);
      }
      return true;
    });
  }

  getTree(principal: Principal): TreeNode[] {
    const fullTree = this.pathResolver.buildTree();
    return this._filterTreeByPermission(principal, fullTree);
  }

  getAcl(principal: Principal, path: string): AccessControlList {
    const normPath = this.pathResolver.normalizePath(path);
    const id = this.pathResolver.getIdByPath(normPath);
    if (id === undefined || id === null) {
      throw new Error(`Not found: ${normPath}`);
    }

    this._checkNodePermission(principal, id, "read");
    const node = this.nodeStore.getNode(id)!;

    // オブジェクトのディープコピーを返して安全性を保つ
    return JSON.parse(JSON.stringify(node.acl));
  }

  getUsage(principal: Principal): {
    used: number;
    max: number;
    percent: number;
    isFull: boolean;
  } {
    let used = 0;
    for (const node of this.nodeStore.getAllNodes()) {
      if (
        node.kind === "file" &&
        node.meta.size &&
        this._hasPermission(principal, node, "read")
      ) {
        used += node.meta.size;
      }
    }
    const MAX_SIZE = 1024 * 1024 * 1024;
    return {
      used,
      max: MAX_SIZE,
      percent: Math.min(100, (used / MAX_SIZE) * 100),
      isFull: used >= MAX_SIZE,
    };
  }

  async readFile(principal: Principal, path: string): Promise<string> {
    const normPath = this.pathResolver.normalizePath(path);
    const id = this.pathResolver.getIdByPath(normPath);

    if (id === undefined || id === null) {
      throw new Error(`File not found: ${normPath}`);
    }

    this._checkNodePermission(principal, id, "read");

    const node = this.nodeStore.getNode(id)!;
    if (node.kind !== "file")
      throw new Error(`Cannot read directory as file: ${normPath}`);

    if (!node.contentRef) return "";

    return await this.contentStore.readText(node.contentRef);
  }

  async readBlob(principal: Principal, path: string): Promise<Blob> {
    const normPath = this.pathResolver.normalizePath(path);
    const id = this.pathResolver.getIdByPath(normPath);

    if (id === undefined || id === null)
      throw new Error(`File not found: ${normPath}`);

    this._checkNodePermission(principal, id, "read");

    const node = this.nodeStore.getNode(id)!;
    if (node.kind !== "file")
      throw new Error(`Cannot read directory as file: ${normPath}`);

    if (!node.contentRef) return new Blob([]);

    return await this.contentStore.readBlob(node.contentRef);
  }

  /**
   * ファイルに安全にアトミックな追記を行う (SystemLogger等用)
   */
  async appendFile(
    principal: Principal,
    path: string,
    content: string,
    opts: WriteOptions = {},
  ): Promise<string> {
    const normPath = this.pathResolver.normalizePath(path);
    if (!normPath) throw new Error("Cannot write to root path.");

    // デッドロックを避けるため、親ディレクトリをロック外で確保する
    const parts = normPath.split("/");
    const name = parts.pop()!;
    const parentPath = parts.join("/");
    const parentId = await this._ensureDir(principal, parentPath);

    return this.lockManager.acquire(normPath, async () => {
      const existingId = this.pathResolver.getIdByPath(normPath);
      let node: VfsNode;
      const now = Date.now();
      let existingContent = "";

      if (existingId !== undefined && existingId !== null) {
        this._checkNodePermission(principal, existingId, "write");
        const existingNode = this.nodeStore.getNode(existingId)!;
        if (existingNode.kind === "directory") {
          throw new Error(`Cannot append: A directory exists at ${normPath}`);
        }
        if (existingNode.contentRef) {
          existingContent = await this.contentStore.readText(
            existingNode.contentRef,
          );
        }
        node = { ...existingNode };
        node.meta.updatedAt = now;
        node.meta.version += 1;
      } else {
        this._checkNodePermission(principal, parentId, "write");
        node = {
          id: generateId(),
          name,
          parentId,
          kind: "file",
          flags: { isSystem: !!opts.system, isTrashed: false },
          meta: { size: 0, createdAt: now, updatedAt: now, version: 1 },
          acl: this._getDefaultAcl(principal, parentId),
        };
      }

      const newContent =
        existingContent +
        (existingContent && !existingContent.endsWith("\n") ? "\n" : "") +
        content;

      const contentRef = await this.contentStore.write(node.id, newContent);
      node.contentRef = contentRef;
      node.meta.size = new Blob([newContent]).size;

      await this.nodeStore.putNode(node);
      this.eventBus.publish({
        type: existingId ? "update" : "create",
        nodeId: node.id,
        node,
        path: normPath,
      });

      return `Appended to ${normPath}`;
    });
  }

  async writeFile(
    principal: Principal,
    path: string,
    content: string | Uint8Array | Blob,
    opts: WriteOptions = {},
  ): Promise<string> {
    const normPath = this.pathResolver.normalizePath(path);
    if (!normPath) throw new Error("Cannot write to root path.");

    // 親ディレクトリの解決をロック取得の「前」に行う (デッドロック回避)
    const parts = normPath.split("/");
    const name = parts.pop()!;
    const parentPath = parts.join("/");
    const parentId = await this._ensureDir(principal, parentPath);

    return this.lockManager.acquire(normPath, async () => {
      const existingId = this.pathResolver.getIdByPath(normPath);
      let node: VfsNode;
      const now = Date.now();
      let eventType: "create" | "update" = "create";

      if (existingId !== undefined && existingId !== null) {
        if (!opts.overwrite) {
          throw new Error(
            `File already exists at ${normPath}. Set overwrite=true to overwrite.`,
          );
        }

        this._checkNodePermission(principal, existingId, "write");

        const existingNode = this.nodeStore.getNode(existingId)!;
        if (existingNode.kind === "directory") {
          throw new Error(
            `Cannot write file: A directory already exists at ${normPath}`,
          );
        }

        node = { ...existingNode };
        node.meta.updatedAt = now;
        node.meta.version += 1;
        eventType = "update";
      } else {
        this._checkNodePermission(principal, parentId, "write");

        node = {
          id: generateId(),
          name,
          parentId,
          kind: "file",
          flags: { isSystem: !!opts.system, isTrashed: false },
          meta: { size: 0, createdAt: now, updatedAt: now, version: 1 },
          acl: this._getDefaultAcl(principal, parentId),
        };
      }

      const contentRef = await this.contentStore.write(node.id, content);

      let size = 0;
      if (typeof content === "string") {
        size = new Blob([content]).size;
      } else if (content instanceof Uint8Array) {
        size = content.byteLength;
      } else if (content instanceof Blob) {
        size = content.size;
      }

      node.contentRef = contentRef;
      node.meta.size = size;

      await this.nodeStore.putNode(node);
      this.eventBus.publish({
        type: eventType,
        nodeId: node.id,
        node,
        path: normPath,
      });

      return eventType === "create"
        ? `Created ${normPath}`
        : `Overwrote ${normPath}`;
    });
  }

  async mkdir(principal: Principal, path: string): Promise<string> {
    const normPath = this.pathResolver.normalizePath(path);
    if (!normPath) return "root";

    const parts = normPath.split("/");
    const name = parts.pop()!;
    const parentPath = parts.join("/");

    // 親ディレクトリの解決をロック取得の「前」に行う (デッドロック回避)
    const parentId = await this._ensureDir(principal, parentPath);

    return this.lockManager.acquire(normPath, async () => {
      const existingId = this.pathResolver.getIdByPath(normPath);
      if (existingId !== undefined) {
        throw new Error(`Path already exists: ${normPath}`);
      }

      this._checkNodePermission(principal, parentId, "write");

      const newNode: VfsNode = {
        id: generateId(),
        name,
        parentId,
        kind: "directory",
        flags: { isSystem: false, isTrashed: false },
        meta: {
          size: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          version: 1,
        },
        acl: this._getDefaultAcl(principal, parentId),
      };

      await this.nodeStore.putNode(newNode);
      this.eventBus.publish({
        type: "create",
        nodeId: newNode.id,
        node: newNode,
        path: normPath,
      });

      return `Created directory: ${normPath}`;
    });
  }

  async deleteFile(
    principal: Principal,
    path: string,
    opts: DeleteOptions = {},
  ): Promise<string> {
    const normPath = this.pathResolver.normalizePath(path);

    // ゴミ箱の解決を先に行う
    let trashDirId: string | null = null;
    const isPermanent =
      opts.permanent ||
      normPath === ".trash" ||
      normPath.startsWith(".trash/") ||
      normPath.startsWith("system/cache/") ||
      normPath.startsWith("system/logs/");

    if (!isPermanent) {
      trashDirId = await this._ensureDir(principal, ".trash");
    }

    return this.lockManager.acquire(normPath, async () => {
      const id = this.pathResolver.getIdByPath(normPath);

      if (id === undefined) throw new Error(`Not found: ${normPath}`);
      if (id === null) throw new Error(`Cannot delete root directory.`);

      // 削除権限の厳密なチェック：ファイル自身の write 権限に加え、親ディレクトリの write 権限も要求する
      this._checkNodePermission(principal, id, "write");
      const node = this.nodeStore.getNode(id)!;
      if (node.parentId !== null) {
        this._checkNodePermission(principal, node.parentId, "write");
      }

      if (isPermanent) {
        await this._deleteRecursive(principal, id);
        return `Permanently deleted: ${normPath}`;
      } else {
        const node = this.nodeStore.getNode(id)!;
        const timestamp = Date.now();
        const newName = `${timestamp}_${node.name}`;

        const updatedNode: VfsNode = {
          ...node,
          name: newName,
          parentId: trashDirId!,
          flags: { ...node.flags, isTrashed: true },
          meta: {
            ...node.meta,
            deletedAt: timestamp,
            version: node.meta.version + 1,
          },
        };

        await this.nodeStore.putNode(updatedNode);
        const newPath = this.pathResolver.getPathById(id);

        this.eventBus.publish({
          type: "trash",
          nodeId: id,
          node: updatedNode,
          path: newPath,
          oldPath: normPath,
        });
        return `Moved to trash: ${normPath}`;
      }
    });
  }

  async rename(
    principal: Principal,
    oldPath: string,
    newPath: string,
  ): Promise<string> {
    const normOld = this.pathResolver.normalizePath(oldPath);
    const normNew = this.pathResolver.normalizePath(newPath);

    if (!normOld) throw new Error("Cannot rename root.");
    if (!normNew) throw new Error("Invalid destination path.");

    // 移動先の親ディレクトリ解決をロック前に行う
    const parts = normNew.split("/");
    const newName = parts.pop()!;
    const newParentPath = parts.join("/");
    const newParentId = await this._ensureDir(principal, newParentPath);

    return this.lockManager.acquireMultiple([normOld, normNew], async () => {
      const oldId = this.pathResolver.getIdByPath(normOld);
      if (oldId === undefined || oldId === null)
        throw new Error(`Source not found or cannot be root: ${normOld}`);

      // 移動権限の厳密なチェック：ファイル自身、元の親ディレクトリ、新しい親ディレクトリ全ての write 権限を要求する
      this._checkNodePermission(principal, oldId, "write");
      const node = this.nodeStore.getNode(oldId)!;
      if (node.parentId !== null) {
        this._checkNodePermission(principal, node.parentId, "write");
      }

      const newId = this.pathResolver.getIdByPath(normNew);
      if (newId !== undefined)
        throw new Error(`Destination already exists: ${normNew}`);

      this._checkNodePermission(principal, newParentId, "write");

      if (node.kind === "directory") {
        let cur: string | null = newParentId;
        while (cur !== null) {
          if (cur === node.id) {
            throw new Error("Cannot move a directory into its own subfolder.");
          }
          const parentNode = this.nodeStore.getNode(cur);
          cur = parentNode ? parentNode.parentId : null;
        }
      }

      const updatedNode: VfsNode = {
        ...node,
        name: newName,
        parentId: newParentId,
        meta: {
          ...node.meta,
          updatedAt: Date.now(),
          version: node.meta.version + 1,
        },
      };

      await this.nodeStore.putNode(updatedNode);

      const isMove = node.parentId !== newParentId;
      this.eventBus.publish({
        type: isMove ? "move" : "rename",
        nodeId: oldId,
        node: updatedNode,
        path: normNew,
        oldPath: normOld,
      });

      return `Moved/Renamed: ${normOld} -> ${normNew}`;
    });
  }

  async copyFile(
    principal: Principal,
    srcPath: string,
    destPath: string,
  ): Promise<string> {
    const normSrc = this.pathResolver.normalizePath(srcPath);
    const normDest = this.pathResolver.normalizePath(destPath);

    // コピー先の親ディレクトリ解決をロック前に行う
    const parts = normDest.split("/");
    const newName = parts.pop()!;
    const destParentPath = parts.join("/");
    const destParentId = await this._ensureDir(principal, destParentPath);

    return this.lockManager.acquireMultiple([normSrc, normDest], async () => {
      const srcId = this.pathResolver.getIdByPath(normSrc);
      if (srcId === undefined || srcId === null)
        throw new Error(`Source not found or cannot be root: ${normSrc}`);
      this._checkNodePermission(principal, srcId, "read");

      const destId = this.pathResolver.getIdByPath(normDest);
      if (destId !== undefined)
        throw new Error(`Destination already exists: ${normDest}`);

      const srcNode = this.nodeStore.getNode(srcId)!;

      if (srcNode.kind === "file") {
        if (!srcNode.contentRef) throw new Error("Source file has no content.");
        const blob = await this.contentStore.readBlob(srcNode.contentRef);

        // this.writeFile を呼ぶとデッドロックになるため直接保存する
        this._checkNodePermission(principal, destParentId, "write");
        const newNode: VfsNode = {
          id: generateId(),
          name: newName,
          parentId: destParentId,
          kind: "file",
          flags: { isSystem: srcNode.flags.isSystem, isTrashed: false },
          meta: {
            size: blob.size,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            version: 1,
          },
          acl: this._getDefaultAcl(principal, destParentId),
        };
        newNode.contentRef = await this.contentStore.write(newNode.id, blob);
        await this.nodeStore.putNode(newNode);
        this.eventBus.publish({
          type: "create",
          nodeId: newNode.id,
          node: newNode,
          path: normDest,
        });

        return `Copied file: ${normSrc} -> ${normDest}`;
      } else {
        this._checkNodePermission(principal, destParentId, "write");
        let count = 0;

        const copyRecursive = async (
          sourceDirId: string,
          currentDestParentId: string | null,
        ) => {
          const children = this.nodeStore.getChildren(sourceDirId);
          for (const child of children) {
            if (!child.flags.isTrashed) {
              if (!this._hasPermission(principal, child, "read")) continue;

              const newId = generateId();
              const newNode: VfsNode = {
                id: newId,
                name: child.name,
                parentId: currentDestParentId,
                kind: child.kind,
                flags: { ...child.flags },
                meta: {
                  ...child.meta,
                  createdAt: Date.now(),
                  updatedAt: Date.now(),
                  version: 1,
                },
                acl: this._getDefaultAcl(principal, currentDestParentId),
              };

              if (child.kind === "file") {
                if (child.contentRef) {
                  const blob = await this.contentStore.readBlob(
                    child.contentRef,
                  );
                  newNode.contentRef = await this.contentStore.write(
                    newId,
                    blob,
                  );
                }
                await this.nodeStore.putNode(newNode);
                this.eventBus.publish({
                  type: "create",
                  nodeId: newId,
                  node: newNode,
                  path: this.pathResolver.getPathById(newId),
                });
                count++;
              } else {
                await this.nodeStore.putNode(newNode);
                this.eventBus.publish({
                  type: "create",
                  nodeId: newId,
                  node: newNode,
                  path: this.pathResolver.getPathById(newId),
                });
                await copyRecursive(child.id, newId);
              }
            }
          }
        };

        // コピー元のルートフォルダそのものをコピー先に作成
        const rootNewId = generateId();
        const rootNewNode: VfsNode = {
          id: rootNewId,
          name: newName,
          parentId: destParentId,
          kind: "directory",
          flags: { isSystem: srcNode.flags.isSystem, isTrashed: false },
          meta: {
            size: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            version: 1,
          },
          acl: this._getDefaultAcl(principal, destParentId),
        };
        await this.nodeStore.putNode(rootNewNode);
        this.eventBus.publish({
          type: "create",
          nodeId: rootNewId,
          node: rootNewNode,
          path: normDest,
        });

        await copyRecursive(srcId, rootNewId);
        return `Copied directory: ${normSrc} -> ${normDest} (${count} files)`;
      }
    });
  }

  private async _ensureDir(
    principal: Principal,
    path: string,
  ): Promise<string | null> {
    const normPath = this.pathResolver.normalizePath(path);
    if (!normPath) return null; // root

    // 1. Fast path: 既に存在すればロック不要で即返す
    const existingId = this.pathResolver.getIdByPath(normPath);
    if (existingId !== undefined && existingId !== null) {
      const node = this.nodeStore.getNode(existingId);
      if (node?.kind !== "directory")
        throw new Error(`Path exists but is not a directory: ${normPath}`);
      return existingId;
    }

    const parts = normPath.split("/");
    const name = parts.pop()!;
    const parentPath = parts.join("/");

    // 2. 親ディレクトリの解決をロック取得の「前」に行う (デッドロック回避)
    const parentId = await this._ensureDir(principal, parentPath);

    // 3. 自分自身のロックを取得して作成処理
    return this.lockManager.acquire(normPath, async () => {
      // ロック待ちの間に別の処理が作成していないか再チェック
      const reCheckId = this.pathResolver.getIdByPath(normPath);
      if (reCheckId !== undefined && reCheckId !== null) {
        const node = this.nodeStore.getNode(reCheckId);
        if (node?.kind !== "directory")
          throw new Error(`Path exists but is not a directory: ${normPath}`);
        return reCheckId;
      }

      // 新規作成時のみ親ディレクトリへの書き込み権限をチェック
      this._checkNodePermission(principal, parentId, "write");

      const newNode: VfsNode = {
        id: generateId(),
        name,
        parentId,
        kind: "directory",
        flags: { isSystem: false, isTrashed: false },
        meta: {
          size: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          version: 1,
        },
        acl: this._getDefaultAcl(principal, parentId),
      };

      await this.nodeStore.putNode(newNode);
      this.eventBus.publish({
        type: "create",
        nodeId: newNode.id,
        node: newNode,
        path: normPath,
      });

      return newNode.id;
    });
  }

  private async _deleteRecursive(
    principal: Principal,
    nodeId: string,
  ): Promise<void> {
    const node = this.nodeStore.getNode(nodeId);
    if (!node) return;

    this._checkNodePermission(principal, nodeId, "write");

    if (node.kind === "directory") {
      const children = this.nodeStore.getChildren(nodeId);
      for (const child of children) {
        await this._deleteRecursive(principal, child.id);
      }
    } else {
      if (node.contentRef) {
        await this.contentStore.delete(node.contentRef);
      }
    }

    const path = this.pathResolver.getPathById(nodeId);
    await this.nodeStore.deleteNode(nodeId);

    this.eventBus.publish({ type: "delete", nodeId, node: null, path });
  }

  /**
   * 対象ノードのACLを強制的に書き換える（chmod / chown に相当）
   */
  async setAcl(
    principal: Principal,
    path: string,
    acl: AccessControlList,
  ): Promise<void> {
    const normPath = this.pathResolver.normalizePath(path);

    return this.lockManager.acquire(normPath, async () => {
      const id = this.pathResolver.getIdByPath(normPath);
      if (!id) throw new Error(`Not found: ${normPath}`);

      this._checkNodePermission(principal, id, "manage");

      const node = this.nodeStore.getNode(id)!;
      // ディープコピーして設定
      node.acl = JSON.parse(JSON.stringify(acl));
      await this.nodeStore.putNode(node);
    });
  }

  /**
   * 対象ノードとその子孫すべてのACLを強制的に書き換える
   */
  async setAclRecursive(
    principal: Principal,
    path: string,
    acl: AccessControlList,
  ): Promise<void> {
    const normPath = this.pathResolver.normalizePath(path);

    return this.lockManager.acquire(normPath, async () => {
      const id = this.pathResolver.getIdByPath(normPath);
      if (!id) throw new Error(`Not found: ${normPath}`);

      this._checkNodePermission(principal, id, "manage");

      const applyAcl = async (nodeId: string) => {
        const node = this.nodeStore.getNode(nodeId);
        if (!node) return;

        node.acl = JSON.parse(JSON.stringify(acl));
        await this.nodeStore.putNode(node);

        if (node.kind === "directory") {
          const children = this.nodeStore.getChildren(nodeId);
          for (const child of children) {
            await applyAcl(child.id);
          }
        }
      };

      await applyAcl(id);
    });
  }
}
