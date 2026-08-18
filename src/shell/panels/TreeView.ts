/**
 * src/shell/panels/TreeView.ts
 * Itera OS v2: Surgical DOM Update Tree View
 */

import type { TreeNode } from '../../core/vfs/types';

export class TreeView {
  private container: HTMLElement;
  private contextMenu: HTMLElement | null;
  private events: Record<string, Function> = {};

  private expandedPaths: Set<string> = new Set();
  private selectedPaths: Set<string> = new Set();
  private lastClickedPath: string | null = null;

  constructor(containerEl: HTMLElement, contextMenuEl: HTMLElement | null) {
    this.container = containerEl;
    this.contextMenu = contextMenuEl;

    this._initGlobalEvents();
    this._initRootDropZone();
  }

  on(event: string, callback: Function) {
    this.events[event] = callback;
  }

  // ==========================================
  // 1. Initial Render (全描画)
  // ==========================================

  render(treeData: TreeNode[]) {
    if (!this.container) return;

    this.container.classList.remove(
      'bg-hover',
      'border-2',
      'border-dashed',
      'border-primary',
      'bg-card',
      'ring-2',
      'ring-primary',
      'ring-inset',
    );
    this.container.innerHTML = '';

    const rootUl = document.createElement('ul');
    rootUl.id = 'vfs-tree-root';
    rootUl.className = 'tree-root text-sm font-mono text-text-main min-h-full pb-4';

    const fragment = document.createDocumentFragment();
    this._buildInitialTree(fragment, treeData, 0);

    rootUl.appendChild(fragment);
    this.container.appendChild(rootUl);
  }

  private _buildInitialTree(parentElement: DocumentFragment | HTMLElement, nodes: TreeNode[], indentLevel: number) {
    for (const node of nodes) {
      if (node.name === '.keep') continue;

      const li = this._createNodeElement(
        node.id,
        node.name,
        node.path,
        node.kind,
        node.meta,
        indentLevel,
        !!node.isVirtual,
        !!node.isMountPoint,
      );
      parentElement.appendChild(li);

      if (node.kind === 'directory' && node.children && node.children.length > 0) {
        const childUl = li.querySelector(`#vfs-children-${node.id}`) as HTMLUListElement;
        if (childUl) {
          this._buildInitialTree(childUl, node.children, indentLevel + 1);
        }
      }
    }
  }

  // ==========================================
  // 2. Surgical DOM Update (差分更新 / 宣言的修復)
  // ==========================================

  // 引数に VfsService と Principal を渡し、必要に応じて自身で全再描画（Re-render）をトリガーできるようにする
  applyMutations(mutations: any[], getTreeFn: () => TreeNode[]) {
    if (!this.container) return;

    let needsFullRender = false;

    for (const mutation of mutations) {
      if (mutation.type === 'DETACH') {
        const targetDiv = document.querySelector(`div[data-path="${mutation.path}"]`) as HTMLElement;
        if (targetDiv) {
          // 削除されたのがディレクトリなら、配下の子ノードも消えるため安全のために全再描画フラグを立てる
          if (targetDiv.dataset.kind === 'directory') {
            needsFullRender = true;
          }
          const targetLi = targetDiv.parentElement;
          if (targetLi) targetLi.remove();
        }

        // 内部状態のCascade Purge (巻き込み削除)
        for (const p of this.selectedPaths) {
          if (p === mutation.path || p.startsWith(mutation.path + '/')) {
            this.selectedPaths.delete(p);
          }
        }
        for (const p of this.expandedPaths) {
          if (p === mutation.path || p.startsWith(mutation.path + '/')) {
            this.expandedPaths.delete(p);
          }
        }
      } else if (mutation.type === 'ATTACH') {
        if (!mutation.node || mutation.node.flags?.isHidden || mutation.node.name === '.keep') continue;

        // ディレクトリがアタッチされた場合（移動・コピー・新規作成）、
        // ツリー構造の再構築が必要になるため全再描画を行う
        if (mutation.node.kind === 'directory') {
          needsFullRender = true;
        } else {
          this._handleNodeAttached(mutation);
        }
      } else if (mutation.type === 'MUTATE') {
        // マウントの登録・解除は ProviderManager が node=null のダミー MUTATE で知らせてくる。
        // 部分木まるごと見た目が変わるので、ここだけは全再描画にする。
        // （_handleNodeMutated は node が無いと即 return するため、この合図は
        //   これまで誰にも拾われておらず、印は再読込するまで変わらなかった）
        if (mutation.changedProperties && mutation.changedProperties.includes('isMountPoint')) {
          needsFullRender = true;
        } else {
          this._handleNodeMutated(mutation);
        }
      }
    }

    if (needsFullRender) {
      this.render(getTreeFn());
    }
  }

