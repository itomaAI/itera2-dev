/**
 * src/shell/modals/SessionHistoryModal.ts
 * Itera OS v2: Session History Modal（T-0613）
 *
 * チャットのヘッダの履歴ボタンから開く。いまの会話と、退避した会話（新しい順）、VFS の保存先にある会話を並べ、
 * 切り替え／VFS に保存／削除／読み込み ができる。
 * 🔴 VFS の一覧は名前と stat だけで描き、中身は読まない（同期のスタブを取りに行かない）。読むのは読み込みで選んだ 1 ファイルだけ。
 * ※ index.html を汚さないよう、DOM は TypeScript から動的に生成する（ProcessMonitorModal と同じ型）。
 */

import type { SessionManager, SessionSwitchResult } from '../services/SessionManager';
import type { FilePickerModal } from './FilePickerModal';
import type { Principal } from '../../core/vfs/types';
import type { SavedSessionEntry, SessionMeta } from '../../core/state/sessionArchive';
import { LABEL_KICKER } from '../styles/typography';
import { t, escapeHtml, i18n } from '../../i18n/i18n';
import { bindText } from '../../i18n/staticTexts';

export interface SessionHistoryModalDeps {
  getActivePrincipal: () => Principal;
  /** `preferences.sessionHistoryKeep` を整えた値（一覧の下の注記に出す） */
  keep: () => number;
}

const EXPORT_FILTERS = ['.json'];

export class SessionHistoryModal {
  private sessions: SessionManager;
  private filePicker: FilePickerModal;
  private deps: SessionHistoryModalDeps;
  private overlay: HTMLElement | null = null;
  private listContainer: HTMLElement | null = null;
  private noteEl: HTMLElement | null = null;
  private isOpen = false;
  private busy = false;

  constructor(sessions: SessionManager, filePicker: FilePickerModal, deps: SessionHistoryModalDeps) {
    this.sessions = sessions;
    this.filePicker = filePicker;
    this.deps = deps;
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
      'bg-panel border border-border-main rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col overflow-hidden max-h-[85vh] itera-animate-modal';

    const header = document.createElement('div');
    header.className = 'px-6 py-4 border-b border-border-main bg-card/50 flex items-center justify-between shrink-0';
    header.innerHTML = `
      <div class="flex items-center gap-3">
        <div class="w-8 h-8 rounded-lg bg-primary/20 text-primary flex items-center justify-center text-lg">🕘</div>
        <div>
          <h2 class="font-bold text-text-main text-base leading-tight" data-i18n="sessions.title">${escapeHtml(t('sessions.title'))}</h2>
          <div class="${LABEL_KICKER} text-text-muted mt-0.5" data-i18n="sessions.subtitle">${escapeHtml(t('sessions.subtitle'))}</div>
        </div>
      </div>
    `;
    const btnClose = document.createElement('button');
    btnClose.className =
      'w-8 h-8 flex items-center justify-center rounded-full bg-card hover:bg-hover border border-border-main text-text-muted hover:text-text-main transition';
    btnClose.innerHTML = '✕';
    btnClose.onclick = () => this.close();
    header.appendChild(btnClose);

    this.listContainer = document.createElement('div');
    this.listContainer.className = 'flex-1 overflow-y-auto p-4 space-y-2 bg-app';

    const footer = document.createElement('div');
    footer.className = 'px-6 py-3 border-t border-border-main bg-card flex justify-between items-center shrink-0 gap-3';

    this.noteEl = document.createElement('div');
    this.noteEl.className = 'text-xs text-text-muted min-w-0';

    const btnLoad = document.createElement('button');
    btnLoad.className =
      'px-4 py-2 rounded-lg text-xs font-bold text-primary border border-primary/50 hover:bg-primary hover:text-white transition shrink-0';
    bindText(btnLoad, 'sessions.load');
    btnLoad.onclick = () => void this._loadFromVfs();

    footer.appendChild(this.noteEl);
    footer.appendChild(btnLoad);

    box.appendChild(header);
    box.appendChild(this.listContainer);
    box.appendChild(footer);
    this.overlay.appendChild(box);
    document.body.appendChild(this.overlay);
  }

