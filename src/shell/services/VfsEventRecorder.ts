/**
 * src/shell/services/VfsEventRecorder.ts
 * Itera OS v2: VFS Event Recorder
 */

import type { VfsEventBus } from '../../core/vfs/VfsEventBus';
import type { SystemLogger } from '../../core/state/SystemLogger';
import type { VfsMutation } from '../../core/vfs/types';

export class VfsEventRecorder {
  private eventBus: VfsEventBus;
  private logger: SystemLogger;

  constructor(eventBus: VfsEventBus, logger: SystemLogger) {
    this.eventBus = eventBus;
    this.logger = logger;
  }

  public start(): void {
    this.eventBus.subscribe((mutations) => this._processMutations(mutations));
  }

  private _processMutations(mutations: VfsMutation[]): void {
    // ログや一時ファイルの変更は無限ループのノイズになるため厳格に除外
    const relevantMutations = mutations.filter(
      (m) => !m.path.startsWith('system/logs/') && !m.path.startsWith('system/temp/'),
    );

    if (relevantMutations.length === 0) return;

    for (const m of relevantMutations) {
      this.logger.log('vfs_events', {
        action: m.type,
        path: m.path,
        source: `${m.sourcePrincipal.type}:${m.sourcePrincipal.id}`,
        // MUTATE時の変更されたプロパティもログに残しておく
        ...(m.changedProperties ? { changed: m.changedProperties } : {}),
      });
    }
  }
}
