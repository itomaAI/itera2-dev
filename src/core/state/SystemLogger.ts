/**
 * src/core/state/SystemLogger.ts
 * Itera OS v2: System Logger
 */

import type { VfsService } from '../vfs/VfsService';
import { SYSTEM_PRINCIPAL, type VfsStat } from '../vfs/types';

export class SystemLogger {
  private vfs: VfsService;
  private baseDir = 'system/logs';
  private logBuffer: Map<string, any[]> = new Map();
  private flushTimerId: ReturnType<typeof setTimeout> | null = null;

  constructor(vfs: VfsService) {
    this.vfs = vfs;
  }

  private _getDateString(): string {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  }

  /**
   * 汎用ロギングメソッド。メモリにバッファリングし、無音になってから一括で追記する。
   * @param category ログのカテゴリ (例: 'system', 'usage', 'error')
   * @param payload 記録したい任意のデータオブジェクト
   */
  async log(category: string, payload: any): Promise<void> {
    if (!category || !payload) return;

    if (!this.logBuffer.has(category)) {
      this.logBuffer.set(category, []);
    }

    const entry = {
      timestamp: new Date().toISOString(),
      ...payload,
    };

    this.logBuffer.get(category)!.push(entry);

    if (this.flushTimerId !== null) {
      clearTimeout(this.flushTimerId);
    }

    this.flushTimerId = setTimeout(() => {
      this._flush();
    }, 2000);
  }

  private async _flush(): Promise<void> {
    const bufferToFlush = this.logBuffer;
    this.logBuffer = new Map();
    this.flushTimerId = null;

    const dateStr = this._getDateString();

    for (const [category, entries] of bufferToFlush.entries()) {
      if (entries.length === 0) continue;

      const path = `${this.baseDir}/${category}/${dateStr}.jsonl`;
      const chunk = entries.map((entry) => JSON.stringify(entry)).join('\n');

      try {
        await this.vfs.appendFile(SYSTEM_PRINCIPAL, path, chunk, {
          system: true,
        });
      } catch (e) {
        console.error(`[SystemLogger] Failed to write batched logs to ${path}:`, e);
      }
    }
  }

  /**
   * 指定した日数より古いログファイルをVFSから削除する。
   * @param days 保持する日数
   * @returns 削除したファイル数
   */
  async purgeOldLogs(days: number = 7): Promise<number> {
    let count = 0;
    try {
      const threshold = Date.now() - days * 24 * 60 * 60 * 1000;

      if (!this.vfs.exists(SYSTEM_PRINCIPAL, this.baseDir)) return 0;

      const files = this.vfs.listFiles(SYSTEM_PRINCIPAL, {
        path: this.baseDir,
        recursive: true,
        detail: true,
      }) as VfsStat[];

      for (const file of files) {
        if (file.kind === 'file' && file.path.endsWith('.jsonl')) {
          if (file.updatedAt < threshold) {
            try {
              // permanent: true でゴミ箱を経由せず完全削除
              await this.vfs.deleteFile(SYSTEM_PRINCIPAL, file.path, {
                permanent: true,
              });
              count++;
            } catch (e) {
              console.warn(`[SystemLogger] Failed to purge log: ${file.path}`, e);
            }
          }
        }
      }

      if (count > 0) {
        console.log(`[SystemLogger] Purged ${count} old log files.`);
      }
    } catch (e) {
      console.warn('[SystemLogger] Purge failed:', e);
    }
    return count;
  }
}
