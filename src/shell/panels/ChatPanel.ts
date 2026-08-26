/**
 * src/shell/panels/ChatPanel.ts
 * Itera OS v2: Chat Interface Controller
 */

import type { VfsService } from '../../core/vfs/VfsService';
import type { Turn } from '../../core/state/HistoryManager';
import type { Principal } from '../../core/vfs/types';
import { USER_PRINCIPAL } from '../../core/vfs/types';
import type { LpmlRenderer } from '../services/LpmlRenderer';
import { renderMarkdownTables } from '../../utils/markdownTable';
import { renderMarkdownLite } from '../../utils/markdownLite';
import hljs from 'highlight.js/lib/common';
import { LABEL_STREAM } from '../styles/typography';

/**
 * ターンの見た目は「会話レイヤ」と「機構レイヤ」の2種類しかない。
 *
 *   会話レイヤ … ユーザー入力 と 成果物（Iteraの発話）。同じ幅・同じ面の高さで左右の対になる。
 *   機構レイヤ … LLM生出力 と システムログ。同一の見た目で、左右32px内側に落として沈める。
 *
 * 【注意】bg-card は使わない。ライトでは地色より暗く、ダークでは明るいため、
 * テーマによって「手前／奥」が反転する（light 243<249 / dark 55,65,81>31,41,55）。
 * 「手前」は bg-panel（両テーマで地色より明るい）、「沈み」は bg-overlay のαで作る。
 */
/**
 * 「下端に貼り付いている」とみなす許容幅（px）。
 *
 * これより上にいるなら、利用者は**過去を読んでいる**とみなして自動スクロールを止める。
 * 小さくしすぎると 1px の端数で追従が外れ、大きくしすぎると
 * 「少し遡って読んでいる」状態を拾えずに引き戻してしまう。
 */
const STICK_THRESHOLD_PX = 100;

const BOX_BASE = 'relative group mb-2 transition';
const BOX_FRAME = 'p-3 rounded-lg border';

/**
 * 寸法は chat-body / chat-system-message（style.css）から取る。
 * どちらも CSS 変数を読むだけのクラスで、値は外観設定から ThemeService 経由で入る。
 * ここに text-sm のような固定の寸法クラスを書き戻さないこと。設定が効かなくなる。
 *
 * この枠の「中」に置くものは em で書く（本文に対する比）。
 * 本文の寸法が利用者の設定で動くため、rem で書くと本文だけが伸縮して
 * 見出しやコードとの上下関係が壊れる。
 */
const CLS_USER = `${BOX_FRAME} chat-body bg-panel text-text-main border-border-main border-r-[3px] border-r-primary/60 ml-4 shadow-sm`;
const CLS_MECH = `${BOX_FRAME} chat-system-message bg-overlay/5 text-text-muted border-border-main/60 mx-8`;
const CLS_ARTIFACT = `${BOX_FRAME} chat-body bg-panel text-text-main border-border-main border-l-[3px] border-l-speech/60 mr-4 shadow-sm`;

/** 待機表示の文言。'thinking' = モデル出力中 / 'processing' = ツール実行中 */
export type ProcessingMode = 'thinking' | 'processing';

const DOM_IDS = {
  HISTORY: 'chat-history',
  INPUT: 'chat-input',
  BTN_SEND: 'btn-send',
  BTN_STOP: 'btn-stop',
  BTN_CLEAR: 'btn-clear-chat',
  PREVIEW_AREA: 'file-preview-area',
  FILE_UPLOAD: 'chat-file-upload',
  AI_TYPING: 'ai-typing',
  AI_TYPING_LABEL: 'ai-typing-label',
  RESIZER: 'chat-resizer',
  PANEL: 'chat-panel',
  RESIZE_OVERLAY: 'resize-overlay',
  APPS_CONTAINER: 'apps-container',
};