  // ==========================================
  // 描画
  // ==========================================

  private _formatWhen(ms: number): string {
    try {
      return new Date(ms).toLocaleString(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
    } catch {
      return new Date(ms).toLocaleString();
    }
  }

  private _formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  private _button(labelKey: Parameters<typeof t>[0], cls: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = `px-3 py-1.5 rounded-md text-xs font-bold border transition ${cls}`;
    bindText(b, labelKey);
    b.onclick = (e) => {
      e.stopPropagation();
      onClick();
    };
    return b;
  }

  private _section(key: Parameters<typeof t>[0], params?: Record<string, string | number>): HTMLElement {
    const h = document.createElement('div');
    h.className = `${LABEL_KICKER} text-text-muted px-1 pt-2`;
    bindText(h, key, params);
    return h;
  }

  private _savedRow(entry: SavedSessionEntry): HTMLElement {
    const row = document.createElement('div');
    row.className = 'p-3 rounded-xl border flex items-center gap-3 bg-card border-border-main hover:border-primary/40';

    const info = document.createElement('div');
    info.className = 'flex-1 min-w-0';
    const title = entry.title || (entry.startedAt ? this._formatWhen(entry.startedAt) : entry.name);
    // 題が無ければ始まりの時刻が題になるので、下の行には繰り返さない
    const when = entry.title && entry.startedAt ? this._formatWhen(entry.startedAt) : '';
    const stub = entry.stub ? ` · ${escapeHtml(t('sessions.stub'))}` : '';
    info.innerHTML = `
      <div class="text-sm font-medium text-text-main truncate" title="${escapeHtml(entry.path)}">${escapeHtml(title)}</div>
      <div class="text-xs text-text-muted mt-0.5 truncate">${escapeHtml(when)}${when ? ' · ' : ''}${escapeHtml(
        t('sessions.savedAt', { when: this._formatWhen(entry.updatedAt) }),
      )} · ${escapeHtml(this._formatBytes(entry.size))}${stub}</div>
    `;

    const actions = document.createElement('div');
    actions.className = 'flex items-center gap-1.5 shrink-0';
    actions.appendChild(
      this._button(
        'sessions.loadThis',
        'text-white bg-primary border-primary hover:bg-primary/90',
        () => void this._loadPath(entry.path),
      ),
    );
    actions.appendChild(
      this._button(
        'sessions.delete',
        'text-error border-error/40 hover:bg-error hover:text-white',
        () => void this._deleteSaved(entry),
      ),
    );
    row.appendChild(info);
    row.appendChild(actions);
    return row;
  }

  private _row(meta: SessionMeta, isCurrent: boolean): HTMLElement {
    const row = document.createElement('div');
    row.className = `p-3 rounded-xl border flex items-center gap-3 ${
      isCurrent ? 'bg-primary/5 border-primary/40' : 'bg-card border-border-main hover:border-primary/40'
    }`;

    const info = document.createElement('div');
    info.className = 'flex-1 min-w-0';
    // 題は利用者が付けたもの。無ければ会話の始まりの時刻（最初の発言は題にしない。2026-10-06 山内さん）
    const title = meta.title || this._formatWhen(meta.createdAt);
    const badge = isCurrent
      ? `<span class="ml-2 px-1.5 py-0.5 rounded text-[0.625rem] font-bold bg-primary/15 text-primary border border-primary/30">${escapeHtml(t('sessions.current'))}</span>`
      : '';
    info.innerHTML = `
      <div class="text-sm font-medium text-text-main truncate flex items-center min-w-0">
        <span class="truncate">${escapeHtml(title)}</span>${badge}
        <button type="button" class="ml-1.5 shrink-0 text-text-muted hover:text-primary text-xs" data-role="rename" title="${escapeHtml(t('sessions.rename'))}">✎</button>
      </div>
      <div class="text-xs text-text-muted mt-0.5 truncate">${escapeHtml(this._formatWhen(meta.updatedAt))} · ${escapeHtml(
        t('sessions.turns', { count: meta.turnCount }),
      )} · ${escapeHtml(this._formatBytes(meta.bytes))}</div>
    `;
    const renameBtn = info.querySelector<HTMLButtonElement>('button[data-role="rename"]');
    if (renameBtn) {
      renameBtn.onclick = (e) => {
        e.stopPropagation();
        void this._rename(isCurrent ? 'current' : meta.id, meta);
      };
    }

    const actions = document.createElement('div');
    actions.className = 'flex items-center gap-1.5 shrink-0';
    if (!isCurrent) {
      actions.appendChild(
        this._button(
          'sessions.switch',
          'text-white bg-primary border-primary hover:bg-primary/90',
          () => void this._switch(meta.id),
        ),
      );
    }
    actions.appendChild(
      this._button(
        'sessions.save',
        'text-text-muted border-border-main hover:text-text-main hover:bg-hover',
        () => void this._saveToVfs(isCurrent ? 'current' : meta.id, meta),
      ),
    );
    if (!isCurrent) {
      actions.appendChild(
        this._button(
          'sessions.delete',
          'text-error border-error/40 hover:bg-error hover:text-white',
          () => void this._delete(meta),
        ),
      );
    }

    row.appendChild(info);
    row.appendChild(actions);
    return row;
  }

  private async _render(): Promise<void> {
    if (!this.listContainer) return;
    const container = this.listContainer;
    try {
      const [current, archived] = await Promise.all([this.sessions.currentSession(), this.sessions.listSessions()]);
      container.innerHTML = '';
      container.appendChild(this._section('sessions.section.browser', { count: this.deps.keep() }));
      container.appendChild(this._row(current, true));
      if (archived.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'text-center text-text-muted text-xs p-4';
        bindText(empty, 'sessions.empty');
        container.appendChild(empty);
      } else {
        for (const meta of archived) container.appendChild(this._row(meta, false));
      }

      // VFS の保存先。名前と stat だけ（中身は読まない）
      const dir = this.sessions.savedSessionsDir();
      if (dir) {
        container.appendChild(this._section('sessions.section.vfs', { dir }));
        const saved = this.sessions.listSavedSessions(this.deps.getActivePrincipal());
        if (saved.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'text-center text-text-muted text-xs p-4';
          bindText(empty, 'sessions.savedEmpty');
          container.appendChild(empty);
        } else {
          for (const entry of saved) container.appendChild(this._savedRow(entry));
        }
      }
      if (this.noteEl) bindText(this.noteEl, 'sessions.keepNote', { count: this.deps.keep() });
    } catch (e: any) {
      container.innerHTML = `<div class="text-center text-error text-xs p-6">${escapeHtml(String(e?.message || e))}</div>`;
    }
  }

  // ==========================================
  // 操作
  // ==========================================

  private async _guard<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (this.busy) return undefined;
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }

  private _explain(res: SessionSwitchResult): void {
    if (res.ok) return;
    if (res.reason === 'busy') {
      void window.AppUI?.showMessageBox({
        title: t('sessions.busy.title'),
        message: t('sessions.busy.message'),
        type: 'warning',
        buttons: [{ label: t('common.ok'), value: true, style: 'primary', isDefault: true, isCancel: true }],
      });
      return;
    }
    const reason = res.reason === 'missing' ? t('sessions.missing') : res.detail || res.reason;
    window.AppUI?.notify(t('sessions.loadFailed', { reason }), 'error');
  }

  private async _switch(id: string): Promise<void> {
    await this._guard(async () => {
      const res = await this.sessions.switchSession(id);
      if (res.ok) {
        this.close();
        window.AppUI?.notify(t('sessions.switched'), 'success');
      } else {
        this._explain(res);
      }
    });
  }

  /** 題を付け替える（空にすると題なし＝始まりの時刻で表示） */
  private async _rename(id: string | 'current', meta: SessionMeta): Promise<void> {
    await this._guard(async () => {
      const value = await window.AppUI?.prompt(t('sessions.renameMessage'), meta.title, t('sessions.rename'));
      if (value === null || value === undefined) return;
      const ok = await this.sessions.renameSession(id, value);
      if (!ok) window.AppUI?.notify(t('sessions.loadFailed', { reason: t('sessions.missing') }), 'error');
      await this._render();
    });
  }

