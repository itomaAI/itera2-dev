/**
 * src/shell/panels/Explorer.ts
 * Itera OS v2: File Explorer Controller
 */

import type { VfsService } from '../../core/vfs/VfsService';
import type { VfsEventBus } from '../../core/vfs/VfsEventBus';
import type { FileAssociationResolver } from '../../core/sys/FileAssociationResolver';
import type { Principal, VfsStat } from '../../core/vfs/types';
import { VfsEventFormatter, type VfsEventItem } from '../../core/vfs/VfsEventFormatter';
import { TreeView } from './TreeView';

declare const JSZip: any;

declare global {
  interface Window {
    AppUI?: any;
  }
}

const DOM_IDS = {
  CONTAINER: 'file-explorer',
  CONTEXT_MENU: 'context-menu',
  SIDEBAR: 'sidebar',
  RESIZER: 'explorer-resizer',
  RESIZE_OVERLAY: 'resize-overlay',

  BTN_NEW_FILE: 'btn-new-file',
  BTN_NEW_FOLDER: 'btn-new-folder',
  BTN_UPLOAD_FILE: 'btn-upload-file',
  INPUT_FILE: 'input-upload-file',
};

export class Explorer {
  private vfs: VfsService;
  private eventBus: VfsEventBus;
  private resolver: FileAssociationResolver;
  private getActivePrincipal: () => Principal;
  private treeView: TreeView;
  private events: Record<string, Function> = {};
  private els: Record<string, HTMLElement | null> = {};
  private currentUploadTarget: string = '';

  constructor(
    vfs: VfsService,
    eventBus: VfsEventBus,
    resolver: FileAssociationResolver,
    getActivePrincipal: () => Principal,
  ) {
    this.vfs = vfs;
    this.eventBus = eventBus;
    this.resolver = resolver;
    this.getActivePrincipal = getActivePrincipal;

    this._initElements();

    this.treeView = new TreeView(this.els.CONTAINER!, this.els.CONTEXT_MENU!);

    this._bindVFS();
    this._bindTreeEvents();
    this._bindUploads();
    this._bindSidebarDnD();
    this._initResizer();
  }

  on(event: string, callback: Function): void {
    this.events[event] = callback;
  }

  private _initElements(): void {
    for (const [key, id] of Object.entries(DOM_IDS)) {
      this.els[key] = document.getElementById(id);
    }
  }

  private _bindVFS(): void {
    this.treeView.render(this.vfs.getTree(this.getActivePrincipal()));

    this.eventBus.subscribe((mutations) => {
      // Mutation 配列と、再描画が必要になった際に最新のツリーを取得する関数を渡す
      this.treeView.applyMutations(mutations, () => this.vfs.getTree(this.getActivePrincipal()));
    });
  }

  private _bindTreeEvents(): void {
    // 1. 通常のクリック時はデフォルトアプリを解決して ShellController へ委譲
    this.treeView.on('open', (path: string) => {
      try {
        const stat = this.vfs.stat(this.getActivePrincipal(), path);
        const defaultApp = this.resolver.resolveDefault(stat);
        if (this.events['open_file']) this.events['open_file'](path, defaultApp);
      } catch (e: any) {
        if (window.AppUI) window.AppUI.notify(`Cannot open file: ${e.message}`, 'error');
      }
    });

    this.treeView.on('move', async (srcPaths: string[], destFolder: string) => {
      if (srcPaths.length > 0) {
        try {
          await this._handleTransferBatch(srcPaths, destFolder, 'move');
        } catch (e: any) {
          if (window.AppUI) window.AppUI.notify(e.message, 'error');
        }
      }
    });

    this.treeView.on('context_menu_request', (paths: string[], x: number, y: number) => {
      this._buildContextMenu(paths, x, y);
    });
  }

