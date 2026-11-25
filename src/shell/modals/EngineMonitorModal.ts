/**
 * src/shell/modals/EngineMonitorModal.ts
 * Itera OS v2: 動いているエンジンの一覧（T-0916）
 *
 * プロセスモニタ（ProcessMonitorModal）と同じ形のホストの窓。開き方は `metaos://system/engines` とコマンドパレット。
 * 元は束の表（EngineManager.overview()。素の値の配列）。1 秒ごとに描き直す（プロセスモニタと同じ）。
 * 最初の版は見るだけ: 止める・畳むボタンは付けない。
 *
 * ※ index.html を汚さないよう、DOM は TypeScript から動的に生成します。
 */

import type { EngineOverview } from '../services/EngineManager';
import { LABEL_KICKER, LABEL_STREAM } from '../styles/typography';
import { t, escapeHtml, type MessageKey } from '../../i18n/i18n';
import { bindText } from '../../i18n/staticTexts';

/** 束の表を読む口（EngineManager が満たす）。起動の順で窓のほうが先に出来るので、あとから差す */
export interface EngineOverviewSource {
  overview(): EngineOverview[];
}

const BADGE = 'text-[0.625rem] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border';

const STATES: ReadonlyArray<{ key: 'running' | 'busy' | 'scheduled'; label: MessageKey; tone: string }> = [
  { key: 'running', label: 'engines.state.running', tone: 'bg-primary/20 text-primary border-primary/30' },
  { key: 'busy', label: 'engines.state.busy', tone: 'bg-warning/20 text-warning border-warning/30' },
  { key: 'scheduled', label: 'engines.state.scheduled', tone: 'bg-success/20 text-success border-success/30' },
];
const IDLE_TONE = 'bg-card text-text-muted border-border-main';

/** 状態の札。status() の running／busy／scheduled のうち立っているもの全部。どれも立っていなければ「待機」 */
function stateBadges(o: EngineOverview): string {
  const on = STATES.filter((s) => o[s.key]);
  if (on.length === 0) {
    return `<span class="${BADGE} ${IDLE_TONE}" data-state="idle">${escapeHtml(t('engines.state.idle'))}</span>`;
  }
  return on
    .map((s) => `<span class="${BADGE} ${s.tone}" data-state="${s.key}">${escapeHtml(t(s.label))}</span>`)
    .join('');
}

const fact = (name: string, label: string | null, value: string) =>
  `<span data-fact="${name}">${label === null ? '' : `<span class="${LABEL_STREAM}">${escapeHtml(label)}</span> `}${value}</span>`;

/** 1 行の中身（描く関数。窓の外でも試せるように切り出す） */
export function engineRowHTML(o: EngineOverview): string {
  const isRoot = o.role === 'root';
  const icon = isRoot ? '🧠' : '🤖';
  const roleTone = isRoot ? 'border-border-main text-text-muted' : 'border-primary/40 bg-primary/10 text-primary';
  const facts: string[] = [];
  if (!isRoot && o.ownerPid) {
    const app = o.ownerApp && o.ownerApp !== o.ownerPid ? ` (${escapeHtml(o.ownerApp)})` : '';
    facts.push(fact('owner', t('engines.owner'), `${escapeHtml(o.ownerPid)}${app}`));
  }
  facts.push(fact('turns', t('engines.turns'), String(o.turns)));
  facts.push(fact('serving', t('engines.serving'), String(o.serving)));
  if (o.model) facts.push(fact('model', null, escapeHtml(o.model)));
  if (o.contextTokens !== null) {
    facts.push(fact('context', t('engines.context'), o.contextTokens.toLocaleString('en-US')));
  }

  return `
    <div class="flex items-center gap-4 overflow-hidden min-w-0">
      <div class="w-10 h-10 bg-card rounded-xl flex items-center justify-center text-2xl shadow-inner shrink-0">${icon}</div>
      <div class="flex flex-col min-w-0">
        <div class="flex items-center gap-2 mb-1 flex-wrap">
          <span class="font-bold text-sm text-text-main font-mono truncate">${escapeHtml(o.id)}</span>
          <span class="${BADGE} ${roleTone}" data-role="${o.role}">${o.role}</span>
          ${stateBadges(o)}
        </div>
        <div class="text-[0.625rem] text-text-muted font-mono flex flex-wrap gap-x-3 gap-y-0.5">${facts.join('')}</div>
      </div>
    </div>
  `;
}

export class EngineMonitorModal {
  private source: EngineOverviewSource | null = null;
  private overlay: HTMLElement | null = null;
  private listContainer: HTMLElement | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private isOpen: boolean = false;
  /** プロセスモニタへ移る（差されていなければ、リンクを出さない） */
  private toProcesses: (() => void) | null = null;

  /** 束の表を差す（SystemBootstrapper。束の表は窓より後に出来る） */
  bind(source: EngineOverviewSource): void {
    this.source = source;
    if (this.isOpen) this._renderList();
  }