export class ChatPanel {
  private renderer: LpmlRenderer | null;
  private vfs: VfsService | null = null;
  private getActivePrincipal: () => Principal = () => USER_PRINCIPAL;
  private els: Record<string, HTMLElement | HTMLInputElement | HTMLTextAreaElement | null> = {};
  private events: Record<string, Function> = {};

  private pendingUploads: File[] = [];
  private pendingReferences: string[] = [];

  public currentStreamEl: HTMLElement | null = null;
  private currentStreamContent: string = '';

  constructor(renderer: LpmlRenderer | null = null) {
    this.renderer = renderer;
    this._initElements();
    this._bindEvents();
    this._initResizer();
  }

  setVfs(vfs: VfsService) {
    this.vfs = vfs;
  }

  setPrincipalProvider(provider: () => Principal) {
    this.getActivePrincipal = provider;
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
    // silent: 履歴に user ターンを置くだけで LLM を起こさない（Ctrl+Shift+Enter。ボタンは無い）
    const handleSend = (opts: { silent?: boolean } = {}) => {
      const inputEl = this.els.INPUT as HTMLTextAreaElement;
      let text = inputEl ? inputEl.value.trim() : '';
      if (!text && this.pendingUploads.length === 0 && this.pendingReferences.length === 0) return;

      if (this.events['send']) {
        this.events['send'](text, [...this.pendingUploads], [...this.pendingReferences], opts);
      }
      if (inputEl) inputEl.value = '';
      this._clearUploads();
    };

    if (this.els.BTN_SEND) {
      // Shift を押しながら送信ボタン → 置くだけ（Ctrl+Shift+Enter と同じ）
      this.els.BTN_SEND.onclick = (e: MouseEvent) => handleSend({ silent: e.shiftKey });
    }

    if (this.els.INPUT) {
      const inputEl = this.els.INPUT as HTMLTextAreaElement;
      inputEl.onkeydown = (e) => {
        if (e.ctrlKey && e.key === 'Enter') {
          e.preventDefault();
          handleSend({ silent: e.shiftKey });
        }
      };
      inputEl.addEventListener('paste', (e: ClipboardEvent) => this._handlePaste(e));

      const dropZone = inputEl.parentElement;
      if (dropZone) {
        dropZone.addEventListener('dragover', (e) => {
          e.preventDefault();
          dropZone.classList.add('ring-2', 'ring-primary');
        });
        dropZone.addEventListener('dragleave', (e) => {
          e.preventDefault();
          dropZone.classList.remove('ring-2', 'ring-primary');
        });
        dropZone.addEventListener('drop', (e: DragEvent) => {
          e.preventDefault();
          dropZone.classList.remove('ring-2', 'ring-primary');
          if (e.dataTransfer && e.dataTransfer.files.length > 0) {
            this._addUploads(e.dataTransfer.files);
          }
        });
      }
    }

    if (this.els.BTN_STOP) {
      this.els.BTN_STOP.onclick = () => {
        if (this.events['stop']) this.events['stop']();
      };
    }

    if (this.els.BTN_CLEAR) {
      this.els.BTN_CLEAR.onclick = () => {
        if (this.events['clear']) this.events['clear']();
      };
    }

    if (this.els.FILE_UPLOAD) {
      const uploadEl = this.els.FILE_UPLOAD as HTMLInputElement;
      uploadEl.onchange = (e: Event) => {
        const target = e.target as HTMLInputElement;
        if (target.files) this._addUploads(target.files);
        target.value = '';
      };
    }
  }

