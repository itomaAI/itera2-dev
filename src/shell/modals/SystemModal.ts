/**
 * src/shell/modals/SystemModal.ts
 * Itera OS v2: System Management (ZIP Export/Import & Reset)
 */

import type { VfsService } from '../../core/vfs/VfsService';
import type { NodeStore } from '../../core/vfs/NodeStore';
import type { ContentStore } from '../../core/vfs/ContentStore';
import { VfsFsck } from '../../core/vfs/VfsFsck';
import { SYSTEM_PRINCIPAL } from '../../core/vfs/types';
import JSZip from 'jszip';
import {
  BACKUP_MANIFEST_FILENAME,
  BackupExclusionRecorder,
  classifyForBackup,
  normalizeMountPaths,
} from '../../core/vfs/backupExclusion';
import { t } from '../../i18n/i18n';
import { bindText } from '../../i18n/staticTexts';

const DOM_IDS = {
  MODAL: 'system-modal',
  BTN_OPEN: 'btn-settings',
  BTN_CLOSE: 'btn-close-system',
  BTN_EXPORT: 'btn-sys-export',
  BTN_IMPORT: 'btn-sys-import',
  INPUT_IMPORT: 'input-sys-import',
  BTN_RESET: 'btn-sys-reset',
  BTN_REPAIR: 'btn-sys-repair',
  STORAGE_STATUS: 'sys-storage-status',
  BTN_BACKUP_INDEX: 'btn-sys-backup-index',
  BTN_RESTORE_INDEX: 'btn-sys-restore-index',
  INPUT_RESTORE_INDEX: 'input-sys-restore-index',
};

export class SystemModal {
  private els: Record<string, HTMLElement | HTMLInputElement | null> = {};
  private events: Record<string, Function> = {};
  private vfs: VfsService;
  private nodeStore: NodeStore;
  private contentStore: ContentStore;

  constructor(vfs: VfsService, nodeStore: NodeStore, contentStore: ContentStore) {
    this.vfs = vfs;
    this.nodeStore = nodeStore;
    this.contentStore = contentStore;
    this._initElements();
    this._bindEvents();
  }

  on(event: string, callback: Function) {
    this.events[event] = callback;
  }

  private _initElements() {
    for (const [key, id] of Object.entries(DOM_IDS)) {
      this.els[key] = document.getElementById(id);
    }
  }

  private _bindEvents() {
    if (this.els.BTN_OPEN) this.els.BTN_OPEN.onclick = () => this.open();
    if (this.els.BTN_CLOSE) this.els.BTN_CLOSE.onclick = () => this.close();

    if (this.els.BTN_EXPORT) {
      this.els.BTN_EXPORT.onclick = () => this._handleExport();
    }

    if (this.els.BTN_IMPORT && this.els.INPUT_IMPORT) {
      this.els.BTN_IMPORT.onclick = () => this.els.INPUT_IMPORT!.click();
      this.els.INPUT_IMPORT.onchange = (e) => this._handleImport(e);
    }

    if (this.els.BTN_RESET) {
      this.els.BTN_RESET.onclick = async () => {
        const res = await window.AppUI?.showMessageBox({
          title: t('systemModal.reset.title'),
          message: t('systemModal.reset.message'),
          type: 'error',
          buttons: [
            { label: t('common.cancel'), value: false, style: 'normal', isDefault: true },
            { label: t('systemModal.reset.confirm'), value: true, style: 'danger' },
          ],
        });
        if (res && res.action) {
          if (this.events['reset']) this.events['reset']();
          this.close();
        }
      };
    }

    if (this.els.BTN_REPAIR) {
      this.els.BTN_REPAIR.onclick = () => this._handleRepair();
    }

    if (this.els.BTN_BACKUP_INDEX) {
      this.els.BTN_BACKUP_INDEX.onclick = () => this._handleBackupIndex();
    }

    if (this.els.BTN_RESTORE_INDEX && this.els.INPUT_RESTORE_INDEX) {
      this.els.BTN_RESTORE_INDEX.onclick = () => this.els.INPUT_RESTORE_INDEX!.click();
      this.els.INPUT_RESTORE_INDEX.onchange = (e) => this._handleRestoreIndex(e);
    }
  }

