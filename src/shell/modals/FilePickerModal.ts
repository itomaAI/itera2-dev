/**
 * src/shell/modals/FilePickerModal.ts
 * Itera OS v2: Host Native File Picker Modal
 */

import type { VfsService } from '../../core/vfs/VfsService';
import type { Principal } from '../../core/vfs/types';
import { TreeView } from '../panels/TreeView';
import { LABEL_KICKER } from '../styles/typography';

/** 何を選ばせるか。既定は 'file'（従来どおり） */
export type PickerMode = 'file' | 'directory' | 'any';

export interface FilePickerOptions {
  title?: string;
  filters?: string[];
  defaultPath?: string;
  mode?: PickerMode;
}

/** 保存ダイアログの引数 */
export interface SaveDialogOptions {
  title?: string;
  /** 拡張子の候補（例 ['.xlsx', '.csv']）。名前に拡張子が無ければ先頭のものを付ける */
  filters?: string[];
  /** 既定のフォルダ（無ければ defaultPath の親、それも無ければルート） */
  defaultDir?: string;
  /** 既定のフルパス。フォルダと名前の初期値をここから取る */
  defaultPath?: string;
  /** 既定の名前（defaultPath より優先） */
  defaultName?: string;
}

/**
 * 保存先のフルパスを組み立てる。
 *
 * - 名前が空・区切り文字を含む → null（保存できない）
 * - 名前に拡張子が無く filters があれば、先頭の拡張子を付ける（`見積` → `見積.xlsx`）
 * - 名前の拡張子が filters に無ければ null（呼び出し側が受け取れない形を作らない）
 */
export function resolveSavePath(dir: string, name: string, filters: string[]): string | null {
  const n = (name || '').trim();
  if (!n || /[\\/]/.test(n) || n === '.' || n === '..') return null;
  const fs = filters.map((f) => f.toLowerCase());
  const dot = n.lastIndexOf('.');
  const hasExt = dot > 0 && dot < n.length - 1;
  let final = n;
  if (fs.length > 0) {
    if (!hasExt) final = n + filters[0];
    else if (!fs.some((f) => n.toLowerCase().endsWith(f))) return null;
  }
  const d = (dir || '').replace(/\/+$/, '');
  return d ? `${d}/${final}` : final;
}

/**
 * その項目を選べるか。
 *
 * 拡張子フィルタは**ファイルにだけ**掛ける。ディレクトリに掛けると、
 * 名前に点を含むフォルダ（例: `v1.2`）だけが選べるという妙な挙動になる。
 */
export function isSelectableForPicker(
  kind: 'file' | 'directory',
  mode: PickerMode,
  path: string,
  filters: string[],
): boolean {
  if (kind === 'directory') return mode === 'directory' || mode === 'any';
  if (mode === 'directory') return false;
  if (filters.length === 0) return true;
  const ext = '.' + (path.split('.').pop() || '').toLowerCase();
  return filters.some((f) => ext.endsWith(f.toLowerCase()));
}

export class FilePickerModal {
  private vfs: VfsService;
  private getActivePrincipal: () => Principal;

  private overlay: HTMLElement | null = null;
  private treeContainer: HTMLElement | null = null;
  private treeView: TreeView | null = null;
  private selectedPathDisplay: HTMLElement | null = null;
  private btnOpen: HTMLButtonElement | null = null;
  private nameRow: HTMLElement | null = null;
  private nameInput: HTMLInputElement | null = null;

  private isOpen = false;
  private currentResolve: ((value: string | null) => void) | null = null;
  private currentFilters: string[] = [];
  private currentMode: PickerMode = 'file';
  private selectedPath: string | null = null;
  /** 保存ダイアログとして開いているか（ツリーではフォルダを選び、名前は入力欄） */
  private saving = false;
  private saveDir = '';

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
        <div id="file-picker-filters" class="${LABEL_KICKER} text-text-muted mt-0.5">All Files</div>
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

