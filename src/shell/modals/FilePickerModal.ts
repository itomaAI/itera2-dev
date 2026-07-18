/**
 * src/shell/modals/FilePickerModal.ts
 * Itera OS v2: Host Native File Picker Modal
 */

import type { VfsService } from '../../core/vfs/VfsService';
import type { Principal } from '../../core/vfs/types';
import { TreeView } from '../panels/TreeView';

export interface FilePickerOptions {
  title?: string;
  filters?: string[];
  defaultPath?: string;
}

export class FilePickerModal {
  private vfs: VfsService;
  private getActivePrincipal: () => Principal;

  private overlay: HTMLElement | null = null;
  private treeContainer: HTMLElement | null = null;
  private treeView: TreeView | null = null;
  private selectedPathDisplay: HTMLElement | null = null;
  private btnOpen: HTMLButtonElement | null = null;

  private isOpen = false;
  private currentResolve: ((value: string | null) => void) | null = null;
  private currentFilters: string[] = [];
  private selectedPath: string | null = null;

  constructor(vfs: VfsService, getActivePrincipal: () => Principal) {
    this.vfs = vfs;
    this.getActivePrincipal = getActivePrincipal;
  }

  private _createDOM() {
    if (this.overlay) return;

    this.overlay = document.createElement('div');
    this.overlay.className =
      'fixed inset-0 bg-black/60 backdrop-blur-sm z-[10001] flex items-center justify-center p-4 itera-animate-fade select-none';

    this.overlay.onclick = (e) => {
      if (e.target === this.overlay) this.close(null);
    };

    const box = document.createElement('div');
    box.className =
      'bg-panel border border-border-main rounded-2xl shadow-2xl w-full max-w-lg flex flex-col overflow-hidden max-h-[85vh] itera-animate-modal';

    // Header
    const header = document.createElement('div');
    header.className = 'px-5 py-4 border-b border-border-main bg-card/50 flex items-center justify-between shrink-0';

    const titleContainer = document.createElement('div');
    titleContainer.className = 'flex items-center gap-3';
    titleContainer.innerHTML = `
      <div class="text-2xl shrink-0">📂</div>
      <div>
        <h2 id="file-picker-title" class="font-bold text-text-main text-base leading-tight">Select a File</h2>
        <div id="file-picker-filters" class="text-[10px] text-text-muted font-mono uppercase tracking-widest mt-0.5">All Files</div>
      </div>
    `;

    const btnClose = document.createElement('button');
    btnClose.className =
      'shrink-0 w-8 h-8 flex items-center justify-center rounded-full bg-card hover:bg-hover border border-border-main text-text-muted hover:text-text-main transition';
    btnClose.innerHTML = '✕';
    btnClose.onclick = () => this.close(null);

    header.appendChild(titleContainer);
    header.appendChild(btnClose);

    // Content Area (Tree)
    this.treeContainer = document.createElement('div');
    this.treeContainer.className = 'flex-1 overflow-y-auto p-2 bg-app min-h-[300px] relative';

    // Footer
    const footer = document.createElement('div');
    footer.className = 'px-5 py-3 border-t border-border-main bg-card flex flex-col gap-3 shrink-0';

    this.selectedPathDisplay = document.createElement('div');
    this.selectedPathDisplay.className =
      'text-xs font-mono text-text-muted truncate bg-panel px-2 py-1.5 rounded border border-border-main';
    this.selectedPathDisplay.textContent = 'No file selected';

    const actions = document.createElement('div');
    actions.className = 'flex justify-end gap-2';

    const btnCancel = document.createElement('button');
    btnCancel.className =
      'px-4 py-2 rounded-lg text-xs font-bold text-text-muted hover:text-text-main hover:bg-hover transition';
    btnCancel.textContent = 'Cancel';
    btnCancel.onclick = () => this.close(null);

    this.btnOpen = document.createElement('button');
    this.btnOpen.className =
      'px-6 py-2 rounded-lg text-xs font-bold bg-primary text-white hover:bg-primary/90 shadow transition disabled:opacity-50 disabled:cursor-not-allowed';
    this.btnOpen.textContent = 'Open';
    this.btnOpen.disabled = true;
    this.btnOpen.onclick = () => {
      if (this.selectedPath) this.close(this.selectedPath);
    };

    actions.appendChild(btnCancel);
    actions.appendChild(this.btnOpen);

    footer.appendChild(this.selectedPathDisplay);
    footer.appendChild(actions);

    box.appendChild(header);
    box.appendChild(this.treeContainer);
    box.appendChild(footer);

    this.overlay.appendChild(box);
    document.body.appendChild(this.overlay);

    // TreeViewのインスタンス化 (ContextMenuは不要なので null を渡す)
    this.treeView = new TreeView(this.treeContainer, null);

    this.treeView.on('open', (path: string) => {
      this._handleSelect(path);
    });
  }

  private _handleSelect(path: string) {
    try {
      const stat = this.vfs.stat(this.getActivePrincipal(), path);
      if (stat.kind === 'directory') return;

      // 拡張子フィルターのチェック
      if (this.currentFilters.length > 0) {
        const ext = '.' + path.split('.').pop()?.toLowerCase();
        if (!this.currentFilters.some((f) => ext.endsWith(f.toLowerCase()))) {
          if (window.AppUI) window.AppUI.notify('Invalid file type selected.', 'warning');
          return;
        }
      }

      this.selectedPath = path;
      if (this.selectedPathDisplay) {
        this.selectedPathDisplay.textContent = path;
        this.selectedPathDisplay.classList.add('text-primary', 'font-bold');
        this.selectedPathDisplay.classList.remove('text-text-muted');
      }
      if (this.btnOpen) {
        this.btnOpen.disabled = false;
      }
    } catch (e) {
      // 権限エラーなどは無視
    }
  }

  public async open(options?: FilePickerOptions): Promise<string | null> {
    this._createDOM();

    this.selectedPath = null;
    this.currentFilters = options?.filters || [];

    if (this.selectedPathDisplay) {
      this.selectedPathDisplay.textContent = 'No file selected';
      this.selectedPathDisplay.classList.remove('text-primary', 'font-bold');
      this.selectedPathDisplay.classList.add('text-text-muted');
    }
    if (this.btnOpen) this.btnOpen.disabled = true;

    const titleEl = document.getElementById('file-picker-title');
    const filtersEl = document.getElementById('file-picker-filters');

    if (titleEl) titleEl.textContent = options?.title || 'Select a File';
    if (filtersEl) {
      filtersEl.textContent =
        this.currentFilters.length > 0 ? 'Allowed: ' + this.currentFilters.join(', ') : 'All Files';
    }

    // ツリーの最新状態を描画
    if (this.treeView) {
      this.treeView.render(this.vfs.getTree(this.getActivePrincipal()));
    }

    this.overlay?.classList.remove('hidden');
    this.isOpen = true;

    return new Promise((resolve) => {
      this.currentResolve = resolve;
    });
  }

  private close(result: string | null) {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.overlay?.classList.add('hidden');

    // プロセスマネージャ等と競合しないようフォーカスを外す
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    if (this.currentResolve) {
      this.currentResolve(result);
      this.currentResolve = null;
    }
  }
}