  open() {
    if (this.els.MODAL) this.els.MODAL.classList.remove('hidden');
    void this._refreshStorageStatus();
  }

  /**
   * 永続化の可否（T-0383）。拒否のままだと、容量が逼迫したときにブラウザがこの端末のデータを丸ごと消しうる。
   * Itera にはクラウドが無いので、見えるところに出しておく。
   */
  private async _refreshStorageStatus() {
    const el = this.els.STORAGE_STATUS;
    if (!el) return;
    try {
      const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null;
      if (persisted === true) {
        bindText(el, 'systemModal.persistenceGranted');
      } else if (persisted === false) {
        bindText(el, 'systemModal.persistenceDenied');
      } else {
        bindText(el, 'systemModal.persistenceUnknown');
      }
    } catch {
      bindText(el, 'systemModal.persistenceUnknown');
    }
  }

  close() {
    if (this.els.MODAL) this.els.MODAL.classList.add('hidden');
  }

  // --- ZIP Export ---
  private async _handleExport() {
    if (window.AppUI) window.AppUI.showLoading(t('systemModal.backup.creating'));

    try {
      const zip = new JSZip();
      // バックアップはシステム権限で全ファイルをスキャンする
      const files = this.vfs.listFiles(SYSTEM_PRINCIPAL, {
        recursive: true,
        detail: true,
      }) as any[];

      // 同期プロバイダが管理する領域（ルートマウントを除く）とスタブは含めない。
      // 理由と方針は src/core/vfs/backupExclusion.ts の冒頭に書いてある。
      const mounts = this.vfs.getProviderManager()?.listMounts() ?? [];
      const mountPaths = normalizeMountPaths(mounts);
      const recorder = new BackupExclusionRecorder(mounts);

      let errorCount = 0;

      for (const stat of files) {
        if (stat.kind !== 'file') continue;

        const verdict = classifyForBackup({ path: stat.path, syncState: stat.syncState }, mountPaths);
        if (verdict.excluded) {
          recorder.recordExcluded(stat.path, stat.size || 0, verdict);
          continue;
        }

        try {
          const blob = await this.vfs.readBlob(SYSTEM_PRINCIPAL, stat.path);
          zip.file(stat.path, blob);
          recorder.recordIncluded(blob.size);
        } catch (err: any) {
          errorCount++;
          const errorBlob = new Blob([`[Itera OS] Failed to read file content.\nError: ${err.message}`], {
            type: 'text/plain',
          });
          zip.file(stat.path, errorBlob);
        }
      }

      // 何をなぜ外したかを ZIP 自身に残す。復元した人が「local/ が無い」理由を追えるように。
      const manifest = recorder.toManifest();
      zip.file(BACKUP_MANIFEST_FILENAME, JSON.stringify(manifest, null, 2));

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      a.download = `itera_backup_${timestamp}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 100);

      const skipped = manifest.totals.excludedFiles;
      const skippedNote =
        skipped > 0 ? t('systemModal.backup.skippedNote', { count: skipped, manifest: BACKUP_MANIFEST_FILENAME }) : '';

      if (errorCount > 0) {
        if (window.AppUI)
          window.AppUI.notify(t('systemModal.backup.exportedWithErrors', { count: errorCount, note: skippedNote }), 'warning');
      } else {
        if (window.AppUI) window.AppUI.notify(t('systemModal.backup.exported', { note: skippedNote }), 'success');
      }
    } catch (e: any) {
      if (window.AppUI) window.AppUI.notify(t('systemModal.backup.exportFailed', { reason: e.message }), 'error');
    } finally {
      if (window.AppUI) window.AppUI.hideLoading();
    }
  }

  // --- ZIP Import ---
  private async _handleImport(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const res = await window.AppUI?.showMessageBox({
      title: t('systemModal.restore.title'),
      message: t('systemModal.restore.message', { name: file.name }),
      type: 'warning',
      buttons: [
        { label: t('common.cancel'), value: false, style: 'normal', isDefault: true },
        { label: t('systemModal.restore.confirm'), value: true, style: 'danger' },
      ],
    });
    if (!res || !res.action) {
      input.value = '';
      return;
    }

    if (window.AppUI) window.AppUI.showLoading(t('systemModal.restore.progress'));

    try {
      // 一旦全消去 (System権限)
      const currentFiles = this.vfs.listFiles(SYSTEM_PRINCIPAL, {
        recursive: true,
      });
      for (const path of currentFiles as string[]) {
        try {
          await this.vfs.deleteFile(SYSTEM_PRINCIPAL, path, {
            permanent: true,
          });
        } catch (err) {}
      }

      // 展開
      const zip = await JSZip.loadAsync(file);
      let count = 0;

      const promises: Promise<void>[] = [];
      zip.forEach((relativePath: string, zipEntry: any) => {
        if (zipEntry.dir || relativePath.startsWith('__MACOSX') || relativePath.includes('.DS_Store')) return;
        // バックアップの説明書き。VFS へ戻す対象ではない。
        if (relativePath.replace(/^\.?\/+/, '') === BACKUP_MANIFEST_FILENAME) return;

        promises.push(
          (async () => {
            const blob = await zipEntry.async('blob');
            const cleanPath = relativePath.replace(/^\/+/, '');
            await this.vfs.writeFile(SYSTEM_PRINCIPAL, cleanPath, blob, {
              overwrite: true,
            });
            count++;
          })(),
        );
      });

      await Promise.all(promises);

      if (window.AppUI) window.AppUI.notify(t('systemModal.restore.complete', { count }), 'success');
      setTimeout(() => window.location.reload(), 1500);
    } catch (err: any) {
      console.error(err);
      if (window.AppUI) window.AppUI.notify(t('systemModal.restore.failed', { reason: err.message }), 'error');
    } finally {
      input.value = '';
      if (window.AppUI) window.AppUI.hideLoading();
    }
  }

  // --- Diagnostics & Repair ---
  private async _handleRepair() {
    if (window.AppUI) window.AppUI.showLoading(t('systemModal.fsck.progress'));
    try {
      const fsck = new VfsFsck(this.nodeStore, this.contentStore);
      const report = await fsck.runRepair();

      let msg = t('systemModal.fsck.clean');
      if (report.totalErrorsFixed > 0) {
        msg = t('systemModal.fsck.repaired', {
          total: report.totalErrorsFixed,
          circular: report.circularReferencesFixed,
          orphans: report.orphansRescued,
          missing: report.missingContentsFixed,
          dangling: report.danglingContentsRescued,
        });
        if (window.AppUI) window.AppUI.notify(msg, 'warning');
      } else {
        if (window.AppUI) window.AppUI.notify(msg, 'success');
      }
    } catch (e: any) {
      if (window.AppUI) window.AppUI.notify(t('systemModal.fsck.failed', { reason: e.message }), 'error');
    } finally {
      if (window.AppUI) window.AppUI.hideLoading();
      this.close();
    }
  }

  private _handleBackupIndex() {
    try {
      const jsonStr = this.nodeStore.exportIndex();
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      a.download = `itera_index_backup_${timestamp}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 100);
      if (window.AppUI) window.AppUI.notify(t('systemModal.index.exported'), 'success');
    } catch (e: any) {
      if (window.AppUI) window.AppUI.notify(t('systemModal.index.exportFailed', { reason: e.message }), 'error');
    }
  }

  private async _handleRestoreIndex(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const res = await window.AppUI?.showMessageBox({
      title: t('systemModal.index.restoreTitle'),
      message: t('systemModal.index.restoreMessage', { name: file.name }),
      type: 'warning',
      buttons: [
        { label: t('common.cancel'), value: false, style: 'normal', isDefault: true, isCancel: true },
        { label: t('systemModal.index.restoreConfirm'), value: true, style: 'danger' },
      ],
    });
    if (!res || !res.action) {
      input.value = '';
      return;
    }

    if (window.AppUI) window.AppUI.showLoading(t('systemModal.index.restoring'));
    try {
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsText(file);
      });

      await this.nodeStore.importIndex(text);
      if (window.AppUI) window.AppUI.notify(t('systemModal.index.restored'), 'success');
      setTimeout(() => window.location.reload(), 1500);
    } catch (err: any) {
      console.error(err);
      if (window.AppUI) window.AppUI.notify(t('systemModal.index.restoreFailed', { reason: err.message }), 'error');
    } finally {
      input.value = '';
      if (window.AppUI) window.AppUI.hideLoading();
    }
  }
}
