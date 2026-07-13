/**
 * src/shell/services/MaintenanceDaemon.ts
 * Itera OS v2: OS Cron & Daemon Manager
 */

import type { ProcessManager } from "../windowing/ProcessManager";
import type { SystemLogger } from "../../core/state/SystemLogger";
import type { VfsService } from "../../core/vfs/VfsService";
import type { NodeStore } from "../../core/vfs/NodeStore";
import { SYSTEM_PRINCIPAL } from "../../core/vfs/types";

export class MaintenanceDaemon {
  private processManager: ProcessManager;
  private logger: SystemLogger;
  private vfs: VfsService;
  private nodeStore: NodeStore;

  constructor(
    processManager: ProcessManager,
    logger: SystemLogger,
    vfs: VfsService,
    nodeStore: NodeStore,
  ) {
    this.processManager = processManager;
    this.logger = logger;
    this.vfs = vfs;
    this.nodeStore = nodeStore;
  }

  public async start(): Promise<void> {
    await this._startInitialDaemons();

    // Initial run
    this._performDailyMaintenance();

    // Run every 24 hours
    setInterval(
      () => {
        this._performDailyMaintenance();
      },
      24 * 60 * 60 * 1000,
    );
  }

  private async _startInitialDaemons(): Promise<void> {
    try {
      let services: any[] = [];
      const registryPath = "system/registry/services.json";

      if (this.vfs.exists(SYSTEM_PRINCIPAL, registryPath)) {
        const content = await this.vfs.readFile(SYSTEM_PRINCIPAL, registryPath);
        services = JSON.parse(content);
      }
      for (const svc of services) {
        if (svc.pid && svc.path) {
          await this.processManager.spawn(svc.pid, svc.path, "background");
        }
      }
    } catch (e) {
      console.warn(
        "[MaintenanceDaemon] Failed to start background services",
        e,
      );
    }
  }

  private async _performDailyMaintenance(): Promise<void> {
    try {
      let purged = 0;
      if (this.logger) {
        purged = await this.logger.purgeOldLogs(7);
      }

      // Metadata Auto Backup
      if (this.nodeStore && this.vfs) {
        const indexJson = this.nodeStore.exportIndex();

        if (!this.vfs.exists(SYSTEM_PRINCIPAL, "system/backups")) {
          await this.vfs.mkdir(SYSTEM_PRINCIPAL, "system/backups");
        }

        await this.vfs.writeFile(
          SYSTEM_PRINCIPAL,
          "system/backups/index_auto_backup.json",
          indexJson,
          { overwrite: true, system: true },
        );
      }

      if (purged > 0) {
        console.log(
          `[MaintenanceDaemon] Daily maintenance completed. Purged ${purged} old logs.`,
        );
      } else {
        console.log(`[MaintenanceDaemon] Daily maintenance completed.`);
      }
    } catch (e) {
      console.error("[MaintenanceDaemon] Daily maintenance failed:", e);
    }
  }
}
