/**
 * src/shell/panels/TreeView.ts
 * Itera OS v2: Surgical DOM Update Tree View
 */

import type { TreeNode } from '../../core/vfs/types';
import {
  compareNodes,
  rootIconOf,
  DEFAULT_ROOT_ICONS,
  DEFAULT_SORT_WEIGHTS,
  type RootIcons,
  type SortWeights,
} from './nodeOrder';
import { t, i18n, escapeHtml } from '../../i18n/i18n';

export class TreeView {
  private container: HTMLElement;
  private contextMenu: HTMLElement | null;
  private events: Record<string, Function> = {};

  /** 一覧の並びの上書き（appearance.json の sortWeight）。設定が読めるまでは配信の既定。 */
  private sortWeights: SortWeights = DEFAULT_SORT_WEIGHTS;

  /** 最上位の記号の上書き（appearance.json の rootIcons）。同上。 */
  private rootIcons: RootIcons = DEFAULT_ROOT_ICONS;

  private expandedPaths: Set<string> = new Set();
  private selectedPaths: Set<string> = new Set();
  private lastClickedPath: string | null = null;

  /**
   * nodeId → 行の <li>。差分更新が行を引くための索引（T-0544）。
   *
   * 以前は `document.querySelector('div[data-path="…"]')` のように属性で引いていた。属性の照合は
   * DOM 全体の走査で、この木は閉じたフォルダの中身まで DOM に載せているので、写しが大きいほど 1 回が重い。
   * 実測（2026-09-26・Firefox 156・行 22,552）で 1 回 約 7ms。ホストで 1,000 件消すと
   * それだけで 6.9 秒、1,000 件作ると 7.1 秒、画面が止まっていた（Local Bridge の同期のたびに起きる）。
   * 索引で引けば件数に依らない。
   *
   * 引く範囲をこの木に限る役目もある。TreeView はエクスプローラとファイル選択の 2 つが同時に在りうるが、
   * `document` から引くと、相手の木の行を掴むことがあった。
   *
   * 正は DOM の側。索引は写しなので、引いたら「まだこの木の中に在るか」を確かめてから使う（_rowOf）。
   */
  private rows: Map<string, HTMLElement> = new Map();
  private rootUl: HTMLElement | null = null;

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
    this.rows.clear();

    const rootUl = document.createElement('ul');
    this.rootUl = rootUl;
    rootUl.id = 'vfs-tree-root';
    rootUl.className = 'tree-root text-sm font-mono text-text-main min-h-full pb-4';

    const fragment = document.createDocumentFragment();
    this._buildInitialTree(fragment, treeData, 0);

