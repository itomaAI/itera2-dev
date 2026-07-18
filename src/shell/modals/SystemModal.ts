/**
 * src/shell/modals/SystemModal.ts
 * Itera OS v2: System Management (ZIP Export/Import & Reset)
 */

import type { VfsService } from '../../core/vfs/VfsService';
import type { NodeStore } from '../../core/vfs/NodeStore';
import type { ContentStore } from '../../core/vfs/ContentStore';
import { VfsFsck } from '../../core/vfs/VfsFsck';
import { SYSTEM_PRINCIPAL } from '../../core/vfs/types';

declare const JSZip: any;

const DOM_IDS = {
  MODAL: 'system-modal',
  BTN_OPEN: 'btn-settings',
  BTN_CLOSE: 'btn-close-system',
  BTN_EXPORT: 'btn-sys-export',
  BTN_IMPORT: 'btn-sys-import',
  INPUT_IMPORT: 'input-sys-import',
  BTN_RESET: 'btn-sys-reset',
  BTN_REPAIR: 'btn-sys-repair',
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
          title: 'Factory Reset',
          message:
            'WARNING: This will permanently delete ALL files and settings.\n\nAre you absolutely sure you want to proceed?',
          type: 'error',
          buttons: [
            { label: 'Cancel', value: false, style: 'normal', isDefault: true },
            { label: 'Reset System', value: true, style: 'danger' },
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
  }

  close() {
    if (this.els.MODAL) this.els.MODAL.classList.add('hidden');
  }

  // --- ZIP Export ---
  private async _handleExport() {
    if (typeof JSZip === 'undefined') {
      if (window.AppUI) window.AppUI.notify('JSZip library not loaded.', 'error');
      return;
    }

    if (window.AppUI) window.AppUI.showLoading('Creating Backup...');

    try {
      const zip = new JSZip();
      // バックアップはシステム権限で全ファイルをスキャンする
      const files = this.vfs.listFiles(SYSTEM_PRINCIPAL, {
        recursive: true,
        detail: true,
      }) as any[];

      for (const stat of files) {
        if (stat.kind === 'file' && !stat.path.startsWith('trash/')) {
          const blob = await this.vfs.readBlob(SYSTEM_PRINCIPAL, stat.path);
          zip.file(stat.path, blob);
        }
      }

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

      if (window.AppUI) window.AppUI.notify('Backup Exported', 'success');
    } catch (e: any) {
      if (window.AppUI) window.AppUI.notify(`Export failed: ${e.message}`, 'error');
    } finally {
      if (window.AppUI) window.AppUI.hideLoading();
    }
  }

  // --- ZIP Import ---
  private async _handleImport(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    if (typeof JSZip === 'undefined') {
      if (window.AppUI) window.AppUI.notify('JSZip library not loaded.', 'error');
      return;
    }

    const res = await window.AppUI?.showMessageBox({
      title: 'Restore Backup',
      message: `CAUTION: This will ERASE all current files and restore from "${file.name}".\n\nAre you sure you want to continue?`,
      type: 'warning',
      buttons: [
        { label: 'Cancel', value: false, style: 'normal', isDefault: true },
        { label: 'Restore', value: true, style: 'danger' },
      ],
    });
    if (!res || !res.action) {
      input.value = '';
      return;
    }

    if (window.AppUI) window.AppUI.showLoading('Restoring Backup...');

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

      if (window.AppUI) window.AppUI.notify(`Restore Complete: ${count} files. Reloading...`, 'success');
      setTimeout(() => window.location.reload(), 1500);
    } catch (err: any) {
      console.error(err);
      if (window.AppUI) window.AppUI.notify(`Restore Failed: ${err.message}`, 'error');
    } finally {
      input.value = '';
      if (window.AppUI) window.AppUI.hideLoading();
    }
  }

  // --- Diagnostics & Repair ---
  private async _handleRepair() {
    if (window.AppUI) window.AppUI.showLoading('Checking VFS Consistency...');
    try {
      const fsck = new VfsFsck(this.nodeStore, this.contentStore);
      const report = await fsck.runRepair();

      let msg = 'File system is clean. No errors found.';
      if (report.totalErrorsFixed > 0) {
        msg =
          `Repaired ${report.totalErrorsFixed} issues:\n` +
          `- Circular References: ${report.circularReferencesFixed}\n` +
          `- Orphans Rescued: ${report.orphansRescued}\n` +
          `- Missing Contents Fixed: ${report.missingContentsFixed}\n` +
          `- Dangling Contents Rescued: ${report.danglingContentsRescued}\n\n` +
          `Check '.lost+found' folder in root if files were rescued.`;
        if (window.AppUI) window.AppUI.notify(msg, 'warning');
      } else {
        if (window.AppUI) window.AppUI.notify(msg, 'success');
      }
    } catch (e: any) {
      if (window.AppUI) window.AppUI.notify(`Repair failed: ${e.message}`, 'error');
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
      if (window.AppUI) window.AppUI.notify('Index Backup Exported', 'success');
    } catch (e: any) {
      if (window.AppUI) window.AppUI.notify(`Index backup failed: ${e.message}`, 'error');
    }
  }

  private async _handleRestoreIndex(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const res = await window.AppUI?.showMessageBox({
      title: 'Restore Index',
      message: `CAUTION: This will overwrite your entire file system index with "${file.name}".\nAre you sure you want to proceed?`,
      type: 'warning',
      buttons: [
        { label: 'Cancel', value: false, style: 'normal', isDefault: true, isCancel: true },
        { label: 'Restore Index', value: true, style: 'danger' },
      ],
    });
    if (!res || !res.action) {
      input.value = '';
      return;
    }

    if (window.AppUI) window.AppUI.showLoading('Restoring Index...');
    try {
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsText(file);
      });

      await this.nodeStore.importIndex(text);
      if (window.AppUI) window.AppUI.notify('Index restored. Reloading system...', 'success');
      setTimeout(() => window.location.reload(), 1500);
    } catch (err: any) {
      console.error(err);
      if (window.AppUI) window.AppUI.notify(`Index Restore Failed: ${err.message}`, 'error');
    } finally {
      input.value = '';
      if (window.AppUI) window.AppUI.hideLoading();
    }
  }
}