  private async _delete(meta: SessionMeta): Promise<void> {
    await this._guard(async () => {
      const res = await window.AppUI?.showMessageBox({
        title: t('sessions.deleteConfirm.title'),
        message: t('sessions.deleteConfirm.message', { title: meta.title || this._formatWhen(meta.createdAt) }),
        type: 'warning',
        buttons: [
          { label: t('common.cancel'), value: false, style: 'normal', isCancel: true },
          { label: t('common.delete'), value: true, style: 'danger', isDefault: true },
        ],
      });
      if (!res || !res.action) return;
      await this.sessions.deleteSession(meta.id);
      await this._render();
    });
  }

  /**
   * 既定の保存先（paths.user.sessions）へ直接書く。宣言が無い配布物だけダイアログで場所を訊く。
   */
  private async _saveToVfs(id: string | 'current', meta: SessionMeta): Promise<void> {
    await this._guard(async () => {
      const principal = this.deps.getActivePrincipal();
      try {
        let path: string | null = null;
        if (this.sessions.savedSessionsDir()) {
          path = await this.sessions.exportSessionToDefaultDir(id, principal);
          if (!path) {
            window.AppUI?.notify(t('sessions.loadFailed', { reason: t('sessions.missing') }), 'error');
            return;
          }
        } else {
          path = await this.filePicker.openSave({
            title: t('sessions.saveTitle'),
            filters: EXPORT_FILTERS,
            defaultName: `${meta.id.slice(0, 8)}.json`,
          });
          if (!path) return;
          const ok = await this.sessions.exportSessionToVfs(id, path, principal);
          if (!ok) {
            window.AppUI?.notify(t('sessions.loadFailed', { reason: t('sessions.missing') }), 'error');
            return;
          }
        }
        window.AppUI?.notify(t('sessions.saved', { path }), 'success');
        await this._render();
      } catch (e: any) {
        window.AppUI?.notify(t('notify.saveFailed', { reason: e.message }), 'error');
      }
    });
  }

  /** 保存先の一覧の 1 つを読み込む（読むのはこの 1 ファイルだけ） */
  private async _loadPath(path: string): Promise<void> {
    await this._guard(async () => {
      const res = await this.sessions.importSessionFromVfs(path, this.deps.getActivePrincipal());
      if (res.ok) {
        this.close();
        window.AppUI?.notify(t('sessions.loaded', { path }), 'success');
      } else {
        this._explain(res);
      }
    });
  }

  /** 保存先のファイルをゴミ箱へ（永久には消さない） */
  private async _deleteSaved(entry: SavedSessionEntry): Promise<void> {
    await this._guard(async () => {
      const res = await window.AppUI?.showMessageBox({
        title: t('sessions.deleteConfirm.title'),
        message: t('sessions.deleteSavedConfirm.message', { name: entry.name }),
        type: 'warning',
        buttons: [
          { label: t('common.cancel'), value: false, style: 'normal', isCancel: true },
          { label: t('common.delete'), value: true, style: 'danger', isDefault: true },
        ],
      });
      if (!res || !res.action) return;
      try {
        await this.sessions.deleteSavedSession(entry.path, this.deps.getActivePrincipal());
      } catch (e: any) {
        window.AppUI?.notify(t('sessions.loadFailed', { reason: e.message }), 'error');
      }
      await this._render();
    });
  }

  private async _loadFromVfs(): Promise<void> {
    await this._guard(async () => {
      const dir = this.sessions.savedSessionsDir();
      const path = await this.filePicker.open({
        title: t('sessions.loadTitle'),
        filters: EXPORT_FILTERS,
        defaultPath: dir || undefined,
        mode: 'any', // 保存のディレクトリ（session.json＋media/）か、旧形式の単一 .json
      });
      if (!path) return;
      const res = await this.sessions.importSessionFromVfs(path, this.deps.getActivePrincipal());
      if (res.ok) {
        this.close();
        window.AppUI?.notify(t('sessions.loaded', { path }), 'success');
      } else {
        this._explain(res);
      }
    });
  }

  // ==========================================
  // 開閉
  // ==========================================

  open(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    this._createDOM();
    this.overlay?.classList.remove('hidden');
    void this._render();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.overlay?.classList.add('hidden');
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }
}
