/**
 * src/core/vfs/VfsFsck.ts
 * Itera OS v2: File System Consistency Checker
 */

import type { NodeStore } from "./NodeStore";
import type { ContentStore } from "./ContentStore";
import type { VfsNode } from "./types";

export interface FsckReport {
  circularReferencesFixed: number;
  orphansRescued: number;
  missingContentsFixed: number;
  danglingContentsRescued: number;
  totalErrorsFixed: number;
}

export class VfsFsck {
  private nodeStore: NodeStore;
  private contentStore: ContentStore;

  constructor(nodeStore: NodeStore, contentStore: ContentStore) {
    this.nodeStore = nodeStore;
    this.contentStore = contentStore;
  }

  private _generateId(): string {
    if (typeof crypto !== "undefined" && crypto.randomUUID)
      return crypto.randomUUID();
    return (
      Math.random().toString(36).substring(2, 15) +
      Math.random().toString(36).substring(2, 15)
    );
  }

  /**
   * VFSの不整合を検査し、安全な状態に修復する
   */
  async runRepair(): Promise<FsckReport> {
    const report: FsckReport = {
      circularReferencesFixed: 0,
      orphansRescued: 0,
      missingContentsFixed: 0,
      danglingContentsRescued: 0,
      totalErrorsFixed: 0,
    };

    const allNodes = Array.from(this.nodeStore.getAllNodes());
    const nodesMap = new Map<string, VfsNode>();
    // メモリ上のオブジェクト参照を保持
    allNodes.forEach((n) => nodesMap.set(n.id, n));

    // ヘルパー: .lost+found ディレクトリの確保
    let lostAndFoundId: string | null = null;
    const getLostAndFoundId = async () => {
      if (lostAndFoundId) return lostAndFoundId;
      const existing = allNodes.find(
        (n) =>
          n.parentId === null &&
          n.name === ".lost+found" &&
          n.kind === "directory",
      );
      if (existing) {
        lostAndFoundId = existing.id;
        return existing.id;
      }
      lostAndFoundId = this._generateId();
      const lfNode: VfsNode = {
        id: lostAndFoundId,
        name: ".lost+found",
        parentId: null,
        kind: "directory",
        flags: { isSystem: true, isTrashed: false, isHidden: true },
        meta: {
          size: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          version: 1,
        },
        acl: {
          owner: { type: "system", id: "fsck" },
          rules: [
            {
              principal: { type: "any", id: "*" },
              permissions: ["read", "write", "manage"],
            },
          ],
        },
      };
      await this.nodeStore.putNode(lfNode);
      nodesMap.set(lfNode.id, lfNode);
      return lostAndFoundId;
    };

    // 1. 循環参照（Circular References）の切断
    for (const node of nodesMap.values()) {
      let currentId: string | null = node.parentId;
      const visited = new Set<string>([node.id]);
      let isCircular = false;

      while (currentId !== null) {
        if (visited.has(currentId)) {
          isCircular = true;
          break;
        }
        visited.add(currentId);
        const parent = nodesMap.get(currentId);
        currentId = parent ? parent.parentId : null;
      }

      if (isCircular) {
        node.parentId = null; // ループを切断し、強制的にルート直下へ移動
        await this.nodeStore.putNode(node);
        report.circularReferencesFixed++;
      }
    }

    // 2. 孤児ノード（Orphans）の救済
    for (const node of nodesMap.values()) {
      if (node.parentId !== null && !nodesMap.has(node.parentId)) {
        // 親が見つからない場合、.lost+found へ移動
        const lfId = await getLostAndFoundId();
        node.parentId = lfId;
        await this.nodeStore.putNode(node);
        report.orphansRescued++;
      }
    }

    // 3. 実体とインデックスの不一致の修復
    const allContentKeys = await this.contentStore.getAllKeys();
    const contentKeySet = new Set(allContentKeys);
    const referencedKeys = new Set<string>();

    // 現在アクティブなストレージバックエンド（opfs or memory）を判定
    let activeBackend: "opfs" | "memory" = "memory";
    try {
      const testRef = await this.contentStore.write("__fsck_test__", "test");
      activeBackend = testRef.backend;
      await this.contentStore.delete(testRef);
      contentKeySet.delete("__fsck_test__"); // 念のためリストから除外
    } catch (e) {
      console.warn(
        "[VfsFsck] Failed to detect active backend, falling back to memory.",
      );
    }

    for (const node of nodesMap.values()) {
      if (node.kind === "file" && node.contentRef) {
        referencedKeys.add(node.contentRef.key);

        // A. インデックスはあるが実体がない場合（Missing Content）
        if (!contentKeySet.has(node.contentRef.key)) {
          // エラークラッシュを防ぐため、空ファイルとして実体を再生成してリンクし直す
          const newRef = await this.contentStore.write(node.id, "");
          node.contentRef = newRef;
          node.meta.size = 0;
          await this.nodeStore.putNode(node);
          report.missingContentsFixed++;
        }
      }
    }

    // 4. 実体はあるがインデックスがない場合（Dangling Content）
    for (const key of contentKeySet) {
      if (!referencedKeys.has(key)) {
        // .lost+found 内に recovered_file としてメタデータを新造し、実体を復活させる
        const lfId = await getLostAndFoundId();
        const newFileId = this._generateId();

        const newNode: VfsNode = {
          id: newFileId,
          name: `recovered_file_${key}`,
          parentId: lfId,
          kind: "file",
          contentRef: { backend: activeBackend, key },
          flags: { isSystem: false, isTrashed: false },
          meta: {
            size: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            version: 1,
          },
          acl: {
            owner: { type: "system", id: "fsck" },
            rules: [
              {
                principal: { type: "any", id: "*" },
                permissions: ["read", "write", "manage"],
              },
            ],
          },
        };

        await this.nodeStore.putNode(newNode);
        nodesMap.set(newNode.id, newNode);
        report.danglingContentsRescued++;
      }
    }

    report.totalErrorsFixed =
      report.circularReferencesFixed +
      report.orphansRescued +
      report.missingContentsFixed +
      report.danglingContentsRescued;

    if (report.totalErrorsFixed > 0) {
      console.warn(
        `[VfsFsck] Repair complete. Fixed ${report.totalErrorsFixed} issues.`,
        report,
      );
    } else {
      console.log(`[VfsFsck] File system is clean. No errors found.`);
    }

    return report;
  }
}
