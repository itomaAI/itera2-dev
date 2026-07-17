/**
 * src/shell/panels/Explorer.ts
 * Itera OS v2: File Explorer Controller
 */

import type { VfsService } from '../../core/vfs/VfsService';
import type { VfsEventBus } from '../../core/vfs/VfsEventBus';
import type { FileAssociationResolver, ResolvedApp } from '../../core/sys/FileAssociationResolver';
import type { Principal, VfsStat } from '../../core/vfs/types';
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
    this._initRootDropZone();
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

    // 2. 右クリックメニュー生成時のアプリ一覧要求
    this.treeView.on('resolve_apps', (path: string): ResolvedApp[] => {
      try {
        const stat = this.vfs.stat(this.getActivePrincipal(), path);
        return this.resolver.resolveAllAvailable(stat);
      } catch (e) {
        return [];
      }
    });

    // 3. コンテキストメニューから特定のアプリを指定して開く要求
    this.treeView.on('open_with', (path: string, appId: string) => {
      try {
        const stat = this.vfs.stat(this.getActivePrincipal(), path);
        const apps = this.resolver.resolveAllAvailable(stat);
        const targetApp = apps.find((a) => a.appId === appId);
        if (targetApp && this.events['open_file']) {
          this.events['open_file'](path, targetApp);
        }
      } catch (e: any) {
        if (window.AppUI) window.AppUI.notify(`Cannot open file: ${e.message}`, 'error');
      }
    });

    this.treeView.on('create_file', async (path: string) => {
      try {
        await this.vfs.writeFile(this.getActivePrincipal(), path, '');
        this._emitHistory('file_created', `User created empty file: ${path}`);
      } catch (e: any) {
        if (window.AppUI) window.AppUI.notify(e.message, 'error');
      }
    });

    this.treeView.on('create_folder', async (path: string) => {
      try {
        await this.vfs.mkdir(this.getActivePrincipal(), path);
        this._emitHistory('folder_created', `User created folder: ${path}`);
      } catch (e: any) {
        if (window.AppUI) window.AppUI.notify(e.message, 'error');
      }
    });

    this.treeView.on('duplicate', async (path: string) => {
      try {
        const dotIndex = path.lastIndexOf('.');
        const base = dotIndex !== -1 ? path.substring(0, dotIndex) : path;
        const ext = dotIndex !== -1 ? path.substring(dotIndex) : '';
        let newPath = `${base}_copy${ext}`;
        let counter = 1;
        while (this.vfs.exists(this.getActivePrincipal(), newPath)) {
          newPath = `${base}_copy${counter}${ext}`;
          counter++;
        }
        await this.vfs.copyFile(this.getActivePrincipal(), path, newPath);
        this._emitHistory('file_created', `User duplicated file: ${path} -> ${newPath}`);
      } catch (e: any) {
        if (window.AppUI) window.AppUI.notify(e.message, 'error');
      }
    });

    this.treeView.on('rename', async (oldPath: string, newPath: string) => {
      try {
        await this.vfs.rename(this.getActivePrincipal(), oldPath, newPath);
        this._emitHistory('file_moved', `User renamed: ${oldPath} -> ${newPath}`);
      } catch (e: any) {
        if (window.AppUI) window.AppUI.notify(e.message, 'error');
      }
    });

    this.treeView.on('move', async (srcPath: string, destPath: string) => {
      try {
        await this.vfs.rename(this.getActivePrincipal(), srcPath, destPath);
        this._emitHistory('file_moved', `User moved file: ${srcPath} -> ${destPath}`);
      } catch (e: any) {
        if (window.AppUI) window.AppUI.notify(e.message, 'error');
      }
    });

    this.treeView.on('delete', async (path: string) => {
      try {
        await this.vfs.deleteFile(this.getActivePrincipal(), path);
        this._emitHistory('file_deleted', `User deleted: ${path}`);
      } catch (e: any) {
        if (window.AppUI) window.AppUI.notify(e.message, 'error');
      }
    });

    this.treeView.on('download', async (path: string) => {
      try {
        const stat = this.vfs.stat(this.getActivePrincipal(), path);
        if (stat.kind === 'file') {
          if (window.AppUI) window.AppUI.showLoading(`Downloading ${stat.name}...`);
          const blob = await this.vfs.readBlob(this.getActivePrincipal(), path);
          this._triggerBrowserDownload(blob, stat.name);
          if (window.AppUI) window.AppUI.hideLoading();
        } else {
          await this._downloadDirectoryAsZip(path);
        }
      } catch (e: any) {
        if (window.AppUI) window.AppUI.notify(`Download failed: ${e.message}`, 'error');
      }
    });

    this.treeView.on('properties_request', (path: string) => {
      if (this.events['properties_request']) this.events['properties_request'](path);
    });

    this.treeView.on('add_to_context', (path: string) => {
      if (this.events['add_to_context']) this.events['add_to_context'](path);
    });

    this.treeView.on('upload_file_request', (path: string) => {
      this.currentUploadTarget = path;
      if (this.els.INPUT_FILE) this.els.INPUT_FILE.click();
    });

    // フォルダのアップロード時は、既存のinputではなく専用のinputを動的に作成して使い捨てる
    this.treeView.on('upload_folder_request', (path: string) => {
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

  private async _downloadDirectoryAsZip(dirPath: string) {
    if (typeof JSZip === 'undefined') {
      if (window.AppUI) window.AppUI.notify('System Error: JSZip library not loaded.', 'error');
      return;
    }
    if (window.AppUI) window.AppUI.showLoading(`Compressing ${dirPath || 'root'}...`);

    const zip = new JSZip();
    const files = this.vfs.listFiles(this.getActivePrincipal(), {
      path: dirPath,
      recursive: true,
      detail: true,
    }) as VfsStat[];

    if (files.length === 0) {
      if (window.AppUI) window.AppUI.notify('Directory is empty.', 'warning');
      if (window.AppUI) window.AppUI.hideLoading();
      return;
    }

    const prefix = dirPath ? (dirPath.endsWith('/') ? dirPath : dirPath + '/') : '';

    for (const stat of files) {
      if (stat.kind === 'file') {
        const zipPath = stat.path.substring(prefix.length);
        if (!zipPath) continue;
        const blob = await this.vfs.readBlob(this.getActivePrincipal(), stat.path);
        zip.file(zipPath, blob);
      }
    }

    try {
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const dirName = dirPath ? dirPath.split('/').filter(Boolean).pop() : 'archive';
      this._triggerBrowserDownload(zipBlob, `${dirName}.zip`);
      this._emitHistory('project_exported', `User downloaded directory: ${dirPath}`);
    } catch (e: any) {
      console.error('Directory export failed:', e);
      if (window.AppUI) window.AppUI.notify('Export Failed: ' + e.message, 'error');
    } finally {
      if (window.AppUI) window.AppUI.hideLoading();
    }
  }

  private _bindUploads(): void {
    if (this.els.BTN_NEW_FILE) {
      this.els.BTN_NEW_FILE.onclick = () => this._promptCreateRoot('file');
    }
    if (this.els.BTN_NEW_FOLDER) {
      this.els.BTN_NEW_FOLDER.onclick = () => this._promptCreateRoot('folder');
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

  private async _promptCreateRoot(type: 'file' | 'folder') {
    const name = await window.AppUI?.prompt(`Enter new ${type} name:`);
    if (!name) return;

    const fullPath = name.replace(/^\/+/, '');

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

  private async _handleUploadAppend(e: Event, isFolder: boolean): Promise<void> {
    const input = e.target as HTMLInputElement;
    const files = input.files ? Array.from(input.files) : [];
    if (files.length === 0) return;

    if (window.AppUI) window.AppUI.notify(`Uploading ${files.length} items...`, 'info');

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
      }
    }

    if (uploadedPaths.length > 0) {
      if (window.AppUI) window.AppUI.notify(`Upload complete: ${uploadedPaths.length} items`, 'success');
      const summary = uploadedPaths.slice(0, 3).join(', ') + (uploadedPaths.length > 3 ? '...' : '');
      this._emitHistory(
        'file_created',
        `User uploaded ${uploadedPaths.length} files to "${targetDir || 'root'}": ${summary}`,
      );
    }

    input.value = '';
  }

  private _initRootDropZone() {
    if (!this.els.CONTAINER) return;

    this.els.CONTAINER.addEventListener('dragover', (e) => {
      if (e.dataTransfer && e.dataTransfer.types.includes('application/itera-file')) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        this.els.CONTAINER!.classList.add('bg-card', 'ring-2', 'ring-primary', 'ring-inset');
      }
    });

    this.els.CONTAINER.addEventListener('dragleave', (e) => {
      if (e.dataTransfer && e.dataTransfer.types.includes('application/itera-file')) {
        e.preventDefault();
        e.stopPropagation();
        if (!this.els.CONTAINER!.contains(e.relatedTarget as Node)) {
          this.els.CONTAINER!.classList.remove('bg-card', 'ring-2', 'ring-primary', 'ring-inset');
        }
      }
    });

    this.els.CONTAINER.addEventListener('drop', async (e) => {
      if (e.dataTransfer && e.dataTransfer.types.includes('application/itera-file')) {
        e.preventDefault();
        e.stopPropagation();
        this.els.CONTAINER!.classList.remove('bg-card', 'ring-2', 'ring-primary', 'ring-inset');

        const rawData = e.dataTransfer.getData('application/itera-file');
        if (rawData) {
          const data = JSON.parse(rawData);
          await this._emitMove(data.path, '');
        }
      }
    });

    document.addEventListener('dragend', (e) => {
      if (
        e.target &&
        (e.target as HTMLElement).classList &&
        (e.target as HTMLElement).classList.contains('tree-content')
      ) {
        (e.target as HTMLElement).style.opacity = '1';
      }
      this.els.CONTAINER!.classList.remove('bg-card', 'ring-2', 'ring-primary', 'ring-inset');
    });
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
      if (e.dataTransfer && !e.dataTransfer.types.includes('application/itera-file')) {
        e.dataTransfer.dropEffect = 'copy';
        sidebar.classList.add('bg-hover');
      }
    });

    sidebar.addEventListener('dragleave', () => {
      sidebar.classList.remove('bg-hover');
    });

    sidebar.addEventListener('drop', async (e) => {
      sidebar.classList.remove('bg-hover');

      if (e.dataTransfer && e.dataTransfer.types.includes('application/itera-file')) return;

      const items = e.dataTransfer?.items;
      if (!items) return;

      if (window.AppUI) window.AppUI.notify('Processing dropped files...', 'info');

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
        await this._batchWriteFiles(filesToUpload);
        if (window.AppUI) window.AppUI.notify('Drop processed successfully.', 'success');
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

  private async _batchWriteFiles(files: File[]): Promise<void> {
    const uploadedPaths: string[] = [];
    for (const file of files) {
      const relPath = ((file as any).fullPath || file.name).replace(/^\/+/, '');
      if (relPath.startsWith('.git/') || relPath.includes('/.git/') || relPath.endsWith('.DS_Store')) continue;

      try {
        await this.vfs.writeFile(this.getActivePrincipal(), relPath, file, {
          overwrite: true,
        });
        uploadedPaths.push(relPath);
      } catch (err: any) {
        console.error(`[Explorer] Import failed: ${relPath}`, err);
      }
    }

    if (uploadedPaths.length > 0) {
      const summary = uploadedPaths.slice(0, 3).join(', ') + (uploadedPaths.length > 3 ? '...' : '');
      this._emitHistory('file_created', `User dropped files: ${summary}`);
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
    const res = await window.AppUI?.showMessageBox({
      title: 'Rename or Move',
      message: `Edit path to rename or move the item:`,
      type: 'question',
      prompt: { defaultValue: path },
      buttons: [
        { label: 'Cancel', value: null, style: 'normal' },
        { label: 'Rename', value: 'rename', style: 'primary', isDefault: true }
      ]
    });
    
    const newPath = res?.value;
    if (!newPath || newPath === 'cancel' || newPath === path) return;
    if (this.events['rename']) this.events['rename'](path, newPath);
  }

  public async _confirmDelete(path: string, name: string) {
    const res = await window.AppUI?.showMessageBox({
      title: 'Delete Item',
      message: `Are you sure you want to delete "${name}"?`,
      type: 'warning',
      buttons: [
        { label: 'Cancel', value: false, style: 'normal' },
        { label: 'Delete', value: true, style: 'danger', isDefault: true }
      ]
    });

    if (res && res.value) {
      try {
        await this.vfs.deleteFile(this.getActivePrincipal(), path);
        this._emitHistory('file_deleted', `User deleted: ${path}`);
      } catch (e: any) {
        if (window.AppUI) window.AppUI.notify(e.message, 'error');
      }
    }
  }

  private async _emitMove(srcPath: string, destFolder: string) {
    if (srcPath === destFolder) return;

    const fileName = srcPath.split('/').pop()!;
    let newPath = destFolder ? (destFolder === srcPath ? srcPath : `${destFolder}/${fileName}`) : fileName;
    
    // destFolder === srcPath の場合に newPathがディレクトリ名と被る対策として
    if (!destFolder) newPath = fileName;
    else if (destFolder !== srcPath) newPath = `${destFolder}/${fileName}`;
    else newPath = srcPath;

    if (srcPath === newPath) return;
    if (destFolder.startsWith(srcPath + '/')) {
      if (window.AppUI) window.AppUI.showMessageBox({
        title: 'Invalid Move',
        message: 'Cannot move a folder into its own subfolder.',
        type: 'error',
        buttons: [{ label: 'OK', value: null, style: 'primary', isDefault: true }]
      });
      return;
    }

    if (this.vfs.exists(this.getActivePrincipal(), newPath)) {
      const stat = this.vfs.stat(this.getActivePrincipal(), newPath);
      const isDir = stat.kind === 'directory';
      
      const res = await window.AppUI?.showConflictDialog(fileName, isDir);
      if (!res || res.value === 'cancel') return;
      
      if (res.value === 'skip') return;
      
      if (res.value === 'keep_both') {
         const dotIndex = newPath.lastIndexOf('.');
         const base = dotIndex !== -1 ? newPath.substring(0, dotIndex) : newPath;
         const ext = dotIndex !== -1 ? newPath.substring(dotIndex) : '';
         let counter = 1;
         while (this.vfs.exists(this.getActivePrincipal(), newPath)) {
           newPath = `${base}_copy${counter}${ext}`;
           counter++;
         }
         try {
           await this.vfs.rename(this.getActivePrincipal(), srcPath, newPath);
           this._emitHistory('file_moved', `User moved file: ${srcPath} -> ${newPath}`);
         } catch(e: any) {
           if (window.AppUI) window.AppUI.notify(e.message, 'error');
         }
         return;
      }

      if (res.value === 'merge') {
        await this._mergeDirectory(srcPath, newPath, false);
        return;
      }
      
      if (res.value === 'replace') {
        try {
           await this.vfs.deleteFile(this.getActivePrincipal(), newPath, { permanent: true });
           await this.vfs.rename(this.getActivePrincipal(), srcPath, newPath);
           this._emitHistory('file_moved', `User moved and replaced file: ${srcPath} -> ${newPath}`);
        } catch (e: any) {
           if (window.AppUI) window.AppUI.notify(`Replace failed: ${e.message}`, 'error');
        }
        return;
      }
    }

    try {
      await this.vfs.rename(this.getActivePrincipal(), srcPath, newPath);
      this._emitHistory('file_moved', `User moved file: ${srcPath} -> ${newPath}`);
    } catch(e: any) {
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
                         if (!res || res.value === 'cancel') return false; 
                         action = res.value;

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