  /** 行き来のリンク（エンジン → モニタ） */
  linkTo(openProcesses: () => void): void {
    this.toProcesses = openProcesses;
  }

  private _createDOM(): void {
    if (this.overlay) return;

    this.overlay = document.createElement('div');
    this.overlay.dataset.modal = 'engine-monitor';
    this.overlay.className =
      'fixed inset-0 bg-black/60 backdrop-blur-sm z-[10000] flex items-center justify-center p-4 itera-animate-fade select-none';
    // 背景クリックで閉じる
    this.overlay.onclick = (e) => {
      if (e.target === this.overlay) this.close();
    };

    const box = document.createElement('div');
    box.className =
      'bg-panel border border-border-main rounded-2xl shadow-2xl w-full max-w-3xl flex flex-col overflow-hidden max-h-[85vh] itera-animate-modal';

    // Header
    const header = document.createElement('div');
    header.className = 'px-6 py-4 border-b border-border-main bg-card/50 flex items-center justify-between shrink-0';
    header.innerHTML = `
      <div class="flex items-center gap-3">
        <div class="w-8 h-8 rounded-lg bg-primary/20 text-primary flex items-center justify-center text-lg">🧠</div>
        <div>
          <h2 class="font-bold text-text-main text-base leading-tight" data-i18n="engines.title">${escapeHtml(t('engines.title'))}</h2>
          <div class="${LABEL_KICKER} text-text-muted mt-0.5" data-i18n="engines.subtitle">${escapeHtml(t('engines.subtitle'))}</div>
        </div>
      </div>
    `;

    const btnClose = document.createElement('button');
    btnClose.className =
      'w-8 h-8 flex items-center justify-center rounded-full bg-card hover:bg-hover border border-border-main text-text-muted hover:text-text-main transition';
    btnClose.innerHTML = '✕';
    btnClose.onclick = () => this.close();
    header.appendChild(btnClose);

    // List Container
    this.listContainer = document.createElement('div');
    this.listContainer.className = 'flex-1 overflow-y-auto p-4 space-y-2 bg-app';

    // Footer（見るだけ: 止める・畳むボタンは置かない）
    const footer = document.createElement('div');
    footer.className = 'px-6 py-3 border-t border-border-main bg-card flex justify-between items-center shrink-0';

    const statusText = document.createElement('div');
    statusText.className = 'text-xs font-mono text-text-muted flex items-center gap-2';
    statusText.innerHTML = `<span class="w-2 h-2 rounded-full bg-success animate-pulse"></span> Auto-updating (1s)`;
    footer.appendChild(statusText);

    if (this.toProcesses) {
      footer.appendChild(
        linkButton(
          'processes',
          '←',
          'monitor.title',
          null,
          () => this.toProcesses,
          () => this.close(),
        ),
      );
    }

    box.appendChild(header);
    box.appendChild(this.listContainer);
    box.appendChild(footer);
    this.overlay.appendChild(box);

    document.body.appendChild(this.overlay);
  }

  private _renderList(): void {
    if (!this.listContainer) return;
    const rows = this.source ? this.source.overview() : [];
    this.listContainer.innerHTML = '';
    for (const o of rows) {
      const row = document.createElement('div');
      row.dataset.engine = o.id;
      row.className = `flex items-center justify-between p-3 rounded-xl border transition ${
        o.role === 'root' ? 'border-border-main bg-panel' : 'border-primary/30 bg-primary/5'
      }`;
      row.innerHTML = engineRowHTML(o);
      this.listContainer.appendChild(row);
    }
  }

  private _startPolling(): void {
    if (this.pollTimer) return;
    this._renderList();
    this.pollTimer = setInterval(() => {
      this._renderList();
    }, 1000);
  }

  private _stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  open(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    this._createDOM();
    this.overlay?.classList.remove('hidden');
    this._startPolling();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.overlay?.classList.add('hidden');
    this._stopPolling();
  }
}

/**
 * 2 つの窓（プロセスモニタ ⇄ エンジンの一覧）を行き来する小さなリンク。押すと自分の窓を閉じて、相手を開く。
 * 文は bindText で言語に追随させる（矢印は文の外に置く）
 */
export function linkButton(
  name: string,
  before: string | null,
  label: MessageKey,
  after: string | null,
  target: () => (() => void) | null,
  closeSelf?: () => void,
): HTMLButtonElement {
  const link = document.createElement('button');
  link.dataset.link = name;
  link.className =
    'px-3 py-1.5 rounded-lg text-xs font-bold text-text-muted hover:text-text-main border border-border-main hover:bg-hover transition flex items-center gap-1';
  const text = document.createElement('span');
  bindText(text, label);
  if (before) link.append(before + ' ');
  link.appendChild(text);
  if (after) link.append(' ' + after);
  link.onclick = () => {
    const go = target();
    closeSelf?.();
    go?.();
  };
  return link;
}
