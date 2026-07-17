/**
 * src/shell/panels/ChatPanel.ts
 * Itera OS v2: Chat Interface Controller
 */

import type { VfsService } from '../../core/vfs/VfsService';
import type { Turn } from '../../core/state/HistoryManager';
import type { Principal } from '../../core/vfs/types';
import { USER_PRINCIPAL } from '../../core/vfs/types';
import type { LpmlRenderer } from '../services/LpmlRenderer';

const DOM_IDS = {
  HISTORY: 'chat-history',
  INPUT: 'chat-input',
  BTN_SEND: 'btn-send',
  BTN_STOP: 'btn-stop',
  BTN_CLEAR: 'btn-clear-chat',
  PREVIEW_AREA: 'file-preview-area',
  FILE_UPLOAD: 'chat-file-upload',
  AI_TYPING: 'ai-typing',
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
    const handleSend = () => {
      const inputEl = this.els.INPUT as HTMLTextAreaElement;
      let text = inputEl ? inputEl.value.trim() : '';
      if (!text && this.pendingUploads.length === 0 && this.pendingReferences.length === 0) return;

      if (this.events['send']) {
        this.events['send'](text, [...this.pendingUploads], [...this.pendingReferences]);
      }
      if (inputEl) inputEl.value = '';
      this._clearUploads();
    };

    if (this.els.BTN_SEND) {
      this.els.BTN_SEND.onclick = handleSend;
    }

    if (this.els.INPUT) {
      const inputEl = this.els.INPUT as HTMLTextAreaElement;
      inputEl.onkeydown = (e) => {
        if (e.ctrlKey && e.key === 'Enter') handleSend();
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

  setProcessing(processing: boolean) {
    if (this.els.BTN_STOP) {
      this.els.BTN_STOP.classList.toggle('hidden', !processing);
    }
    if (this.els.AI_TYPING) {
      this.els.AI_TYPING.classList.toggle('hidden', !processing);
      if (processing) {
        this.els.AI_TYPING.innerHTML = `<span class="animate-pulse">●</span> Processing...`;
      }
    }
    if (this.els.INPUT && !processing) {
      this.els.INPUT.focus();
    }
  }

  // ==========================================
  // Streaming
  // ==========================================

  startStreaming() {
    if (this.currentStreamEl && this.currentStreamEl.parentElement) {
      this.currentStreamEl.parentElement.remove();
    }
    this.currentStreamContent = '';
    this.currentStreamEl = null;

    this._createStreamElement();
    this._scrollToBottom(true);
  }

  private _createStreamElement() {
    if (!this.els.HISTORY) return;
    const div = document.createElement('div');
    div.className =
      'relative group p-3 rounded-lg text-sm mb-2 border border-border-main bg-card text-text-main mr-4 transition';
    div.innerHTML = `
      <div class="flex justify-between items-center mb-1 opacity-50 text-[10px] font-bold uppercase">MODEL (Generating...)</div>
      <div class="msg-content whitespace-pre-wrap break-all font-mono">${this.currentStreamContent}</div>
    `;
    this.els.HISTORY.appendChild(div);
    this.currentStreamEl = div.querySelector('.msg-content') as HTMLElement;

    if (this.currentStreamContent && this.renderer) {
      this.currentStreamEl.innerHTML = this.renderer.formatStream(this.currentStreamContent);
      this.currentStreamEl.classList.remove('whitespace-pre-wrap');
    }
  }

  updateStreaming(chunk: string) {
    if (!this.currentStreamEl) return;
    this.currentStreamContent += chunk;

    if (this.renderer && this.renderer.formatStream) {
      this.currentStreamEl.innerHTML = this.renderer.formatStream(this.currentStreamContent);
      this.currentStreamEl.classList.remove('whitespace-pre-wrap');
    } else {
      this.currentStreamEl.textContent = this.currentStreamContent;
    }
    this._scrollToBottom();
  }

  finalizeStreaming() {
    if (this.currentStreamEl) {
      const header = this.currentStreamEl.parentElement!.querySelector('div:first-child');
      if (header) header.textContent = 'MODEL';
    }
    this.currentStreamEl = null;
    this.currentStreamContent = '';
    this._scrollToBottom(true);
  }

  // ==========================================
  // History Rendering
  // ==========================================

  appendTurn(turn: Turn) {
    if (!turn) return;
    this._appendTurn(turn);
    this._scrollToBottom(true);
  }

  renderHistory(history: Turn[]) {
    if (!this.els.HISTORY) return;
    this.els.HISTORY.innerHTML = '';
    history.forEach((turn) => this._appendTurn(turn));
    this._scrollToBottom(true);
  }

  private _scrollToBottom(force = false) {
    const el = this.els.HISTORY;
    if (!el) return;
    const threshold = 100;
    const isAtBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + threshold;
    if (force || isAtBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }

  private _appendTurn(turn: Turn) {
    if (turn.meta && turn.meta.visible === false) return;

    let div = document.getElementById(`turn-${turn.id}`);
    let isUpdate = !!div;

    if (!div) {
      div = document.createElement('div');
      div.id = `turn-${turn.id}`;
    } else {
      div.innerHTML = '';
    }

    const role = turn.role;
    let baseClass = 'relative group p-3 rounded-lg text-sm mb-2 border transition';

    if (role === 'user') {
      div.className = `${baseClass} bg-primary/10 text-text-main border-primary/20 ml-4`;
    } else if (role === 'model') {
      div.className = `${baseClass} bg-card text-text-main border-border-main mr-4`;
    } else {
      div.className = `${baseClass} bg-panel text-text-muted text-xs mx-8 font-mono border-border-main`;
    }

    const header = document.createElement('div');
    header.className = 'flex justify-between items-center mb-1 opacity-50 text-[10px] font-bold uppercase';
    header.textContent = role;
    div.appendChild(header);

    const btnDelete = document.createElement('button');
    btnDelete.className =
      'absolute top-2 right-2 text-text-muted hover:text-error opacity-100 md:opacity-0 group-hover:opacity-100 p-1 transition';
    btnDelete.innerHTML = '×';
    btnDelete.onclick = async (e) => {
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
        this.events['delete_turn'](turn.id);
      }
    };
    div.appendChild(btnDelete);

    const body = document.createElement('div');
    body.className = 'break-all';

    if (typeof turn.content === 'string') {
      if (role === 'model' || (role === 'system' && turn.content.includes('<'))) {
        if (this.renderer) body.innerHTML = this.renderer.formatStream(turn.content);
        else body.textContent = turn.content;
      } else {
        body.className += ' whitespace-pre-wrap';
        body.innerHTML = this._formatSystemMessage(turn.content);
      }
    } else if (Array.isArray(turn.content)) {
      this._renderArrayContent(body, turn.content, role);
    }

    div.appendChild(body);

    if (!isUpdate) {
      this.els.HISTORY!.appendChild(div);
    }

    // 外部ライブラリ（MathJax, Highlight.js）の適用
    if ((window as any).MathJax) {
      (window as any).MathJax.typesetPromise([body]).catch((e: any) => console.warn('MathJax Error:', e));
    }
    if ((window as any).hljs) {
      body.querySelectorAll('pre code').forEach((block) => {
        (window as any).hljs.highlightElement(block);
      });
    }
  }

  private _renderArrayContent(container: HTMLElement, contentArray: any[], role: string) {
    contentArray.forEach((item) => {
      if (item.text) {
        const div = document.createElement('div');
        if ((role === 'model' || item.text.trim().startsWith('<')) && this.renderer) {
          div.innerHTML = this.renderer.formatStream(item.text);
        } else {
          div.className = 'whitespace-pre-wrap';
          div.innerHTML = this._formatSystemMessage(item.text);
        }
        container.appendChild(div);
      } else if (item.output) {
        const div = document.createElement('div');
        div.className = 'mb-1 whitespace-pre-wrap';
        const uiText = item.output.ui || item.output.log || '';

        if (item.output.ui) {
          const span = document.createElement('span');
          span.className = 'text-system font-bold block';
          span.innerHTML = this._formatSystemMessage(uiText);
          div.appendChild(span);
        } else {
          div.innerHTML = this._formatSystemMessage(uiText);
        }
        container.appendChild(div);

        if (item.output.media) {
          this._renderMediaFromVfs(container, item.output.media);
        } else if (item.output.image) {
          this._appendMedia(container, item.output.image, item.output.mimeType);
        }
      } else if (item.media) {
        this._renderMediaFromVfs(container, item.media);
      } else if (item.inlineData) {
        this._appendMedia(container, item.inlineData.data, item.inlineData.mimeType);
      }
    });
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
        div.innerHTML = `<span class="text-error">⚠️</span> <span class="line-through opacity-70">${mediaObj.path}</span> <span class="text-[10px] ml-auto">(File not found)</span>`;
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

    safeText = safeText.replace(/```(?:([a-zA-Z0-9_]+)\n)?([\s\S]*?)```/g, (_match, lang, code) => {
      const langClass = lang ? `language-${lang}` : 'language-plaintext';
      return `<pre class="bg-card border border-border-main p-2 rounded mt-1 mb-1 overflow-x-auto text-text-main font-mono text-[10px] leading-relaxed font-normal"><code class="${langClass}">${code}</code></pre>`;
    });

    safeText = safeText.replace(/`([^`]+)`/g, (_match, code) => {
      return `<code class="bg-app text-primary px-1 rounded font-mono text-[11px] font-normal">${code}</code>`;
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
      div.innerHTML = `<div class="text-2xl">📄</div><div class="flex flex-col overflow-hidden"><span class="text-xs text-text-main font-bold font-mono uppercase truncate">${mime}</span><span class="text-[10px] text-text-muted truncate">BINARY DATA</span></div>`;
      div.onclick = () => {
        if (this.events['preview_request']) {
          this.events['preview_request']('Attachment', src, mime, path);
        }
      };
      container.appendChild(div);
    }
  }
}