  private _handleNodeAttached(mutation: any) {
    if (document.getElementById(`vfs-node-${mutation.nodeId}`)) return;

    let parentUl: HTMLElement | null = null;
    let indentLevel = 0;

    // ★ 同期の印は親から受け継ぐ。
    //   ここは「新しく作られたノード」を描く経路で、mutation は VfsNode しか持たないため
    //   isVirtual が入っていない。渡し忘れると、同期フォルダの中に新規作成したファイルだけ
    //   雲が付かず、再読込して初めて付く（実際にこの状態で配信してしまった）。
    //   マウントは前方一致なので、親が同期対象なら子も必ず同期対象になる。
    //   新規ノードがマウント地点そのものになることは無いので isMountPoint は常に false。
    let isVirtual = false;

    if (mutation.node.parentId === null) {
      // 最上位のノード。ルート以外のマウントの配下ではありえないので false のままでよい。
      parentUl = document.getElementById('vfs-tree-root');
    } else {
      parentUl = document.getElementById(`vfs-children-${mutation.node.parentId}`);
      const parentDiv = document.querySelector(`div[data-node-id="${mutation.node.parentId}"]`) as HTMLElement;
      if (parentDiv) {
        const paddingRaw = parentDiv.style.paddingLeft || '8px';
        const parentPadding = parseInt(paddingRaw.replace('px', ''), 10);
        indentLevel = (parentPadding - 8) / 12 + 1;
        // マウント地点の行も data-virtual を持つ（getTree はルート以外のマウントに
        // isVirtual を立てる。ルートはノードとして描かれない）。したがってここは
        // data-virtual だけを見ればよい。data-mount も見る条件を一度書いたが、
        // 変異試験で「外しても何も落ちない」＝起きえない場合だと分かったので落とした。
        isVirtual = parentDiv.dataset.virtual === '1';
      }
    }

    if (!parentUl) return;

    const newLi = this._createNodeElement(
      mutation.node.id,
      mutation.node.name,
      mutation.path,
      mutation.node.kind,
      mutation.node.meta,
      indentLevel,
      isVirtual,
      false,
    );

    parentUl.appendChild(newLi);
    this._sortChildren(parentUl);
  }