    // 保存のときだけ出す名前の欄
    this.nameRow = document.createElement('div');
    this.nameRow.className = 'hidden flex items-center gap-2';
    const nameLabel = document.createElement('span');
    nameLabel.className = 'text-xs text-text-muted shrink-0';
    nameLabel.textContent = 'ファイル名';
    this.nameInput = document.createElement('input');
    this.nameInput.type = 'text';
    this.nameInput.className =
      'flex-1 min-w-0 px-2 py-1.5 rounded border border-border-main bg-panel text-sm text-text-main font-mono';
    this.nameInput.oninput = () => this._updateSaveState();
    this.nameInput.onkeydown = (e) => {
      if (e.key === 'Enter' && this.btnOpen && !this.btnOpen.disabled) this.btnOpen.click();
    };
    this.nameRow.appendChild(nameLabel);
    this.nameRow.appendChild(this.nameInput);

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
      if (this.saving) {
        void this._confirmSave();
        return;
      }
      if (this.selectedPath) this.close(this.selectedPath);
    };

    actions.appendChild(btnCancel);
    actions.appendChild(this.btnOpen);

    footer.appendChild(this.nameRow);
    footer.appendChild(this.selectedPathDisplay);
    footer.appendChild(actions);

    box.appendChild(header);
    box.appendChild(this.treeContainer);
    box.appendChild(footer);

    this.overlay.appendChild(box);
    document.body.appendChild(this.overlay);

    // TreeViewのインスタンス化 (ContextMenuは不要なので null を渡す)
    this.treeView = new TreeView(this.treeContainer, null);

    // ディレクトリはクリックしても 'open' を出さない（開閉するだけ）ため、
    // 種類を問わず発火する 'select' で受ける。ファイルもこれで拾える。
    this.treeView.on('select', (path: string) => {
      this._handleSelect(path);
    });
  }

  private _handleSelect(path: string) {
    try {
      const stat = this.vfs.stat(this.getActivePrincipal(), path);
      const kind: 'file' | 'directory' = stat.kind === 'directory' ? 'directory' : 'file';

      if (this.saving) {
        // 保存: フォルダを選べば保存先、ファイルを選べばそのフォルダ＋その名前（上書きの候補）
        if (kind === 'directory') {
          this.saveDir = path;
        } else {
          const i = path.lastIndexOf('/');
          this.saveDir = i >= 0 ? path.slice(0, i) : '';
          if (this.nameInput) this.nameInput.value = i >= 0 ? path.slice(i + 1) : path;
        }
        this._updateSaveState();
        return;
      }

      if (!isSelectableForPicker(kind, this.currentMode, path, this.currentFilters)) {
        // 種類違い（フォルダを選ぼうとした等）は黙って無視する。
        // 拡張子で弾いたときだけは、なぜ選べないのか分からないので知らせる。
        if (kind === 'file' && this.currentFilters.length > 0) {
          if (window.AppUI) window.AppUI.notify('Invalid file type selected.', 'warning');
        }
        return;
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

  /** 保存先を決める部分（名前＋フォルダ → フルパス）を画面に反映する */
  private _updateSaveState() {
    const full = resolveSavePath(this.saveDir, this.nameInput?.value || '', this.currentFilters);
    this.selectedPath = full;
    if (this.selectedPathDisplay) {
      this.selectedPathDisplay.textContent = full || (this.saveDir ? `${this.saveDir}/` : 'フォルダを選んでください');
      this.selectedPathDisplay.classList.toggle('text-primary', !!full);
      this.selectedPathDisplay.classList.toggle('font-bold', !!full);
      this.selectedPathDisplay.classList.toggle('text-text-muted', !full);
    }
    if (this.btnOpen) this.btnOpen.disabled = !full;
  }

  /** 上書きになるなら確かめてから閉じる */
  private async _confirmSave() {
    const full = this.selectedPath;
    if (!full) return;
    let exists = false;
    try {
      exists = this.vfs.exists(this.getActivePrincipal(), full);
    } catch {
      exists = false;
    }
    if (exists) {
      const ok = window.AppUI?.confirm
        ? await window.AppUI.confirm(`${full} は既にあります。上書きしますか？`)
        : window.confirm(`${full} は既にあります。上書きしますか？`);
      if (!ok) return;
    }
    this.close(full);
  }

  /**
   * 保存ダイアログ。ツリーでフォルダ（またはファイル）を選び、名前を入力してフルパスを返す。
   * 取り消しは null。上書きになるときはここで確かめる。
   */
  public async openSave(options?: SaveDialogOptions): Promise<string | null> {
    this._createDOM();

    this.saving = true;
    this.currentMode = 'any';
    this.currentFilters = options?.filters || [];
    const dp = options?.defaultPath || '';
    const slash = dp.lastIndexOf('/');
    this.saveDir = options?.defaultDir ?? (slash >= 0 ? dp.slice(0, slash) : '');
    const defaultName = options?.defaultName ?? (dp ? dp.slice(slash + 1) : '');

    const titleEl = document.getElementById('file-picker-title');
    const filtersEl = document.getElementById('file-picker-filters');
    if (titleEl) titleEl.textContent = options?.title || '名前を付けて保存';
    if (filtersEl) {
      filtersEl.textContent =
        this.currentFilters.length > 0 ? 'Allowed: ' + this.currentFilters.join(', ') : 'All Files';
    }
    if (this.btnOpen) this.btnOpen.textContent = 'Save';
    this.nameRow?.classList.remove('hidden');
    if (this.nameInput) this.nameInput.value = defaultName;
    this._updateSaveState();

    if (this.treeView) {
      this.treeView.render(this.vfs.getTree(this.getActivePrincipal()));
    }

    this.overlay?.classList.remove('hidden');
    this.isOpen = true;
    setTimeout(() => {
      this.nameInput?.focus();
      this.nameInput?.select();
    }, 0);

    return new Promise((resolve) => {
      this.currentResolve = resolve;
    });
  }

  public async open(options?: FilePickerOptions): Promise<string | null> {
    this._createDOM();

    this.saving = false;
    this.nameRow?.classList.add('hidden');
    if (this.btnOpen) this.btnOpen.textContent = 'Open';
    this.selectedPath = null;
    this.currentFilters = options?.filters || [];
    this.currentMode = options?.mode || 'file';
    const noun = this.currentMode === 'directory' ? 'folder' : this.currentMode === 'any' ? 'item' : 'file';

    if (this.selectedPathDisplay) {
      this.selectedPathDisplay.textContent = `No ${noun} selected`;
      this.selectedPathDisplay.classList.remove('text-primary', 'font-bold');
      this.selectedPathDisplay.classList.add('text-text-muted');
    }
    if (this.btnOpen) this.btnOpen.disabled = true;

    const titleEl = document.getElementById('file-picker-title');
    const filtersEl = document.getElementById('file-picker-filters');

    if (titleEl) {
      const fallback =
        this.currentMode === 'directory'
          ? 'Select a Folder'
          : this.currentMode === 'any'
            ? 'Select an Item'
            : 'Select a File';
      titleEl.textContent = options?.title || fallback;
    }
    if (filtersEl) {
      filtersEl.textContent =
        this.currentMode === 'directory'
          ? 'Folders only'
          : this.currentFilters.length > 0
            ? 'Allowed: ' + this.currentFilters.join(', ')
            : 'All Files';
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
