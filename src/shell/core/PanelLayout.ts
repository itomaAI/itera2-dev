/**
 * src/shell/core/PanelLayout.ts
 * PC 表示でのパネルの開閉・幅の保存・チャットの全画面。
 *
 * - 「畳む」は `.panel-collapsed`（md 以上でだけ display:none。スマホの引き出しには効かない）
 * - 幅は各パネルの CSS 変数（`--explorer-w` / `--chat-w`）に置き、md 以上でだけ効く
 * - 開閉と幅は localStorage に残す（端末ごとの見え方なので VFS の設定には入れない）
 * - チャットの全画面（`.chat-full`）は中央の上に重ねるだけ。中央は再レイアウトされない。保存しない
 * - 集中モード（`body.focus-mode`・T-0641）は、上の帯・エクスプローラ・中央の道具帯を隠して主画面をアプリだけにする。
 *   チャットは右から重なる引き出し（`.focus-chat-open`）。登録簿で `immersive: true` のアプリが前面に出たら
 *   自動で入り、別のアプリに替わったら（自動で入っていたときだけ）戻す。手で入ったときは Esc か釦で出る。保存しない
 */
import { bindText } from '../../i18n/staticTexts';

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
  BTN_FOCUS: 'btn-focus',
  FOCUS_CONTROLS: 'focus-controls',
  BTN_FOCUS_CHAT: 'btn-focus-chat',
  BTN_FOCUS_EXIT: 'btn-focus-exit',
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
  /** 集中モード。`focusAuto` は「登録簿の immersive で自動的に入った」印（自動で出てよいのはこのときだけ） */
  private focus = false;
  private focusAuto = false;
  private focusChat = false;
  private els: Record<string, HTMLElement | null> = {};

  private storage: Storage;

  constructor(storage: Storage = localStorage) {
    this.storage = storage;
    this.state = readLayoutState(storage);
  }

  public init(): void {
    for (const [k, id] of Object.entries(IDS)) this.els[k] = document.getElementById(id);
    const { SIDEBAR, CHAT, EXPLORER_RESIZER, CHAT_RESIZER, BTN_EXPLORER, BTN_CHAT, BTN_FULL } = this.els;
    const { BTN_FOCUS, BTN_FOCUS_CHAT, BTN_FOCUS_EXIT } = this.els;
    if (!SIDEBAR || !CHAT) return;

    if (this.state.explorerWidth) SIDEBAR.style.setProperty('--explorer-w', `${this.state.explorerWidth}px`);
    if (this.state.chatWidth) CHAT.style.setProperty('--chat-w', `${this.state.chatWidth}px`);
    this._apply();

    BTN_EXPLORER?.addEventListener('click', () => this.toggleExplorer());
    BTN_CHAT?.addEventListener('click', () => this.toggleChat());
    BTN_FULL?.addEventListener('click', () => this.setChatFullscreen(!this.fullscreen));
    BTN_FOCUS?.addEventListener('click', () => this.setFocus(!this.focus));
    BTN_FOCUS_CHAT?.addEventListener('click', () => this.toggleFocusChat());
    BTN_FOCUS_EXIT?.addEventListener('click', () => this.setFocus(false));
    EXPLORER_RESIZER?.addEventListener('dblclick', () => this.setExplorer(false));
    CHAT_RESIZER?.addEventListener('dblclick', () => this.setChat(false));

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (this.fullscreen) this.setChatFullscreen(false);
      // 集中モードでは Esc 1 回目で引き出しを閉じ、2 回目で出る（ゲストの iframe の中の Esc はここに届かないので釦も要る）
      else if (this.focus && this.focusChat) this.setFocusChat(false);
      else if (this.focus) this.setFocus(false);
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
  public get isFocus(): boolean {
    return this.focus;
  }
  public get isFocusChatOpen(): boolean {
    return this.focus && this.focusChat;
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
    // 集中モードの引き出しと全画面は両立しない（left と width が噛み合わない）。全画面にしたいなら集中モードを出る
    if (on && this.focus) this.setFocus(false);
    this.fullscreen = on;
    if (on) this.state.chat = true;
    this._apply();
    this._save();
  }

  /**
   * 集中モードに入る／出る。`auto` は登録簿の immersive による入り（出るのも自動でよい）。
   * 入るとチャットの全画面は解く（引き出しと両立しない）。引き出しは閉じた状態から始める。開閉の状態（`state`）は変えない
   */
  public setFocus(on: boolean, opts: { auto?: boolean } = {}): void {
    if (on === this.focus) {
      if (on && !opts.auto) this.focusAuto = false; // 手で入り直したら、自動では出なくする
      return;
    }
    this.focus = on;
    this.focusAuto = on ? opts.auto === true : false;
    this.focusChat = false;
    if (on) this.fullscreen = false;
    this._apply();
  }
  public toggleFocusChat(): void {
    this.setFocusChat(!this.focusChat);
  }
  public setFocusChat(open: boolean): void {
    if (!this.focus) return;
    this.focusChat = open;
    this._apply();
  }
  /** 前面のアプリが替わったとき（ProcessManager の `foreground_changed`）。immersive なら入り、違えば自動で入っていたときだけ出る */
  public onForegroundApp(immersive: boolean): void {
    if (immersive) this.setFocus(true, { auto: true });
    else if (this.focus && this.focusAuto) this.setFocus(false);
  }

  private _apply(): void {
    const { SIDEBAR, CHAT, EXPLORER_RESIZER, CHAT_RESIZER, BTN_EXPLORER, BTN_CHAT, BTN_FULL } = this.els;
    const { BTN_FOCUS, BTN_FOCUS_CHAT, FOCUS_CONTROLS } = this.els;
    document.body.classList.toggle('focus-mode', this.focus);
    CHAT?.classList.toggle('focus-chat-open', this.focus && this.focusChat);
    // 引き出しが開いている間、浮き釦は引き出しの左隣へ（下に隠れて押せなくならないように）
    if (FOCUS_CONTROLS)
      FOCUS_CONTROLS.style.right = this.focus && this.focusChat && CHAT ? `${CHAT.offsetWidth + 8}px` : '';
    BTN_FOCUS?.classList.toggle('text-primary', this.focus);
    BTN_FOCUS_CHAT?.classList.toggle('text-primary', this.focus && this.focusChat);
    SIDEBAR?.classList.toggle('panel-collapsed', !this.state.explorer);
    EXPLORER_RESIZER?.classList.toggle('panel-collapsed', !this.state.explorer);
    CHAT?.classList.toggle('panel-collapsed', !this.state.chat);
    CHAT_RESIZER?.classList.toggle('panel-collapsed', !this.state.chat || this.fullscreen);
    CHAT?.classList.toggle('chat-full', this.fullscreen);
    BTN_EXPLORER?.classList.toggle('text-primary', this.state.explorer);
    BTN_CHAT?.classList.toggle('text-primary', this.state.chat);
    BTN_FULL?.classList.toggle('text-primary', this.fullscreen);
    if (BTN_FULL) bindText(BTN_FULL, this.fullscreen ? 'chat.exitFullscreen' : 'chat.fullscreen', undefined, 'title');
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
    if (CHAT && this.state.chat && !this.fullscreen && !this.focus && CHAT.offsetWidth > 0) {
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
