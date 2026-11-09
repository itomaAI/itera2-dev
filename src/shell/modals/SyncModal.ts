/**
 * src/shell/modals/SyncModal.ts
 * Itera OS v2: Cloud Sync Modal
 *
 * ホストはプロバイダを知らない。このモーダルが行うのは
 *   1. 集約された接続状態の表示
 *   2. アダプタ 1 つにつき 1 つの描画スロットを供給すること
 * のみである。スロットの中身はすべてアダプタ側が描画する。
 *
 * ※ 既存のモーダル（ProcessMonitorModal 等）に倣い、DOM は TypeScript から
 *    動的に生成する。index.html は変更しない。
 *    itera-saas 版は index.html に直接マークアップを置いていたが、
 *    itera2-dev の慣習に合わせてこちらを採用する。
 */

import type { SyncAdapterHost, SyncAdapterManifest, SyncAdapterStatus } from '../services/SyncAdapterHost';
import { LABEL_KICKER } from '../styles/typography';
import { t, escapeHtml } from '../../i18n/i18n';

/**
 * 「起動時にこの画面を開く」（preferences.promptCloudSignIn。T-0778）の読み書き。
 * モーダルは設定の持ち主を知らず、この 2 つの口だけを受け取る
 */
export interface StartupPromptPreference {
  get(): boolean;
  set(value: boolean): Promise<void>;
}

export class SyncModal {
  private adapterHost: SyncAdapterHost;
  private startupPrompt: StartupPromptPreference | null;
  private startupPromptCheckbox: HTMLInputElement | null = null;
  private overlay: HTMLElement | null = null;
  private providersContainer: HTMLElement | null = null;
  private statusLabel: HTMLElement | null = null;
  private statusDetail: HTMLElement | null = null;
  private emptyNotice: HTMLElement | null = null;

  /** アダプタ ID -> 描画スロット */
  private slots: Map<string, HTMLElement> = new Map();

  /**
   * 直近の集約状態。
   * アダプタは起動時（モーダルを一度も開く前）に接続を報告しうるため、
   * 保持しておかないと初回オープン時に "Local Mode Only" へ巻き戻ってしまう。
   */
  private lastSummary: SyncAdapterStatus | null = null;

  constructor(adapterHost: SyncAdapterHost, startupPrompt: StartupPromptPreference | null = null) {
    this.adapterHost = adapterHost;
    this.startupPrompt = startupPrompt;

    // アダプタは起動時（モーダルを開く前）に読み込まれるため、
    // スロットは DOM 生成前に要求される。生成済みかどうかに関わらず
    // スロットを返せるよう、ここで detached な要素を先に作って保持する。
    this.adapterHost.setContainerFactory((manifest) => this._getOrCreateSlot(manifest));
    this.adapterHost.onStatusChange((summary) => {
      this.lastSummary = summary;
      this._renderStatus(summary);
    });
  }

  private _getOrCreateSlot(manifest: SyncAdapterManifest): HTMLElement {
    const existing = this.slots.get(manifest.id);
    if (existing) return existing;

    const slot = document.createElement('div');
    slot.dataset.adapterId = manifest.id;
    slot.className = 'space-y-2';
    this.slots.set(manifest.id, slot);

    // モーダルが既に構築済みなら即座に差し込む
    if (this.providersContainer) {
      this.providersContainer.appendChild(slot);
      this._updateEmptyNotice();
    }
    return slot;
  }