  private _handleNodeMutated(mutation: any) {
    if (!mutation.node) return;
    const targetDiv = document.querySelector(`div[data-node-id="${mutation.nodeId}"]`) as HTMLElement;

    if (targetDiv) {
      const sizeKB = (mutation.node.meta.size / 1024).toFixed(1) + ' KB';
      const updated = new Date(mutation.node.meta.updatedAt).toLocaleString();
      targetDiv.title = `Size: ${sizeKB}\nUpdated: ${updated}`;

      const name = mutation.node.name;
      const path = mutation.path;
      const isStub = mutation.node.meta && mutation.node.meta.syncState === 'stub';
      // 薄さ＝中身がまだ手元に無い（スタブ）。☁️＝同期対象。役割を分けている。
      // 同期プロバイダの印は差分更新の入力（VfsNode）には入っていない。
      // 描いた時に DOM へ残してあるので、そこから引き継ぐ。
      // ここを落とすと「配下のファイルが1つ同期されるたびに親の印が消える」ことになる。
      const isVirtual = targetDiv.dataset.virtual === '1';
      const isMountPoint = targetDiv.dataset.mount === '1';
      const iconHtml = this._getIconHtml(path, mutation.node.kind, name, isMountPoint);
      const syncIndicator = this._getSyncIndicator(isVirtual, !!isStub);

      targetDiv.innerHTML = `
        ${iconHtml}
        <span class="truncate pointer-events-none flex-1${isStub ? ' text-text-muted' : ''}">${name}${syncIndicator}</span>
        <button class="menu-btn w-6 h-6 flex items-center justify-center text-text-muted hover:text-text-main hover:bg-hover rounded ml-1 transition flex-shrink-0 opacity-100 md:opacity-0 group-hover:opacity-100">
          ⋮
        </button>
      `;

      targetDiv.dataset.name = name;
      targetDiv.dataset.path = path;

      const menuBtn = targetDiv.querySelector('.menu-btn') as HTMLButtonElement;
      if (menuBtn) {
        menuBtn.onclick = (e) => {
          e.stopPropagation();
          e.preventDefault();
          if (!this.selectedPaths.has(path)) {
            this.selectedPaths.clear();
            this.selectedPaths.add(path);
            this.lastClickedPath = path;
            this._updateSelectionUI();
          }
          const rect = menuBtn.getBoundingClientRect();
          this._showContextMenu(rect.left, rect.bottom);
        };
      }
    }
  }

  private _sortChildren(ul: HTMLElement) {
    const items = Array.from(ul.children) as HTMLElement[];
    items.sort((a, b) => {
      const aKind = a.dataset.kind || 'file';
      const bKind = b.dataset.kind || 'file';
      if (aKind !== bKind) return aKind === 'directory' ? -1 : 1;

      const aName = a.dataset.name || '';
      const bName = b.dataset.name || '';
      return aName.localeCompare(bName);
    });

    for (const item of items) {
      ul.appendChild(item);
    }
  }

  // ==========================================
  // 3. DOM Element Construction
  // ==========================================

  private _createNodeElement(
    id: string,
    name: string,
    path: string,
    kind: 'file' | 'directory',
    meta: any,
    indentLevel: number,
    isVirtual: boolean = false,
    isMountPoint: boolean = false,
  ): HTMLElement {
    const li = document.createElement('li');
    li.id = `vfs-node-${id}`;
    li.className = 'tree-node select-none';
    li.dataset.kind = kind;
    li.dataset.name = name;

    const div = document.createElement('div');
    const isSelected = this.selectedPaths.has(path);

    div.className = `tree-content group hover:bg-hover cursor-pointer flex items-center py-0.5 px-2 border-l-2 border-transparent transition ${isSelected ? 'bg-hover border-primary' : ''}`;
    div.style.paddingLeft = `${indentLevel * 12 + 8}px`;

    div.dataset.nodeId = id;
    div.dataset.path = path;
    div.dataset.kind = kind;
    div.dataset.name = name;

    // 【重要】同期プロバイダの印は DOM 側に持たせる。
    // 差分更新と開閉トグルは TreeNode を持たず、DOM だけを見て描き直すため、
    // ここに残しておかないと再描画のたびに印が消える。
    if (isVirtual) div.dataset.virtual = '1';
    if (isMountPoint) div.dataset.mount = '1';

    const sizeKB = meta ? (meta.size / 1024).toFixed(1) + ' KB' : '0 KB';
    const updated = meta ? new Date(meta.updatedAt || meta.updated_at).toLocaleString() : '';
    div.title = `Size: ${sizeKB}\nUpdated: ${updated}`;

    div.draggable = true;
    div.addEventListener('dragstart', (e) => this._handleDragStart(e, path));

    if (kind === 'directory') {
      div.addEventListener('dragover', (e) => this._handleDragOver(e, div));
      div.addEventListener('dragleave', (e) => this._handleDragLeave(e, div));
      div.addEventListener('drop', (e) => this._handleDrop(e, path, div));
    }

    const iconHtml = this._getIconHtml(path, kind, name, isMountPoint);

    // 薄さ＝中身がまだ手元に無い（スタブ）。☁️＝同期対象。役割を分けている。
    const isStub = meta && meta.syncState === 'stub';
    const syncIndicator = this._getSyncIndicator(isVirtual, !!isStub);

    div.innerHTML = `
      ${iconHtml}
      <span class="truncate pointer-events-none flex-1${isStub ? ' text-text-muted' : ''}">${name}${syncIndicator}</span>
      <button class="menu-btn w-6 h-6 flex items-center justify-center text-text-muted hover:text-text-main hover:bg-hover rounded ml-1 transition flex-shrink-0 opacity-100 md:opacity-0 group-hover:opacity-100">
        ⋮
      </button>
    `;

    div.onclick = (e) => this._handleClick(e, path, kind);
    div.oncontextmenu = (e) => this._handleContextMenu(e, path);

    const menuBtn = div.querySelector('.menu-btn') as HTMLButtonElement;
    if (menuBtn) {
      menuBtn.onclick = (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (!this.selectedPaths.has(path)) {
          this.selectedPaths.clear();
          this.selectedPaths.add(path);
          this.lastClickedPath = path;
          this._updateSelectionUI();
        }
        const rect = menuBtn.getBoundingClientRect();
        this._showContextMenu(rect.left, rect.bottom);
      };
    }

    li.appendChild(div);

    if (kind === 'directory') {
      const childUl = document.createElement('ul');
      childUl.id = `vfs-children-${id}`;
      childUl.className = `tree-children ${this.expandedPaths.has(path) ? 'block' : 'hidden'}`;
      li.appendChild(childUl);
    }

    return li;
  }