    rootUl.appendChild(fragment);
    this.container.appendChild(rootUl);
  }

  private _buildInitialTree(parentElement: DocumentFragment | HTMLElement, nodes: TreeNode[], indentLevel: number) {
    // 並びは «見た目» なので、木を組む側（PathResolver）ではなくここで決める。
    // 渡された配列は他の持ち主のものなので、写しを並べ替える。
    const ordered = [...nodes].sort((a, b) => compareNodes(a, b, this.sortWeights));

    for (const node of ordered) {
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

    // 全体を描き直すかは、差分を当てる前に決める（当ててから描き直すのは二度手間）。T-0544
    //   - ディレクトリの移動・改名 … 同じ id の DETACH と ATTACH が同じ束に来る（VfsTransaction）。
    //     配下の行はパスを抱えているので、部分木ごと作り直す必要がある
    //   - マウントの登録・解除 … ProviderManager が node=null のダミー MUTATE で知らせてくる。
    //     部分木まるごと印が変わる（_handleNodeMutated は node が無いと何もしない）
    // それ以外（ファイルの増減・変更、新しいディレクトリ、ディレクトリの削除）は差分で足りる。
    // 以前はディレクトリの ATTACH と DETACH のたびに VFS 全体の木を組んで描き直しており、
    // 1 回 0.5〜0.7 秒（行 22,552）かかっていた。
    const detachedIds = new Set<string>();
    for (const m of mutations) if (m.type === 'DETACH') detachedIds.add(m.nodeId);
    const needsFullRender = mutations.some(
      (m) =>
        (m.type === 'ATTACH' && m.node?.kind === 'directory' && detachedIds.has(m.nodeId)) ||
        (m.type === 'MUTATE' && Array.isArray(m.changedProperties) && m.changedProperties.includes('isMountPoint')),
    );

    for (const mutation of mutations) {
      if (mutation.type === 'DETACH') {
        if (!needsFullRender) {
          // ディレクトリでも行を外すだけでよい。配下の行は同じ <li> の中に在り、一緒に外れる。
          const li = this._rowOf(mutation.nodeId);
          if (li) {
            this._forgetSubtree(li);
            li.remove();
          }
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
      } else if (needsFullRender) {
        continue;
      } else if (mutation.type === 'ATTACH') {
        if (!mutation.node || mutation.node.flags?.isHidden || mutation.node.name === '.keep') continue;
        // 新しいディレクトリは空の行として足す（配下はまだ無い）。
        // 配下を同じ束で作る場合（コピーなど）も、親が先に put されるので親の行が先にできている。
        this._handleNodeAttached(mutation);
      } else if (mutation.type === 'MUTATE') {
        this._handleNodeMutated(mutation);
      }
    }

    if (needsFullRender) {
      this.render(getTreeFn());
    }
  }

  /** 索引から行を引く。この木から外れていたら（写しが古ければ）無いものとして扱い、索引からも落とす */
  private _rowOf(nodeId: string): HTMLElement | null {
    const li = this.rows.get(nodeId);
    if (!li) return null;
    if (!this.container.contains(li)) {
      this.rows.delete(nodeId);
      return null;
    }
    return li;
  }

  /** 外す行とその配下を索引から落とす（配下の走査はその部分木の中だけ） */
  private _forgetSubtree(li: HTMLElement) {
    const prefix = 'vfs-node-';
    this.rows.delete(li.id.slice(prefix.length));
    for (const el of Array.from(li.querySelectorAll('li.tree-node'))) {
      this.rows.delete(el.id.slice(prefix.length));
    }
  }

  private _handleNodeAttached(mutation: any) {
    if (this._rowOf(mutation.nodeId)) return;

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
      parentUl = this.rootUl && this.container.contains(this.rootUl) ? this.rootUl : null;
    } else {
      const parentLi = this._rowOf(mutation.node.parentId);
      if (parentLi) {
        parentUl = parentLi.querySelector(':scope > ul');
        const parentDiv = parentLi.firstElementChild as HTMLElement | null;
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

    this._insertSorted(parentUl, newLi);
  }

  private _handleNodeMutated(mutation: any) {
    if (!mutation.node) return;
    const li = this._rowOf(mutation.nodeId);
    const targetDiv = li ? (li.firstElementChild as HTMLElement | null) : null;

    if (targetDiv) {
      const sizeKB = (mutation.node.meta.size / 1024).toFixed(1) + ' KB';
      const updated = i18n.formatDate(mutation.node.meta.updatedAt);
      targetDiv.title = t('tree.tooltip', { size: sizeKB, updated });

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

  /**
   * 並びの上書きを差し替える。変わったときだけ true を返す
   * （呼び出し側が「描き直すか」を決められるように。判定はここが持つ ＝ T-0304 の形）。
   */
  /**
   * 最上位の記号の上書きを差し替える。変わったときだけ true を返す（setSortWeights と同じ形）。
   * 配信の既定に **重ねる** —— 1 つ足しただけで trash や system の印が消えないように。
   */
  setRootIcons(icons?: RootIcons | null): boolean {
    const next = icons && typeof icons === 'object' ? { ...DEFAULT_ROOT_ICONS, ...icons } : { ...DEFAULT_ROOT_ICONS };
    if (JSON.stringify(next) === JSON.stringify(this.rootIcons)) return false;
    this.rootIcons = next;
    return true;
  }

  setSortWeights(weights?: SortWeights | null): boolean {
    // 配信の既定に **重ねる**（置き換えない）。
    // 置き換えにすると、利用者が自分のフォルダを 1 つ前へ出すだけで
    // system / trash の後回しが消える —— 上書きした覚えのないものまで動く。
    // 既定を外したいときは、その名前に 0 を書く。
    const next =
      weights && typeof weights === 'object' ? { ...DEFAULT_SORT_WEIGHTS, ...weights } : { ...DEFAULT_SORT_WEIGHTS };
    if (JSON.stringify(next) === JSON.stringify(this.sortWeights)) return false;
    this.sortWeights = next;
    return true;
  }

  /**
   * 並びを保ったまま 1 行を差し込む（兄弟は既に並んでいる）。
   * 以前は差し込むたびに兄弟を全部並べ替えて付け直していたので、100 件のフォルダへ 100 件足すと
   * 1 万回の付け直しになった。二分探索で位置を決め、動かすのはこの 1 行だけにする（T-0544）。
   */
  private _insertSorted(ul: HTMLElement, li: HTMLElement) {
    const key = { name: li.dataset.name || '', kind: li.dataset.kind || 'file' };
    const siblings = ul.children;
    let lo = 0;
    let hi = siblings.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const sib = siblings[mid] as HTMLElement;
      const cmp = compareNodes(
        key,
        { name: sib.dataset.name || '', kind: sib.dataset.kind || 'file' },
        this.sortWeights,
      );
      if (cmp < 0) hi = mid;
      else lo = mid + 1;
    }
    ul.insertBefore(li, siblings[lo] || null);
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
    this.rows.set(id, li);
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
    const updated = meta ? i18n.formatDate(meta.updatedAt || meta.updated_at) : '';
    div.title = t('tree.tooltip', { size: sizeKB, updated });

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
    // 最上位の特例は表（appearance.rootIcons）で持つ。ここに名前を書き足さない
    // —— 領域の名前が変わるたびにコードを直すことになる（並びの重みと同じ理由）。
    const rootIcon = rootIconOf(path, this.rootIcons);
    if (rootIcon) return rootIcon;
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
    const title = escapeHtml(isStub ? t('tree.syncedStub') : t('tree.synced'));
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

  /**
   * 指定パスをツリーの上で見える状態にし、選択して画面内に入れる。
   *
   * 祖先を expandedPaths に足して開き、対象がディレクトリならそれも開く。
   * 木は全ノードが DOM に載っている（閉じたフォルダは hidden なだけ）ので描き直しはしない。
   * 'open' / 'select' は発火しない —— 利用者の操作ではなく外（API・道具）からの指示なので、
   * ここからアプリを起動したり選択の通知を出したりはしない。
   *
   * @returns 対象が木に無ければ false（何も変えない）
   */
  reveal(path: string): boolean {
    const target = this.container.querySelector(`div[data-path="${path}"]`) as HTMLElement | null;
    if (!target) return false;

    const segments = path.split('/');
    const toOpen: string[] = [];
    for (let i = 1; i < segments.length; i++) toOpen.push(segments.slice(0, i).join('/'));
    if (target.dataset.kind === 'directory') toOpen.push(path);

    for (const p of toOpen) {
      const div = this.container.querySelector(`div[data-path="${p}"]`) as HTMLElement | null;
      if (!div) continue;
      this.expandedPaths.add(p);
      const ul = div.parentElement?.querySelector('ul');
      if (ul) {
        ul.classList.remove('hidden');
        ul.classList.add('block');
      }
      const iconSpan = div.querySelector('span:first-child');
      if (iconSpan) {
        iconSpan.textContent = this._getIcon(p, 'directory', div.dataset.name || '', div.dataset.mount === '1');
      }
    }

    this.selectedPaths.clear();
    this.selectedPaths.add(path);
    this.lastClickedPath = path;
    this._updateSelectionUI();

    if (typeof (target as any).scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'center' });
    }
    return true;
  }

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

    // ★ 'select' は種類を問わず発火する。
    //   ディレクトリのクリックは開閉するだけで 'open' を出さないため、
    //   「どれが選ばれたか」を知りたい側（ファイル選択ダイアログ）が受け取る術が無かった。
    //   'open' の意味は変えない（Explorer はディレクトリを開こうとしてはいけない）。
    if (this.events['select']) this.events['select'](path, kind);

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