  private _initResizer() {
    const resizer = this.els.RESIZER;
    const panel = this.els.PANEL;
    const overlay = this.els.RESIZE_OVERLAY;
    const iframeContainer = this.els.APPS_CONTAINER;

    if (!resizer || !panel) return;

    let isResizing = false;

    const start = (e: MouseEvent) => {
      isResizing = true;
      document.body.style.cursor = 'col-resize';
      resizer.classList.add('resizing');
      if (overlay) overlay.classList.remove('hidden');
      if (iframeContainer) iframeContainer.style.pointerEvents = 'none';
      e.preventDefault();
    };

    const stop = () => {
      if (!isResizing) return;
      isResizing = false;
      document.body.style.cursor = '';
      resizer.classList.remove('resizing');
      if (overlay) overlay.classList.add('hidden');
      if (iframeContainer) iframeContainer.style.pointerEvents = '';
    };

    const move = (e: MouseEvent) => {
      if (!isResizing) return;
      const w = document.body.clientWidth - e.clientX;
      if (w > 300 && w < 800) {
        panel.style.width = `${w}px`;
      }
      e.preventDefault();
    };

    resizer.addEventListener('mousedown', start as EventListener);
    document.addEventListener('mousemove', move as EventListener);
    document.addEventListener('mouseup', stop);
    window.addEventListener('blur', stop);
  }