  private _triggerBrowserDownload(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 100);
  }

  private _bindUploads(): void {
    if (this.els.BTN_NEW_FILE) {
      this.els.BTN_NEW_FILE.onclick = () => this._promptCreate('file');
    }
    if (this.els.BTN_NEW_FOLDER) {
      this.els.BTN_NEW_FOLDER.onclick = () => this._promptCreate('folder');
    }

    if (this.els.BTN_UPLOAD_FILE && this.els.INPUT_FILE) {
      this.els.BTN_UPLOAD_FILE.onclick = () => {
        this.currentUploadTarget = '';
        this.els.INPUT_FILE!.click();
      };
    }

    if (this.els.INPUT_FILE) {
      this.els.INPUT_FILE.onchange = (e) => {
        const isFolder = this.els.INPUT_FILE?.hasAttribute('webkitdirectory') || false;
        this._handleUploadAppend(e, isFolder);
      };
    }
  }

  private async _promptCreate(type: 'file' | 'folder', parentPath: string = '') {
    const res = await window.AppUI?.showMessageBox({
      title: `New ${type === 'folder' ? 'Folder' : 'File'}`,
      message: `Enter name for the new ${type}:`,
      type: 'question',
      prompt: { defaultValue: type === 'folder' ? 'New Folder' : 'Untitled' },
      buttons: [
        { label: 'Cancel', value: null, style: 'normal', isCancel: true },
        { label: 'Create', value: 'create', style: 'primary', isDefault: true },
      ],
    });

    if (!res || res.action === 'cancel' || res.action === null) return;
    const name = res.value;
    if (!name) return;

    let fullPath = parentPath ? `${parentPath}/${name}` : name;
    fullPath = fullPath.replace(/^\/+/, '');

    if (this.vfs.exists(this.getActivePrincipal(), fullPath)) {
      const dotIndex = fullPath.lastIndexOf('.');
      const hasExtension = type === 'file' && dotIndex !== -1 && dotIndex > fullPath.lastIndexOf('/');
      const base = hasExtension ? fullPath.substring(0, dotIndex) : fullPath;
      const ext = hasExtension ? fullPath.substring(dotIndex) : '';

      let counter = 1;
      while (this.vfs.exists(this.getActivePrincipal(), fullPath)) {
        fullPath = `${base}_${counter}${ext}`;
        counter++;
      }
    }

    if (type === 'folder') {
      try {
        await this.vfs.mkdir(this.getActivePrincipal(), fullPath);
        this._emitHistory('folder_created', `User created folder: ${fullPath}`);
      } catch (e: any) {
        if (window.AppUI) window.AppUI.notify(e.message, 'error');
      }
    } else {
      try {
        await this.vfs.writeFile(this.getActivePrincipal(), fullPath, '');
        this._emitHistory('file_created', `User created empty file: ${fullPath}`);
      } catch (e: any) {
        if (window.AppUI) window.AppUI.notify(e.message, 'error');
      }
    }
  }

  private _buildContextMenu(paths: string[], x: number, y: number) {
    const menuEl = this.els.CONTEXT_MENU;
    if (!menuEl) return;

    menuEl.innerHTML = '';
    const actions: any[] = [];

    if (paths.length === 1) {
      const path = paths[0];
      let stat: VfsStat | null = null;
      try {
        stat = path === '' ? null : this.vfs.stat(this.getActivePrincipal(), path);
      } catch (e) {
        // ignore
      }

      const isDir = stat ? stat.kind === 'directory' : path === '';

      if (isDir) {
        actions.push({
          label: 'New File',
          action: () => this._promptCreate('file', path),
        });
        actions.push({
          label: 'New Folder',
          action: () => this._promptCreate('folder', path),
        });
        actions.push({ separator: true });
        actions.push({
          label: 'Upload File Here...',
          action: () => {
            this.currentUploadTarget = path;
            if (this.els.INPUT_FILE) this.els.INPUT_FILE.click();
          },
        });
        actions.push({
          label: 'Upload Folder Here...',
          action: () => {
            this.currentUploadTarget = path;
            const folderInput = document.createElement('input');
            folderInput.type = 'file';
            folderInput.multiple = true;
            folderInput.setAttribute('webkitdirectory', '');
            folderInput.setAttribute('directory', '');
            folderInput.style.display = 'none';
            folderInput.onchange = (e) => {
              this._handleUploadAppend(e, true);
              folderInput.remove();
            };
            document.body.appendChild(folderInput);
            folderInput.click();
          },
        });
        actions.push({ separator: true });
      } else if (stat) {
        // file
        const resolvedApps = this.resolver.resolveAllAvailable(stat);
        if (resolvedApps.length > 0) {
          const defaultApp = resolvedApps[0];
          const defaultLabel = defaultApp.appId === 'HostRunner' ? '🖥️ Run as App' : `Open in ${defaultApp.appName}`;
          actions.push({
            label: defaultLabel,
            action: () => {
              if (this.events['open_file']) this.events['open_file'](path, defaultApp);
            },
          });

          // `.html` or `.js` の場合、デーモンとして起動を追加
          if (path.endsWith('.html') || path.endsWith('.js')) {
            actions.push({
              label: '⚙️ Run as Daemon',
              action: () => {
                if (this.events['spawn_daemon']) this.events['spawn_daemon'](path);
              },
            });
          }

          resolvedApps.slice(1).forEach((app) => {
            const fallbackLabel = app.appId === 'HostRunner' ? ' ↳ 🖥️ Run as App' : ` ↳ ${app.appName}`;
            actions.push({
              label: fallbackLabel,
              action: () => {
                if (this.events['open_file']) this.events['open_file'](path, app);
              },
            });
          });
          actions.push({ separator: true });
        }
      }

      actions.push({
        label: 'Add to Context',
        action: () => {
          if (this.events['add_to_context']) this.events['add_to_context']([path]);
        },
      });
      actions.push({
        label: 'Copy Path',
        action: () => {
          navigator.clipboard
            .writeText(path)
            .then(() => {
              if (window.AppUI) window.AppUI.notify('Path copied to clipboard', 'success');
            })
            .catch((err) => {
              if (window.AppUI) window.AppUI.notify(`Failed to copy: ${err.message}`, 'error');
            });
        },
      });
      actions.push({ separator: true });

      if (path !== '') {
        actions.push({
          label: 'Duplicate',
          action: () => this._handleDuplicateBatch([path]),
        });
        actions.push({
          label: 'Rename',
          action: () => this._promptRename(path),
        });
        actions.push({
          label: 'Move',
          action: () => this._promptMoveBatch([path]),
        });
        actions.push({
          label: 'Download',
          action: () => this._handleDownloadBatch([path]),
        });
        actions.push({
          label: 'Properties',
          action: () => {
            if (this.events['properties_request']) this.events['properties_request'](path);
          },
        });
        actions.push({
          label: 'Delete',
          action: () => this._confirmDeleteBatch([path]),
          danger: true,
        });
      }
    } else if (paths.length > 1) {
      // 複数選択時のメニュー
      actions.push({
        label: 'Add to Context',
        action: () => {
          if (this.events['add_to_context']) this.events['add_to_context'](paths);
        },
      });
      actions.push({ separator: true });
      actions.push({
        label: `Duplicate ${paths.length} items`,
        action: () => this._handleDuplicateBatch(paths),
      });
      actions.push({
        label: `Move ${paths.length} items`,
        action: () => this._promptMoveBatch(paths),
      });
      actions.push({
        label: `Download ${paths.length} items`,
        action: () => this._handleDownloadBatch(paths),
      });
      actions.push({ separator: true });
      actions.push({
        label: `Delete ${paths.length} items`,
        action: () => this._confirmDeleteBatch(paths),
        danger: true,
      });
    }

    // 末尾にある不要なセパレーターを削る
    while (actions.length > 0 && actions[actions.length - 1].separator) {
      actions.pop();
    }

    if (actions.length === 0) return;

    for (const item of actions) {
      if (item.separator) {
        const hr = document.createElement('hr');
        hr.className = 'border-border-main my-1';
        menuEl.appendChild(hr);
        continue;
      }
      const btn = document.createElement('div');
      btn.className = `px-3 py-1 hover:bg-primary hover:text-white cursor-pointer text-xs ${item.danger ? 'text-error hover:text-text-main' : 'text-text-main'}`;
      btn.textContent = item.label;
      btn.onclick = () => {
        menuEl.classList.add('hidden');
        item.action();
      };
      menuEl.appendChild(btn);
    }

    menuEl.classList.remove('hidden');
    const rect = menuEl.getBoundingClientRect();
    const winWidth = window.innerWidth;
    const winHeight = window.innerHeight;

    let posX = x;
    let posY = y;

    if (posX + rect.width > winWidth) posX = winWidth - rect.width - 5;
    if (posY + rect.height > winHeight) posY = winHeight - rect.height - 5;
    if (posX < 0) posX = 5;

    menuEl.style.left = `${posX}px`;
    menuEl.style.top = `${posY}px`;
  }

  private async _handleUploadAppend(e: Event, isFolder: boolean): Promise<void> {
    const input = e.target as HTMLInputElement;
    const files = input.files ? Array.from(input.files) : [];
    if (files.length === 0) return;

    const needsLoading = isFolder || files.length > 1;
    if (needsLoading && window.AppUI) {
      window.AppUI.showLoading(`Uploading ${files.length} items...`);
    } else if (window.AppUI) {
      window.AppUI.notify(`Uploading ${files.length} items...`, 'info');
    }

    try {
      const uploadedPaths: string[] = [];
      const targetDir = this.currentUploadTarget ? `${this.currentUploadTarget}/` : '';

      for (const file of files) {
        let relPath = isFolder && file.webkitRelativePath ? file.webkitRelativePath : file.name;
        const fullPath = (targetDir + relPath).replace(/^\/+/, '');

        try {
          await this.vfs.writeFile(this.getActivePrincipal(), fullPath, file, {
            overwrite: true,
          });
          uploadedPaths.push(fullPath);
        } catch (err: any) {
          console.error(`[Explorer] Upload failed for ${fullPath}:`, err);
          if (window.AppUI) window.AppUI.notify(`Upload failed for ${file.name}: ${err.message}`, 'error');
        }
      }

      if (uploadedPaths.length > 0) {
        if (window.AppUI) window.AppUI.notify(`Upload complete: ${uploadedPaths.length} items`, 'success');
        const items: VfsEventItem[] = uploadedPaths.map((p) => ({ srcPath: p }));
        const msg = VfsEventFormatter.format({
          actor: 'User',
          action: 'upload',
          items,
          targetDir: targetDir,
        });
        this._emitHistory('file_created', msg);
      }
    } finally {
      if (needsLoading && window.AppUI) {
        window.AppUI.hideLoading();
      }
      input.value = '';
    }
  }

  private _bindSidebarDnD(): void {
    const sidebar = this.els.SIDEBAR;
    if (!sidebar) return;

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((eventName) => {
      sidebar.addEventListener(
        eventName,
        (e) => {
          e.preventDefault();
          e.stopPropagation();
        },
        false,
      );
    });

    sidebar.addEventListener('dragover', (e) => {
      // 内部ドラッグ中の場合はコピーエフェクトを出さない
      if ((window as any).__iteraDragData) return;

      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy';
      }
      sidebar.classList.add('bg-hover');
    });

    sidebar.addEventListener('dragleave', () => {
      sidebar.classList.remove('bg-hover');
    });

    sidebar.addEventListener('drop', async (e) => {
      sidebar.classList.remove('bg-hover');

      // 内部ドラッグのドロップ処理は TreeView 側で行うのでアップロード処理からは弾く
      if ((window as any).__iteraDragData) return;

      const items = e.dataTransfer?.items;
      if (!items) return;

      let firstItemName = 'unknown';
      if (items.length > 0) {
        const entry = typeof items[0].webkitGetAsEntry === 'function' ? items[0].webkitGetAsEntry() : null;
        if (entry) {
          firstItemName = entry.name;
        } else if (items[0].kind === 'file') {
          const file = items[0].getAsFile();
          if (file) firstItemName = file.name;
        }
      }
      const sourceName = items.length > 1 ? `${firstItemName} and others` : firstItemName;

      if (window.AppUI) window.AppUI.notify('Analyzing files for upload...', 'info');

      const promises: Promise<File[]>[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = typeof items[i].webkitGetAsEntry === 'function' ? items[i].webkitGetAsEntry() : null;
        if (item) {
          promises.push(this._traverseFileTree(item, ''));
        }
      }

      const fileArrays = await Promise.all(promises);
      const filesToUpload = fileArrays.flat();

      if (filesToUpload.length > 0) {
        await this._batchWriteFiles(filesToUpload, sourceName);
      } else {
        if (window.AppUI) window.AppUI.notify('No files found to upload.', 'warning');
      }
    });
  }

  private _traverseFileTree(item: any, path: string): Promise<File[]> {
    return new Promise((resolve) => {
      path = path || '';
      if (item.isFile) {
        item.file((file: File) => {
          (file as any).fullPath = path + file.name;
          resolve([file]);
        });
      } else if (item.isDirectory) {
        const dirReader = item.createReader();
        const entries: any[] = [];
        const readEntries = () => {
          dirReader.readEntries(async (results: any[]) => {
            if (!results.length) {
              const childPromises = entries.map((entry) => this._traverseFileTree(entry, path + item.name + '/'));
              const resolvedArrays = await Promise.all(childPromises);
              resolve(resolvedArrays.flat());
            } else {
              entries.push(...results);
              readEntries();
            }
          });
        };
        readEntries();
      } else {
        resolve([]);
      }
    });
  }

  private async _batchWriteFiles(files: File[], sourceName: string = 'items'): Promise<void> {
    const uploadedPaths: string[] = [];
    let applyToAllAction: string | null = null;

    const needsLoading = files.length > 1;
    if (needsLoading && window.AppUI) {
      window.AppUI.showLoading(`Uploading ${files.length} items...`);
    } else if (window.AppUI) {
      window.AppUI.notify(`Starting upload: ${files.length} files from "${sourceName}"`, 'info');
    }

    try {
      for (const file of files) {
        const relPath = ((file as any).fullPath || file.name).replace(/^\/+/, '');
        if (relPath.startsWith('.git/') || relPath.includes('/.git/') || relPath.endsWith('.DS_Store')) continue;

        let targetPath = relPath;
        let action = 'replace';

        if (this.vfs.exists(this.getActivePrincipal(), targetPath)) {
          if (applyToAllAction) {
            action = applyToAllAction;
          } else {
            const res = await window.AppUI?.showConflictDialog(targetPath.split('/').pop()!, false);
            if (!res || res.action === 'cancel') {
              break; // キャンセルされたら残りのアップロードもすべて中断
            }
            action = res.action as string;
            if (res.checkboxChecked) applyToAllAction = action;
          }
        }

        if (action === 'skip') continue;

        if (action === 'keep_both') {
          const dotIndex = targetPath.lastIndexOf('.');
          const base = dotIndex !== -1 ? targetPath.substring(0, dotIndex) : targetPath;
          const ext = dotIndex !== -1 ? targetPath.substring(dotIndex) : '';
          let counter = 1;
          while (this.vfs.exists(this.getActivePrincipal(), targetPath)) {
            targetPath = `${base}_copy${counter}${ext}`;
            counter++;
          }
        }

        try {
          await this.vfs.writeFile(this.getActivePrincipal(), targetPath, file, {
            overwrite: true,
          });
          uploadedPaths.push(targetPath);
        } catch (err: any) {
          console.error(`[Explorer] Import failed: ${targetPath}`, err);
          if (window.AppUI) window.AppUI.notify(`Import failed for ${file.name}: ${err.message}`, 'error');
        }
      }

      if (uploadedPaths.length > 0) {
        if (window.AppUI) window.AppUI.notify(`Upload complete: ${uploadedPaths.length} items uploaded.`, 'success');
        const items: VfsEventItem[] = uploadedPaths.map((p) => ({ srcPath: p }));
        const msg = VfsEventFormatter.format({
          actor: 'User',
          action: 'upload',
          items,
        });
        this._emitHistory('file_created', msg);
      } else {
        if (window.AppUI) window.AppUI.notify('No files were uploaded.', 'info');
      }
    } finally {
      if (needsLoading && window.AppUI) {
        window.AppUI.hideLoading();
      }
    }
  }

  private _initResizer(): void {
    const resizer = this.els.RESIZER;
    const sidebar = this.els.SIDEBAR;
    const overlay = this.els.RESIZE_OVERLAY;

    if (!resizer || !sidebar) return;

    let isResizing = false;

    const start = (e: MouseEvent) => {
      isResizing = true;
      document.body.style.cursor = 'col-resize';
      resizer.classList.add('resizing');
      if (overlay) overlay.classList.remove('hidden');
      e.preventDefault();
    };

    const stop = () => {
      if (!isResizing) return;
      isResizing = false;
      document.body.style.cursor = '';
      resizer.classList.remove('resizing');
      if (overlay) overlay.classList.add('hidden');
    };

    const move = (e: MouseEvent) => {
      if (!isResizing) return;
      const newWidth = e.clientX;
      if (newWidth > 150 && newWidth < 600) {
        sidebar.style.width = `${newWidth}px`;
      }
      e.preventDefault();
    };

    resizer.addEventListener('mousedown', start);
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', stop);
    window.addEventListener('blur', stop);
  }

  public async _promptRename(path: string) {
    const fileName = path.split('/').pop()!;
    const parentPath = path.substring(0, path.lastIndexOf('/'));

    const res = await window.AppUI?.showMessageBox({
      title: 'Rename',
      message: `Enter new name for the item:`,
      type: 'question',
      prompt: { defaultValue: fileName },
      buttons: [
        { label: 'Cancel', value: null, style: 'normal', isCancel: true },
        { label: 'Rename', value: 'rename', style: 'primary', isDefault: true },
      ],
    });

    if (!res || res.action === 'cancel' || res.action === null) return;
    const newName = res.value;
    if (!newName || newName === fileName) return;

    const newPath = parentPath ? `${parentPath}/${newName}` : newName;

    try {
      await this.vfs.rename(this.getActivePrincipal(), path, newPath);
      const msg = VfsEventFormatter.format({
        actor: 'User',
        action: 'move',
        items: [{ srcPath: path, destPath: newPath }],
      });
      this._emitHistory('file_moved', msg);
    } catch (e: any) {
      if (window.AppUI) window.AppUI.notify(e.message, 'error');
    }
  }

  private _normalizePaths(paths: string[]): string[] {
    if (!paths || paths.length === 0) return [];
    const sorted = [...paths].sort();
    const result: string[] = [];
    for (const p of sorted) {
      if (result.length === 0) {
        result.push(p);
      } else {
        const last = result[result.length - 1];
        if (p === last || p.startsWith(last + '/')) {
          continue; // 子孫なのでスキップ
        } else {
          result.push(p);
        }
      }
    }
    return result;
  }

  private _getCommonParentPath(paths: string[]): string {
    if (paths.length === 0) return '';
    if (paths.length === 1) return paths[0];

    const splitPaths = paths.map((p) => p.split('/'));
    const minLen = Math.min(...splitPaths.map((arr) => arr.length));

    let commonCount = 0;
    for (let i = 0; i < minLen; i++) {
      const segment = splitPaths[0][i];
      const allMatch = splitPaths.every((arr) => arr[i] === segment);
      if (allMatch) {
        commonCount++;
      } else {
        break;
      }
    }

    if (commonCount === 0) return '';
    return splitPaths[0].slice(0, commonCount).join('/');
  }

  private async _handleDuplicateBatch(paths: string[]) {
    const normalized = this._normalizePaths(paths);
    if (normalized.length === 0) return;

    if (window.AppUI) window.AppUI.showLoading(`Duplicating ${normalized.length} items...`);
    let successCount = 0;
    try {
      for (const p of normalized) {
        try {
          const dotIndex = p.lastIndexOf('.');
          const base = dotIndex !== -1 ? p.substring(0, dotIndex) : p;
          const ext = dotIndex !== -1 ? p.substring(dotIndex) : '';
          let newPath = `${base}_copy${ext}`;
          let counter = 1;
          while (this.vfs.exists(this.getActivePrincipal(), newPath)) {
            newPath = `${base}_copy${counter}${ext}`;
            counter++;
          }
          await this.vfs.copyFile(this.getActivePrincipal(), p, newPath);
          successCount++;
        } catch (e: any) {
          console.error(`Failed to duplicate ${p}:`, e);
        }
      }
      if (successCount > 0) {
        this._emitHistory('file_created', `User duplicated ${successCount} items.`);
      }
    } finally {
      if (window.AppUI) window.AppUI.hideLoading();
    }
  }

  private async _handleDownloadBatch(paths: string[]) {
    const normalized = this._normalizePaths(paths);
    if (normalized.length === 0) return;

    // 単一ファイルの早期リターン（ZIP圧縮・ローディングをバイパス）
    if (normalized.length === 1) {
      const p = normalized[0];
      try {
        const stat = this.vfs.stat(this.getActivePrincipal(), p);
        if (stat.kind === 'file') {
          const blob = await this.vfs.readBlob(this.getActivePrincipal(), p);
          this._triggerBrowserDownload(blob, stat.name);
          this._emitHistory('file_downloaded', `User downloaded file: ${p}`);
          return;
        }
      } catch (e: any) {
        if (window.AppUI) window.AppUI.notify(`Download failed: ${e.message}`, 'error');
        return;
      }
    }

    if (typeof JSZip === 'undefined') {
      if (window.AppUI) window.AppUI.notify('System Error: JSZip library not loaded.', 'error');
      return;
    }

    if (window.AppUI) window.AppUI.showLoading(`Compressing ${normalized.length} item(s)...`);
    try {
      const zip = new JSZip();
      let errorCount = 0;

      // 共通祖先の特定とプレフィックスの刈り込み
      const commonPath = this._getCommonParentPath(normalized);
      let prefixToTrim = '';
      let zipName = `archive_${Date.now()}.zip`;

      if (commonPath) {
        const lastSlashIdx = commonPath.lastIndexOf('/');
        if (lastSlashIdx !== -1) {
          prefixToTrim = commonPath.substring(0, lastSlashIdx + 1);
          zipName = `${commonPath.substring(lastSlashIdx + 1)}.zip`;
        } else {
          // ルート直下の場合
          prefixToTrim = '';
          zipName = `${commonPath}.zip`;
        }
      }

      for (const p of normalized) {
        const stat = this.vfs.stat(this.getActivePrincipal(), p);
        if (stat.kind === 'file') {
          const zipPath = stat.path.substring(prefixToTrim.length);
          try {
            const blob = await this.vfs.readBlob(this.getActivePrincipal(), stat.path);
            zip.file(zipPath, blob);
          } catch (err: any) {
            errorCount++;
            zip.file(zipPath, new Blob([`[Itera OS] Error: ${err.message}`], { type: 'text/plain' }));
          }
        } else {
          const files = this.vfs.listFiles(this.getActivePrincipal(), {
            path: stat.path,
            recursive: true,
            detail: true,
          }) as VfsStat[];

          for (const subStat of files) {
            if (subStat.kind === 'file') {
              const zipPath = subStat.path.substring(prefixToTrim.length);
              try {
                const blob = await this.vfs.readBlob(this.getActivePrincipal(), subStat.path);
                zip.file(zipPath, blob);
              } catch (err: any) {
                errorCount++;
                zip.file(zipPath, new Blob([`[Itera OS] Error: ${err.message}`], { type: 'text/plain' }));
              }
            }
          }
        }
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      this._triggerBrowserDownload(zipBlob, zipName);
      this._emitHistory('project_exported', `User downloaded ${normalized.length} items as ${zipName}`);

      if (errorCount > 0 && window.AppUI) {
        window.AppUI.notify(`Download complete, but ${errorCount} files failed to read.`, 'warning');
      }
    } catch (e: any) {
      if (window.AppUI) window.AppUI.notify(`Download failed: ${e.message}`, 'error');
    } finally {
      if (window.AppUI) window.AppUI.hideLoading();
    }
  }

  public async _confirmDeleteBatch(paths: string[]) {
    const normalized = this._normalizePaths(paths);
    if (normalized.length === 0) return;

    const res = await window.AppUI?.showMessageBox({
      title: 'Delete Items',
      message: `Are you sure you want to delete ${normalized.length} item(s)?`,
      type: 'warning',
      buttons: [
        { label: 'Cancel', value: false, style: 'normal', isCancel: true },
        { label: 'Delete', value: true, style: 'danger', isDefault: true },
      ],
    });

    if (res && res.action) {
      if (window.AppUI) window.AppUI.showLoading(`Deleting ${normalized.length} items...`);
      const deletedItems: VfsEventItem[] = [];
      try {
        for (const p of normalized) {
          try {
            await this.vfs.deleteFile(this.getActivePrincipal(), p);
            deletedItems.push({ srcPath: p });
          } catch (e: any) {
            console.error(`Failed to delete ${p}:`, e);
          }
        }
        if (deletedItems.length > 0) {
          const msg = VfsEventFormatter.format({
            actor: 'User',
            action: 'delete',
            items: deletedItems,
          });
          this._emitHistory('file_deleted', msg);
        }
      } finally {
        if (window.AppUI) window.AppUI.hideLoading();
      }
    }
  }

  private async _handleTransferBatch(srcPaths: string[], destFolder: string, mode: 'move' | 'copy' = 'move') {
    const normalized = this._normalizePaths(srcPaths);
    if (normalized.length === 0) return;

    if (window.AppUI)
      window.AppUI.showLoading(`${mode === 'move' ? 'Moving' : 'Copying'} ${normalized.length} items...`);
    let applyToAllAction: string | null = null;
    let successCount = 0;

    try {
      for (const srcPath of normalized) {
        const fileName = srcPath.split('/').pop()!;
        let newPath = destFolder ? `${destFolder}/${fileName}` : fileName;

        if (srcPath === newPath) continue;

        if (destFolder && (destFolder === srcPath || destFolder.startsWith(srcPath + '/'))) {
          if (window.AppUI) window.AppUI.notify(`Skipped ${fileName}: Cannot move into itself.`, 'error');
          continue;
        }

        let action = 'proceed';

        if (this.vfs.exists(this.getActivePrincipal(), newPath)) {
          if (applyToAllAction) {
            action = applyToAllAction;
          } else {
            const stat = this.vfs.stat(this.getActivePrincipal(), newPath);
            const isDir = stat.kind === 'directory';

            if (window.AppUI) window.AppUI.hideLoading();
            const res = await window.AppUI?.showConflictDialog(fileName, isDir);
            if (window.AppUI)
              window.AppUI.showLoading(`${mode === 'move' ? 'Moving' : 'Copying'} ${normalized.length} items...`);

            if (!res || res.action === 'cancel') {
              break;
            }
            action = res.action as string;
            if (res.checkboxChecked) applyToAllAction = action;
          }
        }

        if (action === 'skip') continue;

        if (action === 'keep_both') {
          const dotIndex = newPath.lastIndexOf('.');
          const base = dotIndex !== -1 ? newPath.substring(0, dotIndex) : newPath;
          const ext = dotIndex !== -1 ? newPath.substring(dotIndex) : '';
          let counter = 1;
          while (this.vfs.exists(this.getActivePrincipal(), newPath)) {
            newPath = `${base}_copy${counter}${ext}`;
            counter++;
          }
          try {
            if (mode === 'move') await this.vfs.rename(this.getActivePrincipal(), srcPath, newPath);
            else await this.vfs.copyFile(this.getActivePrincipal(), srcPath, newPath);
            processedItems.push({ srcPath, destPath: newPath });
            successCount++;
          } catch (e: any) {
            if (window.AppUI) window.AppUI.notify(e.message, 'error');
          }
          continue;
        }

        if (action === 'merge') {
          await this._mergeDirectory(srcPath, newPath, mode === 'copy');
          processedItems.push({ srcPath, destPath: newPath });
          successCount++;
          continue;
        }

        if (action === 'replace') {
          try {
            await this.vfs.deleteFile(this.getActivePrincipal(), newPath, { permanent: true });
            if (mode === 'move') await this.vfs.rename(this.getActivePrincipal(), srcPath, newPath);
            else await this.vfs.copyFile(this.getActivePrincipal(), srcPath, newPath);
            processedItems.push({ srcPath, destPath: newPath });
            successCount++;
          } catch (e: any) {
            if (window.AppUI) window.AppUI.notify(`Replace failed: ${e.message}`, 'error');
          }
          continue;
        }

        try {
          if (mode === 'move') await this.vfs.rename(this.getActivePrincipal(), srcPath, newPath);
          else await this.vfs.copyFile(this.getActivePrincipal(), srcPath, newPath);
          processedItems.push({ srcPath, destPath: newPath });
          successCount++;
        } catch (e: any) {
          if (window.AppUI) window.AppUI.notify(e.message, 'error');
        }
      }

      if (processedItems.length > 0) {
        const msg = VfsEventFormatter.format({
          actor: 'User',
          action: mode,
          items: processedItems,
          targetDir: destFolder,
        });
        this._emitHistory(`file_${mode}d`, msg);
      }
    } finally {
      if (window.AppUI) window.AppUI.hideLoading();
    }
  }

  public async _promptMoveBatch(paths: string[]) {
    const normalized = this._normalizePaths(paths);
    if (normalized.length === 0) return;

    let defaultPath = '';
    if (normalized.length > 0) {
      const firstPath = normalized[0];
      const lastSlashIdx = firstPath.lastIndexOf('/');
      if (lastSlashIdx !== -1) {
        defaultPath = firstPath.substring(0, lastSlashIdx);
      }
    }

    const title = normalized.length === 1 ? 'Move Item' : 'Move Items';
    const message =
      normalized.length === 1
        ? `Enter destination folder path for "${normalized[0].split('/').pop()}":`
        : `Enter destination folder path for ${normalized.length} items:`;

    const res = await window.AppUI?.showMessageBox({
      title: title,
      message: message,
      type: 'question',
      prompt: { defaultValue: defaultPath },
      buttons: [
        { label: 'Cancel', value: null, style: 'normal', isCancel: true },
        { label: 'Move', value: 'move', style: 'primary', isDefault: true },
      ],
    });

    if (!res || res.action === 'cancel' || res.action === null) return;
    const destFolder = res.value || '';

    try {
      await this._handleTransferBatch(paths, destFolder, 'move');
    } catch (e: any) {
      if (window.AppUI) window.AppUI.notify(e.message, 'error');
    }
  }

  private async _mergeDirectory(srcPath: string, destPath: string, keepOriginal: boolean = false) {
    if (window.AppUI) window.AppUI.showLoading('Merging directories...');

    let applyToAllAction: string | null = null;

    const traverseAndMerge = async (currentSrc: string, currentDest: string) => {
      const children = this.vfs.listFiles(this.getActivePrincipal(), { path: currentSrc, detail: true }) as VfsStat[];
      for (const child of children) {
        const childDest = `${currentDest}/${child.name}`;
        if (child.kind === 'directory') {
          if (!this.vfs.exists(this.getActivePrincipal(), childDest)) {
            await this.vfs.mkdir(this.getActivePrincipal(), childDest);
          }
          const success = await traverseAndMerge(child.path, childDest);
          if (!success) return false;
        } else {
          let action = 'replace';
          if (this.vfs.exists(this.getActivePrincipal(), childDest)) {
            if (applyToAllAction) {
              action = applyToAllAction;
            } else {
              const res = await window.AppUI?.showConflictDialog(child.name, false);
              if (!res || res.action === 'cancel') return false;
              action = res.action as string;

              if (res.checkboxChecked) applyToAllAction = action;
            }
          }

          if (action === 'skip') continue;

          let writePath = childDest;
          if (action === 'keep_both') {
            const dotIndex = childDest.lastIndexOf('.');
            const base = dotIndex !== -1 ? childDest.substring(0, dotIndex) : childDest;
            const ext = dotIndex !== -1 ? childDest.substring(dotIndex) : '';
            let counter = 1;
            while (this.vfs.exists(this.getActivePrincipal(), writePath)) {
              writePath = `${base}_copy${counter}${ext}`;
              counter++;
            }
          }

          try {
            const blob = await this.vfs.readBlob(this.getActivePrincipal(), child.path);
            await this.vfs.writeFile(this.getActivePrincipal(), writePath, blob, { overwrite: true });
          } catch (e) {
            console.error(`Failed to copy ${child.path}`, e);
          }
        }
      }
      return true;
    };

    try {
      const success = await traverseAndMerge(srcPath, destPath);
      if (success && !keepOriginal) {
        await this.vfs.deleteFile(this.getActivePrincipal(), srcPath, { permanent: true });
      }
      this._emitHistory('folder_merged', `User merged folder: ${srcPath} into ${destPath}`);
    } catch (e: any) {
      if (window.AppUI) window.AppUI.notify(`Merge failed: ${e.message}`, 'error');
    } finally {
      if (window.AppUI) window.AppUI.hideLoading();
    }
  }

  private _emitHistory(type: string, desc: string): void {
    if (this.events['history_event']) {
      this.events['history_event'](type, desc);
    }
  }
}