  /**
   * 表示アイコンの決定を1箇所に集約する。
   *
   * 以前は初期描画・差分更新・開閉トグルの3経路が同じ規則をそれぞれ持っており、
   * trash / system の特例まで3回書かれていた。どれか1つを直し忘れると、
   * 「開くと印が消える」「同期後に印が戻らない」といった形で食い違う。
   */
  private _getIcon(path: string, kind: string, name: string, _isMountPoint: boolean): string {
    if (path === 'trash') return '🗑️';
    if (path === 'system') return '⚙️';
    if (kind !== 'directory') return this._getFileIcon(name);
    // マウント地点も含め、ディレクトリは開閉が分かる形を保つ。
    // 同期の印はアイコンに重ねず、名前の右に出す（_getSyncIndicator）。
    return this.expandedPaths.has(path) ? '📂' : '📁';
  }

  /** アイコン欄。★ 子要素を持たせないこと（開閉トグルが textContent で書き換えるため） */
  private _getIconHtml(path: string, kind: string, name: string, isMountPoint: boolean): string {
    const icon = this._getIcon(path, kind, name, isMountPoint);
    return `<span class="mr-2 opacity-80 text-xs pointer-events-none flex-shrink-0">${icon}</span>`;
  }

  /**
   * 名前の右に出す同期の印（2026-08-18 山内さん判断）。
   *
   * ★ ☁️ の意味は「スタブ（中身が無い）」ではなく「**同期対象**」である。
   *   以前はスタブにだけ付けていたが、ディレクトリとファイルで印の位置も意味も
   *   食い違っていた。ここを揃え、役割を2つに分けた:
   *
   *     ☁️        … このファイル／フォルダは同期プロバイダの管轄下にある
   *     文字の薄さ … 中身がまだ手元に無い（スタブ）
   *
   *   したがって同期対象のファイルは、実体化されていても ☁️ を出し続ける。
   *
   * ★ 出すのは「ルート以外のプロバイダが管轄する領域」だけ（判定は VfsService.getTree）。
   *   ルート同期（VFS 全体）まで含めると全件に付き、印としての情報量がゼロになる。
   */
  private _getSyncIndicator(isVirtual: boolean, isStub: boolean): string {
    if (!isVirtual) return '';
    const title = isStub ? 'Synced (content is on the host)' : 'Synced';
    return `<span class="ml-1 text-primary text-[0.625rem]" title="${title}">☁️</span>`;
  }

