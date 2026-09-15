/**
 * src/shell/services/MaintenanceDaemon.ts
 * Itera OS v2: OS Cron & Daemon Manager
 */

import type { ProcessManager } from '../windowing/ProcessManager';
import type { SystemLogger } from '../../core/state/SystemLogger';
import type { VfsService } from '../../core/vfs/VfsService';
import type { NodeStore } from '../../core/vfs/NodeStore';
import type { AppRegistry } from '../../core/sys/AppRegistry';
import { SYSTEM_PRINCIPAL } from '../../core/vfs/types';

export class MaintenanceDaemon {
  private processManager: ProcessManager;
  private logger: SystemLogger;
  private vfs: VfsService;
  private nodeStore: NodeStore;
  private appRegistry: AppRegistry;

  constructor(
    processManager: ProcessManager,
    logger: SystemLogger,
    vfs: VfsService,
    nodeStore: NodeStore,
    appRegistry: AppRegistry,
  ) {
    this.processManager = processManager;
    this.logger = logger;
    this.vfs = vfs;
    this.nodeStore = nodeStore;
    this.appRegistry = appRegistry;
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
      // 🔴 services.json を直接読まない。登録簿は層（配信 → 利用者）になっていて、
      // 重ねた値を持つのは AppRegistry だけ。ここが直読みだと、利用者が `autoStart: false` を
      // 自分の層に置いても配信のデーモンが起動し続ける（T-0447 で見つけた穴）。
      const services = this.appRegistry.getAllServices();
      for (const svc of services) {
        // 新スキーマ: id が指定されており、autoStart が true のものだけを起動
        if (svc.id && svc.path && svc.autoStart) {
          await this.processManager.spawn({ pid: svc.id, path: svc.path, type: 'daemon' });
        }
      }
    } catch (e) {
      console.warn('[MaintenanceDaemon] Failed to start background services', e);
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

        if (!this.vfs.exists(SYSTEM_PRINCIPAL, 'system/backups')) {
          await this.vfs.mkdir(SYSTEM_PRINCIPAL, 'system/backups');
        }

        await this.vfs.writeFile(SYSTEM_PRINCIPAL, 'system/backups/index_auto_backup.json', indexJson, {
          overwrite: true,
          system: true,
        });
      }

      if (purged > 0) {
        console.log(`[MaintenanceDaemon] Daily maintenance completed. Purged ${purged} old logs.`);
      } else {
        console.log(`[MaintenanceDaemon] Daily maintenance completed.`);
      }
    } catch (e) {
      console.error('[MaintenanceDaemon] Daily maintenance failed:', e);
    }
  }
}
