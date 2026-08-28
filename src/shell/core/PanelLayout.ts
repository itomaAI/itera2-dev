/**
 * src/shell/core/PanelLayout.ts
 * PC 表示でのパネルの開閉・幅の保存・チャットの全画面。
 *
 * - 「畳む」は `.panel-collapsed`（md 以上でだけ display:none。スマホの引き出しには効かない）
 * - 幅は各パネルの CSS 変数（`--explorer-w` / `--chat-w`）に置き、md 以上でだけ効く
 * - 開閉と幅は localStorage に残す（端末ごとの見え方なので VFS の設定には入れない）
 * - チャットの全画面（`.chat-full`）は中央の上に重ねるだけ。中央は再レイアウトされない。保存しない
 */

const STORAGE_KEY = 'itera.layout.v1';
const MD = 768;

const IDS = {
  SIDEBAR: 'sidebar',
  EXPLORER_RESIZER: 'explorer-resizer',
  CHAT: 'chat-panel',
  CHAT_RESIZER: 'chat-resizer',
  BTN_EXPLORER: 'btn-toggle-explorer',
  BTN_CHAT: 'btn-toggle-chat',
  BTN_FULL: 'btn-chat-fullscreen',
};

export interface LayoutState {
  explorer: boolean;
  chat: boolean;
  explorerWidth: number | null;
  chatWidth: number | null;
}

const DEFAULT_STATE: LayoutState = { explorer: true, chat: true, explorerWidth: null, chatWidth: null };

export function readLayoutState(storage: Pick<Storage, 'getItem'>): LayoutState {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const j = JSON.parse(raw);
    const num = (v: unknown) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : null);
    return {
      explorer: j.explorer !== false,
      chat: j.chat !== false,
      explorerWidth: num(j.explorerWidth),
      chatWidth: num(j.chatWidth),
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export class PanelLayout {
  private state: LayoutState;
  private fullscreen = false;
  private els: Record<string, HTMLElement | null> = {};

  private storage: Storage;

  constructor(storage: Storage = localStorage) {
    this.storage = storage;
    this.state = readLayoutState(storage);
  }

  public init(): void {
    for (const [k, id] of Object.entries(IDS)) this.els[k] = document.getElementById(id);
    const { SIDEBAR, CHAT, EXPLORER_RESIZER, CHAT_RESIZER, BTN_EXPLORER, BTN_CHAT, BTN_FULL } = this.els;
    if (!SIDEBAR || !CHAT) return;

    if (this.state.explorerWidth) SIDEBAR.style.setProperty('--explorer-w', `${this.state.explorerWidth}px`);
    if (this.state.chatWidth) CHAT.style.setProperty('--chat-w', `${this.state.chatWidth}px`);
    this._apply();

    BTN_EXPLORER?.addEventListener('click', () => this.toggleExplorer());
    BTN_CHAT?.addEventListener('click', () => this.toggleChat());
    BTN_FULL?.addEventListener('click', () => this.setChatFullscreen(!this.fullscreen));
    EXPLORER_RESIZER?.addEventListener('dblclick', () => this.setExplorer(false));
    CHAT_RESIZER?.addEventListener('dblclick', () => this.setChat(false));

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.fullscreen) this.setChatFullscreen(false);
    });

    // 幅はリサイザが CSS 変数に書く。ここでは観測して保存するだけ
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => this._persistWidths()).observe(SIDEBAR);
      new ResizeObserver(() => this._persistWidths()).observe(CHAT);
    }
  }

  public get isExplorerOpen(): boolean {
    return this.state.explorer;
  }
  public get isChatOpen(): boolean {
    return this.state.chat;
  }
  public get isChatFullscreen(): boolean {
    return this.fullscreen;
  }

  public toggleExplorer(): void {
    this.setExplorer(!this.state.explorer);
  }
  public toggleChat(): void {
    this.setChat(!this.state.chat);
  }
  public setExplorer(open: boolean): void {
    this.state.explorer = open;
    this._apply();
    this._save();
  }
  public setChat(open: boolean): void {
    this.state.chat = open;
    if (!open) this.fullscreen = false;
    this._apply();
    this._save();
  }
  public setChatFullscreen(on: boolean): void {
    this.fullscreen = on;
    if (on) this.state.chat = true;
    this._apply();
    this._save();
  }

  private _apply(): void {
    const { SIDEBAR, CHAT, EXPLORER_RESIZER, CHAT_RESIZER, BTN_EXPLORER, BTN_CHAT, BTN_FULL } = this.els;
    SIDEBAR?.classList.toggle('panel-collapsed', !this.state.explorer);
    EXPLORER_RESIZER?.classList.toggle('panel-collapsed', !this.state.explorer);
    CHAT?.classList.toggle('panel-collapsed', !this.state.chat);
    CHAT_RESIZER?.classList.toggle('panel-collapsed', !this.state.chat || this.fullscreen);
    CHAT?.classList.toggle('chat-full', this.fullscreen);
    BTN_EXPLORER?.classList.toggle('text-primary', this.state.explorer);
    BTN_CHAT?.classList.toggle('text-primary', this.state.chat);
    BTN_FULL?.classList.toggle('text-primary', this.fullscreen);
    if (BTN_FULL) BTN_FULL.title = this.fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen';
    this._updateFullLeft();
  }

  /** 全画面のとき、開いているエクスプローラの右端から始める */
  private _updateFullLeft(): void {
    const { SIDEBAR, CHAT, EXPLORER_RESIZER } = this.els;
    if (!CHAT) return;
    let left = 0;
    if (this.fullscreen && this.state.explorer && SIDEBAR) {
      left = SIDEBAR.offsetWidth + (EXPLORER_RESIZER?.offsetWidth ?? 0);
    }
    CHAT.style.setProperty('--chat-full-left', `${left}px`);
  }

  private _persistWidths(): void {
    if (window.innerWidth < MD) return; // 引き出し表示の幅は保存しない
    const { SIDEBAR, CHAT } = this.els;
    let changed = false;
    if (SIDEBAR && this.state.explorer && SIDEBAR.offsetWidth > 0) {
      const w = Math.round(SIDEBAR.offsetWidth);
      if (w !== this.state.explorerWidth) {
        this.state.explorerWidth = w;
        changed = true;
      }
    }
    if (CHAT && this.state.chat && !this.fullscreen && CHAT.offsetWidth > 0) {
      const w = Math.round(CHAT.offsetWidth);
      if (w !== this.state.chatWidth) {
        this.state.chatWidth = w;
        changed = true;
      }
    }
    if (this.fullscreen) this._updateFullLeft();
    if (changed) this._save();
  }

  private _save(): void {
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      /* private mode など。保存できなくても動く */
    }
  }
}