  private _getFileIcon(filename: string): string {
    if (filename.endsWith('.js') || filename.endsWith('.ts')) return '📜';
    if (filename.endsWith('.html')) return '🌐';
    if (filename.endsWith('.css')) return '🎨';
    if (filename.endsWith('.json')) return '🔧';
    if (filename.match(/\.(png|jpg|jpeg|svg|gif|webp|ico)$/i)) return '🖼️';
    if (filename.endsWith('.pdf')) return '📕';
    if (filename.endsWith('.zip')) return '📦';
    if (filename.endsWith('.md')) return '📝';
    return '📄';
  }

  // ==========================================
  // 4. Interaction Events (Click, Drag & Drop)
  // ==========================================

  private _updateSelectionUI() {
    const allNodes = this.container.querySelectorAll('.tree-content');
    allNodes.forEach((el) => {
      const p = (el as HTMLElement).dataset.path;
      if (p && this.selectedPaths.has(p)) {
        el.classList.add('bg-hover', 'border-primary');
      } else {
        el.classList.remove('bg-hover', 'border-primary');
      }
    });
  }

  private _handleClick(e: MouseEvent, path: string, kind: 'file' | 'directory') {
    e.stopPropagation();

    if (e.ctrlKey || e.metaKey) {
      if (this.selectedPaths.has(path)) {
        this.selectedPaths.delete(path);
      } else {
        this.selectedPaths.add(path);
      }
      this.lastClickedPath = path;
      this._updateSelectionUI();
      return;
    }

    if (e.shiftKey && this.lastClickedPath) {
      const allNodes = Array.from(this.container.querySelectorAll('.tree-content')) as HTMLElement[];
      const paths = allNodes.map((el) => el.dataset.path).filter(Boolean) as string[];

      const startIdx = paths.indexOf(this.lastClickedPath);
      const endIdx = paths.indexOf(path);

      if (startIdx !== -1 && endIdx !== -1) {
        const min = Math.min(startIdx, endIdx);
        const max = Math.max(startIdx, endIdx);

        this.selectedPaths.clear();
        for (let i = min; i <= max; i++) {
          this.selectedPaths.add(paths[i]);
        }
        this._updateSelectionUI();
        return;
      }
    }

    // Normal click
    this.selectedPaths.clear();
    this.selectedPaths.add(path);
    this.lastClickedPath = path;
    this._updateSelectionUI();

    if (kind === 'directory') {
      const li = (e.currentTarget as HTMLElement).parentElement;
      if (!li) return;

      const ul = li.querySelector('ul');
      const isExpanded = this.expandedPaths.has(path);

      if (isExpanded) {
        this.expandedPaths.delete(path);
      } else {
        this.expandedPaths.add(path);
      }

      if (ul) {
        ul.classList.toggle('hidden');
        const iconSpan = (e.currentTarget as HTMLElement).querySelector('span:first-child');
        if (iconSpan) {
          // 開閉のたびにアイコンを決め直すので、規則は _getIcon に一本化する。
          // 同期の印は名前の右（別の span）にあるため、ここで消える心配は無い。
          // アイコン欄は子要素を持たない約束なので textContent でよい。
          const target = e.currentTarget as HTMLElement;
          iconSpan.textContent = this._getIcon(path, kind, target.dataset.name || '', target.dataset.mount === '1');
        }
      }
    } else {
      if (this.events['open']) this.events['open'](path);
    }
  }

  private _handleDragStart(e: DragEvent, path: string) {
    e.stopPropagation();

    if (!this.selectedPaths.has(path)) {
      this.selectedPaths.clear();
      this.selectedPaths.add(path);
      this.lastClickedPath = path;
      this._updateSelectionUI();
    }

    const paths = Array.from(this.selectedPaths);

    // フォールバックと他アプリ向けに標準の dataTransfer もセットしておく
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/itera-file-batch', JSON.stringify({ paths }));
    }
    // モバイルSafari等の制約回避のため、グローバル変数に状態を退避
    (window as any).__iteraDragData = { paths };