  private _handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        const file = items[i].getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) this._addUploads(files);
  }

  addVfsReference(path: string) {
    if (!this.pendingReferences.includes(path)) {
      this.pendingReferences.push(path);
      this._renderUploadPreviews();
    }
  }

  private _addUploads(files: FileList | File[]) {
    Array.from(files).forEach((f) => this.pendingUploads.push(f));
    this._renderUploadPreviews();
  }

  private _clearUploads() {
    this.pendingUploads = [];
    this.pendingReferences = [];
    this._renderUploadPreviews();
  }

  private _renderUploadPreviews() {
    const area = this.els.PREVIEW_AREA;
    if (!area) return;
    area.innerHTML = '';

    if (this.pendingUploads.length === 0 && this.pendingReferences.length === 0) {
      area.classList.add('hidden');
      return;
    }

    area.classList.remove('hidden');

    this.pendingUploads.forEach((file, index) => {
      const div = document.createElement('div');
      div.className =
        'bg-card border border-border-main rounded pl-2 pr-1 py-1 text-xs flex items-center gap-2 text-text-muted select-none';
      div.innerHTML = `<span class="truncate max-w-[150px]" title="${file.name}">📎 ${file.name}</span><button class="text-text-muted hover:text-error w-5 h-5 flex items-center justify-center">×</button>`;
      div.querySelector('button')!.onclick = () => {
        this.pendingUploads.splice(index, 1);
        this._renderUploadPreviews();
      };
      area.appendChild(div);
    });

    this.pendingReferences.forEach((path, index) => {
      const div = document.createElement('div');
      div.className =
        'bg-primary/10 border border-primary/30 rounded pl-2 pr-1 py-1 text-xs flex items-center gap-2 text-primary select-none';
      const name = path.split('/').pop() || path;
      div.innerHTML = `<span class="truncate max-w-[150px]" title="${path}">📄 ${name}</span><button class="text-primary/70 hover:text-error w-5 h-5 flex items-center justify-center">×</button>`;
      div.querySelector('button')!.onclick = () => {
        this.pendingReferences.splice(index, 1);
        this._renderUploadPreviews();
      };
      area.appendChild(div);
    });
  }

  setProcessing(processing: boolean, mode: ProcessingMode = 'thinking') {
    if (this.els.BTN_STOP) {
      this.els.BTN_STOP.classList.toggle('hidden', !processing);
    }
    if (this.els.AI_TYPING) {
      // 【注意】ここで innerHTML を上書きしないこと。
      // index.html 側に「● Thinking...」のマークアップが定義されており、
      // 以前はこの上書きによってそれが毎回「Processing...」に置き換えられ、
      // 静的マークアップが事実上死んでいた。表示/非表示の切り替えだけを行う。
      this.els.AI_TYPING.classList.toggle('hidden', !processing);
    }
    // 文言だけを差し替える。
    // ★ 札を専用の要素（#ai-typing-label）に分けてあるので、上書きしても
    //   点滅する ● のマークアップは壊れない。これが無かったため、
    //   「innerHTML を触らない」＝「常に Thinking... のまま」になっていた（T-0028）。
    if (processing && this.els.AI_TYPING_LABEL) {
      this.els.AI_TYPING_LABEL.textContent = mode === 'processing' ? 'Processing...' : 'Thinking...';
    }
  }

  // ==========================================
  // Streaming
  // ==========================================

  startStreaming(turnId?: string) {
    if (this.currentStreamEl && this.currentStreamEl.parentElement) {
      const parent = this.currentStreamEl.parentElement;
      if (!parent.id || !parent.id.startsWith('turn-')) {
        parent.remove();
      }
    }
    this.currentStreamContent = '';
    this.currentStreamEl = null;

    // 生成の開始も「新しい出力」なので、過去を読んでいる間は引き戻さない。
    const wasAtBottom = this._isAtBottom();
    this._createStreamElement(turnId);
    this._scrollToBottom(false, wasAtBottom);
  }

  private _createStreamElement(turnId?: string) {
    if (!this.els.HISTORY) return;
    const div = document.createElement('div');
    if (turnId) {
      div.id = `turn-${turnId}`;
    }
    // 確定後の描画(_appendTurn)と同じクラスを使う。
    // 以前はここだけクラス文字列を複製していたため、生成中と確定後で見た目がずれていた。
    div.className = `${BOX_BASE} ${CLS_MECH}`;
    div.innerHTML = `
      <div class="flex justify-between items-center mb-1 opacity-50 ${LABEL_STREAM}">MODEL (Generating...)</div>
      <div class="msg-content whitespace-pre-wrap break-all"></div>
    `;
    this.els.HISTORY.appendChild(div);
    this.currentStreamEl = div.querySelector('.msg-content') as HTMLElement;

    if (this.currentStreamContent) {
      if (!this._renderLpmlInto(this.currentStreamEl, this.currentStreamContent, { streaming: true })) {
        this.currentStreamEl.textContent = this.currentStreamContent;
      }
    }
  }

  /**
   * LPML のタグ箱を描く唯一の入口。
   *
   * タグ箱は寸法も書体も持たず、祖先から継承する（LpmlRenderer 側の設計）。
   * つまり見た目は「どのレイヤの中に描かれたか」で決まる。
   * MODEL と SYSTEM は機構レイヤ（CLS_MECH）の中なので問題にならないが、
   * 添付のあるユーザーターンは会話レイヤ（CLS_USER ＝ chat-body）の中に
   * タグ箱が出るため、MODEL 枠より大きな sans で描かれていた。
   *
   * 呼び出し側ごとにクラスを足して回ると、描画経路が増えたときに同じ事故が再発する。
   * ここを通す限り、タグ箱は必ず機構レイヤの寸法・書体になる。
   *
   * @returns レンダラが無く描けなかったときだけ false（呼び出し側で素のテキストに落とす）
   */
  private _renderLpmlInto(el: HTMLElement, text: string, opts: { streaming?: boolean } = {}): boolean {
    if (!this.renderer || !this.renderer.formatStream) return false;
    el.classList.add('chat-system-message');
    el.classList.remove('whitespace-pre-wrap');
    el.innerHTML = this.renderer.formatStream(text, opts);
    return true;
  }

  updateStreaming(chunk: string) {
    if (!this.currentStreamEl) return;
    // 書き込む前に測る。書いたあとでは、伸びた分がそのまま「下端からの距離」になる。
    const wasAtBottom = this._isAtBottom();
    this.currentStreamContent += chunk;

    // streaming:true … 生成中はまだ成果物枠が存在しないため、report/ask を開いたまま見せる。
    // 確定後は成果物枠が出るので _appendTurn 側では畳む。
    if (!this._renderLpmlInto(this.currentStreamEl, this.currentStreamContent, { streaming: true })) {
      this.currentStreamEl.textContent = this.currentStreamContent;
    }
    this._scrollToBottom(false, wasAtBottom);
  }

  finalizeStreaming() {
    const wasAtBottom = this._isAtBottom();
    if (this.currentStreamEl && this.currentStreamEl.parentElement) {
      const parent = this.currentStreamEl.parentElement;
      if (!parent.id || !parent.id.startsWith('turn-')) {
        parent.remove();
      }
    }
    this.currentStreamEl = null;
    this.currentStreamContent = '';
    this._scrollToBottom(false, wasAtBottom);
  }

  // ==========================================
  // History Rendering
  // ==========================================

  /**
   * ターンを 1 つ足す。
   *
   * **自分が書いたものは必ず見せる**（`role === 'user'`）—— 送信は利用者の操作であり、
   * その結果が画面の外にあるのは驚きになる。過去を読んでいる最中に送ったとしても、
   * 送った本人は最新へ戻る意思を示している。
   *
   * それ以外（AI・システムの出力）は**足す前の位置に従う**。
   * 下端にいれば追従し、遡って読んでいる間は動かさない。
   */
  appendTurn(turn: Turn) {
    if (!turn) return;
    const wasAtBottom = this._isAtBottom();
    const isOwnMessage = turn.role === 'user';
    this._appendTurn(turn);
    this._scrollToBottom(isOwnMessage, wasAtBottom);
  }

  /**
   * 履歴を作り直す（起動時・ターン削除・セッション消去の 3 か所からしか呼ばれない）。
   * どれも画面を組み直す操作で、`innerHTML` を空にした時点で位置は失われるため、
   * ここだけは最下部へ送ってよい。
   */
  renderHistory(history: Turn[]) {
    if (!this.els.HISTORY) return;
    this.els.HISTORY.innerHTML = '';
    history.forEach((turn) => this._appendTurn(turn));
    this._scrollToBottom(true);
  }

  /**
   * いま下端に貼り付いているか。
   *
   * ★ 必ず DOM を足す**前**に呼ぶこと。
   *   足したあとに測ると、追加された高さがそのまま「下端からの距離」になるため、
   *   貼り付いていたのに「過去を読んでいる」と判定され、**追従が黙って止まる**。
   *   長いチャンク（コード塊など）で追従が途切れて見えるのは、これが理由である。
   */
  private _isAtBottom(): boolean {
    const el = this.els.HISTORY;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop <= el.clientHeight + STICK_THRESHOLD_PX;
  }

  /**
   * 最下部へ送る。
   *
   * @param force        利用者自身の操作の結果なら true（自分が送ったものは必ず見せる）
   * @param wasAtBottom  **足す前に**測った位置。false なら過去を読んでいるので動かさない
   */
  private _scrollToBottom(force = false, wasAtBottom = true) {
    const el = this.els.HISTORY;
    if (!el) return;
    if (force || wasAtBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }

  /**
   * 描かないイベントの種類（preferences.hiddenEventTypes。`meta.eventType` と照合）。
   * 描かないだけで履歴には残る（AI には届く）。切り替えは renderHistory で反映する。
   */
  private hiddenEventTypes: Set<string> = new Set();
  setHiddenEventTypes(types: string[] | undefined | null): void {
    this.hiddenEventTypes = new Set(Array.isArray(types) ? types.map(String) : []);
  }

  private _appendTurn(turn: Turn) {
    if (turn.meta && turn.meta.visible === false) return;
    if (turn.meta && turn.meta.eventType && this.hiddenEventTypes.has(String(turn.meta.eventType))) return;

    let div = document.getElementById(`turn-${turn.id}`);
    let isUpdate = !!div;

    if (!div) {
      div = document.createElement('div');
      div.id = `turn-${turn.id}`;
    } else {
      div.innerHTML = '';
    }

    const role = turn.role;
    const isSystem = role === 'system';

    // system ターンは「記録の箱」と「成果物の枠」を兄弟として並べる必要があるため、
    // ターン自体は装飾を持たない透明なコンテナにする。
    // （成果物を記録の箱の中に入れると mx-8 の内側に落ちてしまい、会話レイヤの幅にならない）
    div.className = isSystem ? BOX_BASE : `${BOX_BASE} ${role === 'user' ? CLS_USER : CLS_MECH}`;

    // 記録（ツール実行ログ）を入れる箱。system のときだけ独立した要素になる。
    const logBox = document.createElement('div');
    if (isSystem) {
      logBox.className = `relative group ${CLS_MECH}`;
      div.appendChild(logBox);
    }
    const host = isSystem ? logBox : div;

    const header = document.createElement('div');
    header.className = `flex justify-between items-center mb-1 opacity-50 ${LABEL_STREAM}`;
    header.textContent = role;
    host.appendChild(header);

    host.appendChild(this._createDeleteButton(turn.id));

    const body = document.createElement('div');
    body.className = 'break-words';

    if (typeof turn.content === 'string') {
      if (role === 'model' || (isSystem && turn.content.includes('<'))) {
        if (!this._renderLpmlInto(body, turn.content)) body.textContent = turn.content;
      } else {
        body.className += ' whitespace-pre-wrap';
        body.innerHTML = this._formatSystemMessage(turn.content);
      }
    } else if (Array.isArray(turn.content)) {
      // 第4引数は成果物枠の置き場。記録の箱ではなくターン直下（＝兄弟）に置く。
      this._renderArrayContent(body, turn.content, role, div, turn.id);
    }

    host.appendChild(body);

    if (!isUpdate) {
      this.els.HISTORY!.appendChild(div);
    }

    // 外部ライブラリの適用（MathJaxはCDN、Highlight.jsはバンドル済み）
    // 成果物枠は body の外（div直下）にあるため、div 全体を対象にする。
    if ((window as any).MathJax) {
      (window as any).MathJax.typesetPromise([div]).catch((e: any) => console.warn('MathJax Error:', e));
    }
    div.querySelectorAll('pre code').forEach((block) => {
      hljs.highlightElement(block as HTMLElement);
    });
  }

  private _renderArrayContent(
    container: HTMLElement,
    contentArray: any[],
    role: string,
    artifactContainer?: HTMLElement,
    turnId?: string,
  ) {
    contentArray.forEach((item) => {
      if (item.text) {
        const div = document.createElement('div');
        // 添付があるとユーザーターンの content が配列になり、この経路を通る。
        // その場合タグ箱は会話レイヤ（chat-body）の中に出るため、
        // _renderLpmlInto が機構レイヤを名乗らせて MODEL 枠と同じ寸法に揃える。
        const isLpml = role === 'model' || item.text.trim().startsWith('<');
        if (!isLpml || !this._renderLpmlInto(div, item.text)) {
          div.className = 'whitespace-pre-wrap';
          div.innerHTML = this._formatSystemMessage(item.text);
        }
        container.appendChild(div);
      } else if (item.output) {
        // `ui` は全ツール共通で「絵文字＋短い動詞句」の実行ステータス。常に1行として描く。
        // 以前は report/ask だけ本文が入っていたため text-system font-bold で特別扱いしていたが、
        // 本文は artifact へ移したのでその分岐は不要になった。
        const div = document.createElement('div');
        div.className = 'mb-0.5 whitespace-pre-wrap';
        div.innerHTML = this._formatSystemMessage(item.output.ui || item.output.log || '');
        container.appendChild(div);

        if (item.output.media) {
          this._renderMediaFromVfs(container, item.output.media);
        } else if (item.output.image) {
          this._appendMedia(container, item.output.image, item.output.mimeType);
        }

        // 成果物は記録の箱の外（ターン直下）へ置く。
        // actionType（report / ask）はヘッダーの由来表示に使う。
        if (item.output.artifact && artifactContainer) {
          this._renderArtifact(artifactContainer, item.output.artifact, turnId, item.actionType);
        }
      } else if (item.media) {
        this._renderMediaFromVfs(container, item.media);
      } else if (item.inlineData) {
        this._appendMedia(container, item.inlineData.data, item.inlineData.mimeType);
      }
    });
  }

  /**
   * ターン削除ボタン。記録の箱と成果物枠の両方から使う。
   *
   * 【重要】どちらから押しても消えるのは「ターン＝ひとつの出来事」である。
   * 成果物だけをDOMから消す実装にはしない。履歴に残ったまま画面から消えると、
   * 再描画（renderHistory）で復活して嘘になるため。
   */
  private _createDeleteButton(turnId: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className =
      'absolute top-2 right-2 text-text-muted hover:text-error opacity-100 md:opacity-0 group-hover:opacity-100 p-1 transition';
    btn.innerHTML = '×';
    btn.onclick = async (e) => {
      e.stopPropagation();
      const res = await window.AppUI?.showMessageBox({
        title: 'Delete Message',
        message: 'Are you sure you want to delete this message from the history?',
        type: 'warning',
        buttons: [
          { label: 'Cancel', value: false, style: 'normal', isCancel: true },
          { label: 'Delete', value: true, style: 'danger', isDefault: true },
        ],
      });
      if (res && res.action && this.events['delete_turn']) {
        this.events['delete_turn'](turnId);
      }
    };
    return btn;
  }

  /**
   * 成果物枠（Iteraの発話）を描く。
   *
   * これは「ツールがChatPanelに残した成果物」であって、ツール実行結果の表示ではない。
   * create_file がVFSにファイルを残すのと同じ関係にある。
   * したがってログの箱の中ではなく、会話レイヤの幅（ユーザー入力と対になる幅）で描く。
   *
   * 整形はシステム側の特権として行う（LLMの生出力は原稿のまま等幅で残る）。
   * renderMarkdownLite はブロック要素を返すので、whitespace-pre-wrap を付けてはならない。
   */
  private _renderArtifact(
    container: HTMLElement,
    artifact: { kind?: string; text?: string },
    turnId?: string,
    source?: string,
  ) {
    const text = artifact?.text || '';
    if (!text.trim()) return;

    const div = document.createElement('div');
    div.className = `relative group ${CLS_ARTIFACT} mt-2 break-words`;

    // 他の3種（USER / MODEL / SYSTEM）と同じ位置・同じ大きさで主体を書く。
    // ここだけヘッダーが無いと、4つのうち1つだけ構造が欠けて見えるため。
    //
    // 主体に加えて由来（report / ask）も書く。両者は枠が同一で、違いは
    // 「ループが止まるかどうか」だけであり、それは画面に出ないため、
    // ラベルが無いと返事を待たれているのかどうかが利用者に分からない。
    // uppercase が効くので、表示は "ITERA: REPORT" になる。
    //
    // TODO: preferences.agentName に追従させる（現状は固定表記）。
    const header = document.createElement('div');
    header.className = `flex justify-between items-center mb-1 opacity-50 ${LABEL_STREAM}`;
    header.textContent = source ? `Itera: ${source}` : 'Itera';
    div.appendChild(header);

    if (turnId) {
      div.appendChild(this._createDeleteButton(turnId));
    }

    const body = document.createElement('div');
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    body.innerHTML = renderMarkdownLite(escaped);
    div.appendChild(body);

    container.appendChild(div);
  }

  /**
   * V2: OPFSの恩恵を受け、Blobを非同期に取得してObject URLで表示する
   */
  private async _renderMediaFromVfs(container: HTMLElement, mediaObj: any) {
    if (!this.vfs) {
      const div = document.createElement('div');
      div.className = 'text-xs text-text-muted italic border border-border-main p-2 rounded mt-2';
      div.textContent = `[Loading media: ${mediaObj.path}]`;
      container.appendChild(div);
      return;
    }

    // 読み込み中のプレースホルダー
    const loadingDiv = document.createElement('div');
    loadingDiv.className = 'text-xs text-text-muted italic p-2 mt-2';
    loadingDiv.textContent = 'Loading image...';
    container.appendChild(loadingDiv);

    try {
      if (this.vfs.exists(this.getActivePrincipal(), mediaObj.path)) {
        const blob = await this.vfs.readBlob(this.getActivePrincipal(), mediaObj.path);
        const url = URL.createObjectURL(blob);
        loadingDiv.remove();
        this._appendMedia(container, url, mediaObj.mimeType || blob.type, mediaObj.path);
      } else {
        loadingDiv.remove();
        const div = document.createElement('div');
        div.className =
          'flex items-center gap-2 text-xs text-text-muted bg-error/10 border border-error/20 p-2 rounded mt-2';
        div.innerHTML = `<span class="text-error">⚠️</span> <span class="line-through opacity-70">${mediaObj.path}</span> <span class="text-[0.625rem] ml-auto">(File not found)</span>`;
        container.appendChild(div);
      }
    } catch (e: any) {
      loadingDiv.remove();
      console.error('Failed to render media from VFS:', e);
      const div = document.createElement('div');
      div.className = 'text-xs text-error p-2';
      div.textContent = `Error loading image: ${e.message}`;
      container.appendChild(div);
    }
  }

  private _formatSystemMessage(text: string): string {
    if (!text) return '';

    let safeText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // フェンス付きコードブロックは、テーブル検出（"|"を含む行の走査）が誤爆しないよう
    // 一時的にプレースホルダーへ退避してから復元する（Translator._parseToTreeの
    // __PROTECTED_...__ パターンと同じ考え方）。
    const codeBlocks: string[] = [];
    safeText = safeText.replace(/```(?:([a-zA-Z0-9_]+)\n)?([\s\S]*?)```/g, (_match, lang, code) => {
      const langClass = lang ? `language-${lang}` : 'language-plaintext';
      const html = `<pre class="bg-card border border-border-main p-2 rounded mt-1 mb-1 overflow-x-auto text-text-main font-mono text-[0.833em] leading-relaxed font-normal"><code class="${langClass}">${code}</code></pre>`;
      const placeholder = `__CODEBLOCK_${codeBlocks.length}__`;
      codeBlocks.push(html);
      return placeholder;
    });

    safeText = renderMarkdownTables(safeText);

    safeText = safeText.replace(/`([^`]+)`/g, (_match, code) => {
      return `<code class="bg-app text-primary px-1 rounded font-mono font-normal">${code}</code>`;
    });

    codeBlocks.forEach((html, idx) => {
      safeText = safeText.replace(`__CODEBLOCK_${idx}__`, html);
    });

    return safeText;
  }

  private _appendMedia(container: HTMLElement, src: string, mimeType?: string, path?: string) {
    let mime = mimeType || 'image/png';
    if (!mimeType && src.startsWith('data:')) {
      mime = src.split(';')[0].split(':')[1];
    }

    if (mime.startsWith('image/')) {
      const img = document.createElement('img');
      img.src = src;
      img.className =
        'h-24 rounded border border-border-main cursor-pointer hover:opacity-80 bg-app mt-2 object-contain';
      img.onclick = () => {
        if (this.events['preview_request']) this.events['preview_request']('Image Preview', src, mime, path);
      };
      container.appendChild(img);
    } else {
      const div = document.createElement('div');
      div.className =
        'flex items-center gap-3 p-3 mt-2 rounded border border-border-main bg-card max-w-xs hover:bg-hover transition select-none cursor-pointer';
      div.innerHTML = `<div class="text-2xl">📄</div><div class="flex flex-col overflow-hidden"><span class="text-xs text-text-main font-bold font-mono uppercase truncate">${mime}</span><span class="text-[0.625rem] text-text-muted truncate">BINARY DATA</span></div>`;
      div.onclick = () => {
        if (this.events['preview_request']) {
          this.events['preview_request']('Attachment', src, mime, path);
        }
      };
      container.appendChild(div);
    }
  }
}