  private _createDOM(): void {
    if (this.overlay) return;

    this.overlay = document.createElement('div');
    this.overlay.className =
      'fixed inset-0 bg-black/60 backdrop-blur-sm z-[10000] flex items-center justify-center p-4 itera-animate-fade select-none';
    this.overlay.onclick = (e) => {
      if (e.target === this.overlay) this.close();
    };

    const box = document.createElement('div');
    box.className =
      'bg-panel border border-border-main rounded-2xl shadow-2xl w-full max-w-sm flex flex-col overflow-hidden max-h-[85vh] itera-animate-modal';

    // --- Header ---
    const header = document.createElement('div');
    header.className = 'px-6 py-4 border-b border-border-main bg-card/50 flex items-center justify-between shrink-0';
    header.innerHTML = `
      <div class="flex items-center gap-3">
        <div class="w-8 h-8 rounded-lg bg-primary/20 text-primary flex items-center justify-center">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z"></path>
          </svg>
        </div>
        <div>
          <h2 class="font-bold text-text-main text-base leading-tight" data-i18n="sync.title">${escapeHtml(t('sync.title'))}</h2>
          <div class="${LABEL_KICKER} text-text-muted mt-0.5" data-i18n="sync.subtitle">${escapeHtml(t('sync.subtitle'))}</div>
        </div>
      </div>
    `;

    const btnClose = document.createElement('button');
    btnClose.className =
      'w-8 h-8 flex items-center justify-center rounded-full bg-card hover:bg-hover border border-border-main text-text-muted hover:text-text-main transition';
    btnClose.innerHTML = '✕';
    btnClose.onclick = () => this.close();
    header.appendChild(btnClose);

    // --- Body ---
    const body = document.createElement('div');
    body.className = 'p-5 flex flex-col gap-4 overflow-y-auto';

    const statusBox = document.createElement('div');
    statusBox.className = 'bg-card p-4 rounded-lg border border-border-main text-center';

    this.statusLabel = document.createElement('div');
    this.statusLabel.className = 'text-xs font-bold text-text-muted uppercase tracking-wider mb-1';
    this.statusLabel.textContent = t('sync.localOnly');

    this.statusDetail = document.createElement('div');
    this.statusDetail.className = 'text-sm font-bold text-text-main truncate';
    this.statusDetail.textContent = t('sync.notSignedIn');

    statusBox.appendChild(this.statusLabel);
    statusBox.appendChild(this.statusDetail);

    this.providersContainer = document.createElement('div');
    this.providersContainer.className = 'space-y-2';

    this.emptyNotice = document.createElement('div');
    this.emptyNotice.className =
      'text-xs text-text-muted text-center py-6 border border-dashed border-border-main rounded-lg leading-relaxed';
    this.emptyNotice.innerHTML = `<span data-i18n="sync.noAdapters">${escapeHtml(t('sync.noAdapters'))}</span><br /><span class="font-mono">system/registry/adapters.json</span>`;

    // 起動時に既に生成済みのスロットを流し込む
    for (const slot of this.slots.values()) {
      this.providersContainer.appendChild(slot);
    }

    body.appendChild(statusBox);
    body.appendChild(this.emptyNotice);
    body.appendChild(this.providersContainer);
    if (this.startupPrompt) body.appendChild(this._createStartupPromptRow(this.startupPrompt));

    box.appendChild(header);
    box.appendChild(body);
    this.overlay.appendChild(box);

    this._updateEmptyNotice();
    this._renderStatus(this.lastSummary);
  }

  /**
   * 起動時にこの画面を開くかのチェック（T-0778）。
   * 値は preferences.promptCloudSignIn。変えた瞬間に書く（保存ボタンは置かない —— 1 つの真偽値なので）
   */
  private _createStartupPromptRow(pref: StartupPromptPreference): HTMLElement {
    const row = document.createElement('label');
    row.className = 'flex items-center gap-2 text-xs text-text-muted cursor-pointer select-none px-1';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'w-4 h-4 rounded border-border-main text-primary focus:ring-primary cursor-pointer';
    box.checked = pref.get();
    box.addEventListener('change', () => {
      const next = box.checked;
      pref.set(next).catch((e) => {
        console.error('[SyncModal] Failed to save promptCloudSignIn:', e);
        box.checked = !next; // 書けなかったら見た目も戻す（書けたふりをしない）
      });
    });
    const text = document.createElement('span');
    text.dataset.i18n = 'sync.promptAtStartup';
    text.textContent = t('sync.promptAtStartup');
    row.appendChild(box);
    row.appendChild(text);
    this.startupPromptCheckbox = box;
    return row;
  }

  private _updateEmptyNotice(): void {
    if (!this.emptyNotice) return;
    this.emptyNotice.style.display = this.slots.size > 0 ? 'none' : 'block';
  }

  private _renderStatus(summary: SyncAdapterStatus | null): void {
    if (!this.statusLabel || !this.statusDetail) return;

    const s = summary || { state: 'disconnected' as const };
    const colorByState: Record<string, string> = {
      connected: 'text-primary',
      connecting: 'text-warning',
      error: 'text-error',
      disconnected: 'text-text-muted',
    };

    this.statusLabel.className = `text-xs font-bold uppercase tracking-wider mb-1 ${
      colorByState[s.state] || 'text-text-muted'
    }`;
    this.statusLabel.textContent = s.label || (s.state === 'connected' ? t('sync.active') : t('sync.localOnly'));
    this.statusDetail.textContent = s.detail || (s.state === 'connected' ? t('sync.online') : t('sync.notSignedIn'));
  }

  open(): void {
    this._createDOM();
    if (this.overlay && !this.overlay.parentElement) {
      document.body.appendChild(this.overlay);
    }
    this._updateEmptyNotice();
    // 設定は他所（設定アプリ・別端末からの同期）でも変わるので、開くたびに読み直す
    if (this.startupPromptCheckbox && this.startupPrompt) this.startupPromptCheckbox.checked = this.startupPrompt.get();
  }

  close(): void {
    if (this.overlay && this.overlay.parentElement) {
      this.overlay.parentElement.removeChild(this.overlay);
    }
  }

  toggle(): void {
    if (this.overlay && this.overlay.parentElement) this.close();
    else this.open();
  }
}
