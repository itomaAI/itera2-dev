/**
 * src/core/vfs/VfsInitializer.ts
 * Itera OS VFS v2: Boot Initialization and System Reconciliation
 */

import { DEFAULT_FILES, BUILD_TIME } from "../../config/default_files";
import type { VfsService } from "./VfsService";
import type { NodeStore } from "./NodeStore";
import type { PathResolver } from "./PathResolver";
import { SYSTEM_PRINCIPAL } from "./types";

export class VfsInitializer {
  private vfs: VfsService;
  private nodeStore: NodeStore;
  private pathResolver: PathResolver;

  constructor(
    vfs: VfsService,
    nodeStore: NodeStore,
    pathResolver: PathResolver,
  ) {
    this.vfs = vfs;
    this.nodeStore = nodeStore;
    this.pathResolver = pathResolver;
  }

  async initialize(): Promise<void> {
    let deployedCount = 0;
    let updatedCount = 0;

    for (const [key, content] of Object.entries(DEFAULT_FILES)) {
      const isDir = key.endsWith("/");
      const cleanPath = isDir ? key.slice(0, -1) : key;
      const id = this.pathResolver.getIdByPath(cleanPath);

      // 領域の判定
      const isSystemArea = cleanPath.startsWith("system/");
      const isConfigArea = cleanPath.startsWith("system/config/");

      if (id === undefined) {
        // パスが存在しない場合は新規作成
        if (isDir) {
          await this.vfs.mkdir(SYSTEM_PRINCIPAL, cleanPath);
        } else {
          await this.vfs.writeFile(SYSTEM_PRINCIPAL, cleanPath, content, {
            system: isSystemArea,
          });
        }
        deployedCount++;
      } else if (id !== null && !isDir) {
        const node = this.nodeStore.getNode(id);

        // system配下であっても、configはユーザー設定なので強制上書きから除外する
        // （※将来的にJSONディープマージの仕組みをここに実装します）
        const isForceUpdateArea = isSystemArea && !isConfigArea;

        if (node && node.kind === "file" && isForceUpdateArea) {
          await this.vfs.writeFile(SYSTEM_PRINCIPAL, cleanPath, content, {
            overwrite: true,
            system: true,
          });
          updatedCount++;
        }
      }
    }

    // --- 厳密な ACL（権限）の適用 ---
    // system/ 領域は原則 Read-Only (AIやGuestアプリからの破壊を防止)
    if (this.vfs.exists(SYSTEM_PRINCIPAL, "system")) {
      await this.vfs.setAcl(SYSTEM_PRINCIPAL, "system", {
        owner: SYSTEM_PRINCIPAL,
        rules: [{ principal: { type: "any", id: "*" }, permissions: ["read"] }],
      });
    }

    // ただし system/config/ だけはユーザー設定なので Read/Write を許可
    if (this.vfs.exists(SYSTEM_PRINCIPAL, "system/config")) {
      await this.vfs.setAcl(SYSTEM_PRINCIPAL, "system/config", {
        owner: SYSTEM_PRINCIPAL,
        rules: [
          {
            principal: { type: "any", id: "*" },
            permissions: ["read", "write"],
          },
        ],
      });
    }

    // system/cache/ も一時ファイルとして Read/Write を許可
    if (this.vfs.exists(SYSTEM_PRINCIPAL, "system/cache")) {
      await this.vfs.setAcl(SYSTEM_PRINCIPAL, "system/cache", {
        owner: SYSTEM_PRINCIPAL,
        rules: [
          {
            principal: { type: "any", id: "*" },
            permissions: ["read", "write"],
          },
        ],
      });
    }

    if (deployedCount > 0 || updatedCount > 0) {
      console.log(
        `[VfsInitializer] System reconciliation complete. Deployed: ${deployedCount}, Updated: ${updatedCount}`,
      );
    } else {
      console.log("[VfsInitializer] System is up to date.");
    }
  }
}