    // ドラッグ中の見た目（選択要素すべて半透明にすると重いのでターゲットのみ）
    (e.target as HTMLElement).style.opacity = '0.5';
  }

  private _handleDragOver(e: DragEvent, element: HTMLElement) {
    if ((window as any).__iteraDragData) {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      element.classList.add('bg-primary', 'text-text-inverted');
    }
  }

  private _handleDragLeave(e: DragEvent, element: HTMLElement) {
    if ((window as any).__iteraDragData) {
      e.preventDefault();
      e.stopPropagation();
      element.classList.remove('bg-primary', 'text-text-inverted');
    }
  }

  private _handleDrop(e: DragEvent, targetFolderPath: string, element: HTMLElement) {
    element.classList.remove('bg-primary', 'text-text-inverted');

    const dragData = (window as any).__iteraDragData;
    if (dragData && dragData.paths) {
      e.preventDefault();
      e.stopPropagation();
      this._emitMove(dragData.paths, targetFolderPath);
      (window as any).__iteraDragData = null; // リセット
    }
  }

  private _initRootDropZone() {
    if (!this.container) return;

    this.container.addEventListener('dragover', (e) => {
      if ((window as any).__iteraDragData) {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        this.container.classList.add('bg-card', 'ring-2', 'ring-primary', 'ring-inset');
      }
    });

    this.container.addEventListener('dragleave', (e) => {
      if ((window as any).__iteraDragData) {
        e.preventDefault();
        e.stopPropagation();
        if (!this.container.contains(e.relatedTarget as Node)) {
          this.container.classList.remove('bg-card', 'ring-2', 'ring-primary', 'ring-inset');
        }
      }
    });

    this.container.addEventListener('drop', (e) => {
      const dragData = (window as any).__iteraDragData;
      if (dragData && dragData.paths) {
        e.preventDefault();
        e.stopPropagation();
        this.container.classList.remove('bg-card', 'ring-2', 'ring-primary', 'ring-inset');
        this._emitMove(dragData.paths, '');
        (window as any).__iteraDragData = null; // リセット
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
      this.container.classList.remove('bg-card', 'ring-2', 'ring-primary', 'ring-inset');

      // キャンセル時などに備えた確実な状態リセット
      (window as any).__iteraDragData = null;
    });
  }

  private _emitMove(srcPaths: string[], destFolder: string) {
    if (this.events['move']) {
      this.events['move'](srcPaths, destFolder);
    }
  }

  // ==========================================
  // 5. Context Menu
  // ==========================================

  private _initGlobalEvents() {
    document.addEventListener('click', (e) => {
      if (this.contextMenu && !this.contextMenu.contains(e.target as Node)) {
        this.contextMenu.classList.add('hidden');
      }
    });

    if (this.container) {
      this.container.addEventListener('contextmenu', (e) => {
        if (e.target === this.container || (e.target as HTMLElement).classList.contains('tree-root')) {
          e.preventDefault();
          this.selectedPaths.clear();
          this.selectedPaths.add('');
          this.lastClickedPath = '';
          this._updateSelectionUI();
          this._showContextMenu(e.pageX, e.pageY);
        }
      });

      this.container.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        // ツリーの項目以外がクリックされた場合は選択を解除する
        if (!target.closest('.tree-content')) {
          this.selectedPaths.clear();
          this.lastClickedPath = null;
          this._updateSelectionUI();
        }
      });
    }
  }

  private _handleContextMenu(e: MouseEvent, path: string) {
    e.preventDefault();
    e.stopPropagation();

    if (!this.selectedPaths.has(path)) {
      this.selectedPaths.clear();
      this.selectedPaths.add(path);
      this.lastClickedPath = path;
      this._updateSelectionUI();
    }

    this._showContextMenu(e.pageX, e.pageY);
  }

  private _showContextMenu(x: number, y: number) {
    if (this.events['context_menu_request']) {
      this.events['context_menu_request'](Array.from(this.selectedPaths), x, y);
    }
  }
}
