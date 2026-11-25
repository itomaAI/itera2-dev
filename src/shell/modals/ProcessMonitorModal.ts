/**
 * src/shell/modals/ProcessMonitorModal.ts
 * Itera OS v2: Process Monitor (Activity Monitor) Modal
 *
 * ※ index.html を汚さないよう、DOM は TypeScript から動的に生成します。
 */

import type { ProcessManager } from '../windowing/ProcessManager';
import { USER_MOVER } from '../windowing/processGate';
import type { AppRegistry } from '../../core/sys/AppRegistry';
import type { ConfigManager } from '../../core/sys/ConfigManager';
import { LABEL_KICKER, LABEL_STREAM } from '../styles/typography';
import { t, escapeHtml } from '../../i18n/i18n';
import { bindText } from '../../i18n/staticTexts';
import { ROOT_ENGINE_ID } from '../../core/control/Engine';
import { linkButton } from './EngineMonitorModal';

/**
 * 持ち主の札（T-0916）: そのプロセスが仕えるエンジン（プロセスの記録の engine）。
 * ルートのものは控えめに、サブ（eng-…）のものは見分けがつくように色を付ける。id は大文字にしない（id は字のとおりに読む）。
 * 札の字は行ごとに出る（反復する）ので LABEL_STREAM（typography.ts の「反復するものは飾らない」）
 */
export function ownerBadgeHTML(engine: string): string {
  const isRoot = engine === ROOT_ENGINE_ID;
  const tone = isRoot
    ? 'border-border-main text-text-muted opacity-70'
    : 'border-primary/40 bg-primary/10 text-primary';
  return (
    `<span class="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded border ${tone}"` +
    ` data-owner="${escapeHtml(engine)}" data-owner-role="${isRoot ? 'root' : 'sub'}" title="${escapeHtml(t('monitor.engineTitle'))}">` +
    `<span class="${LABEL_STREAM}">${escapeHtml(t('monitor.engine'))}</span>` +
    `<span class="font-mono text-[0.625rem]">${escapeHtml(engine)}</span></span>`
  );
}

export class ProcessMonitorModal {
  private processManager: ProcessManager;
  private appRegistry: AppRegistry;
  private configManager: ConfigManager;
  private overlay: HTMLElement | null = null;
  private listContainer: HTMLElement | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private isOpen: boolean = false;
  /** エンジンの一覧へ移る（差されていなければ、リンクを出さない。T-0916） */
  private toEngines: (() => void) | null = null;

  constructor(processManager: ProcessManager, appRegistry: AppRegistry, configManager: ConfigManager) {
    this.processManager = processManager;
    this.appRegistry = appRegistry;
    this.configManager = configManager;
  }

  /** 行き来のリンク（モニタ → エンジンの一覧。T-0916） */
  linkTo(openEngines: () => void): void {
    this.toEngines = openEngines;
  }

  /**
   * モーダルのDOMを動的に生成する
   */
  private _createDOM(): void {
    if (this.overlay) return;

    this.overlay = document.createElement('div');
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
        <div class="w-8 h-8 rounded-lg bg-primary/20 text-primary flex items-center justify-center text-lg">📊</div>
        <div>
          <h2 class="font-bold text-text-main text-base leading-tight" data-i18n="monitor.title">${escapeHtml(t('monitor.title'))}</h2>
          <div class="${LABEL_KICKER} text-text-muted mt-0.5" data-i18n="monitor.subtitle">${escapeHtml(t('monitor.subtitle'))}</div>
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

    // Footer
    const footer = document.createElement('div');
    footer.className = 'px-6 py-3 border-t border-border-main bg-card flex justify-between items-center shrink-0';

    const statusText = document.createElement('div');
    statusText.className = 'text-xs font-mono text-text-muted flex items-center gap-2';
    statusText.innerHTML = `<span class="w-2 h-2 rounded-full bg-success animate-pulse"></span> Auto-updating (1s)`;

    const btnKillAll = document.createElement('button');
    btnKillAll.className =
      'px-4 py-2 rounded-lg text-xs font-bold text-error hover:text-white border border-error/50 hover:bg-error transition';
    bindText(btnKillAll, 'monitor.killAll');
    btnKillAll.onclick = async () => {
      const res = await window.AppUI?.showMessageBox({
        title: t('monitor.killAll'),
        message: t('monitor.killAllMessage'),
        type: 'warning',
        buttons: [
          { label: t('common.cancel'), value: false, style: 'normal', isCancel: true },
          { label: t('monitor.killAllConfirm'), value: true, style: 'danger', isDefault: true },
        ],
      });

      if (res && res.action) {
        const procs = this.processManager.list();
        procs.forEach((p) => {
          if (p.type === 'daemon') this.processManager.kill(USER_MOVER, p.pid);
        });
        this._renderList();
      }
    };

    footer.appendChild(statusText);
    const actions = document.createElement('div');
    actions.className = 'flex items-center gap-2';
    if (this.toEngines) {
      actions.appendChild(
        linkButton(
          'engines',
          null,
          'engines.title',
          '→',
          () => this.toEngines,
          () => this.close(),
        ),
      );
    }
    actions.appendChild(btnKillAll);
    footer.appendChild(actions);

    box.appendChild(header);
    box.appendChild(this.listContainer);
    box.appendChild(footer);
    this.overlay.appendChild(box);

    document.body.appendChild(this.overlay);
  }

  private _renderList(): void {
    if (!this.listContainer) return;

    const processes = this.processManager.listWithEngine();

    // Sort: Foreground -> Background App -> Daemon
    processes.sort((a, b) => {
      const getScore = (p: any) => (p.state === 'foreground' ? 3 : p.type === 'app' ? 2 : 1);
      return getScore(b) - getScore(a);
    });

    this.listContainer.innerHTML = '';

    if (processes.length === 0) {
      this.listContainer.innerHTML = `<div class="flex items-center justify-center h-32 text-sm text-text-muted">${escapeHtml(t('monitor.empty'))}</div>`;
      return;
    }

    processes.forEach((proc) => {
      const isForeground = proc.state === 'foreground';
      const isDaemon = proc.type === 'daemon';

      const badgeColor = isForeground
        ? 'bg-primary/20 text-primary border-primary/30'
        : isDaemon
          ? 'bg-warning/20 text-warning border-warning/30'
          : 'bg-success/20 text-success border-success/30';

      let displayName = proc.pid;
      let icon = isDaemon ? '⚙️' : '🖥️';

      // レジストリからリッチなメタデータを取得
      if (isDaemon) {
        const svc = this.appRegistry.getService(proc.app);
        if (svc) {
          displayName = svc.name;
          icon = svc.icon || icon;
        }
      } else {
        const basePath = proc.path.split(/[?#]/)[0];
        const homePath = this.configManager.homePath();
        const appInfo = this.appRegistry.getAllApps().find((a) => a.path === basePath);
        if (appInfo) {
          displayName = appInfo.name;
          icon = appInfo.icon || icon;
        } else if (basePath === homePath) {
          displayName = 'Dashboard';
          icon = '🏠';
        }
      }

      const row = document.createElement('div');
      row.dataset.pid = proc.pid;
      row.className = `flex items-center justify-between p-3 rounded-xl border transition ${isForeground ? 'border-primary/50 bg-primary/5 shadow-sm' : 'border-border-main bg-panel hover:border-primary/30'}`;

      row.innerHTML = `
        <div class="flex items-center gap-4 overflow-hidden">
          <div class="w-10 h-10 bg-card rounded-xl flex items-center justify-center text-2xl shadow-inner shrink-0">${icon}</div>
          <div class="flex flex-col min-w-0">
            <div class="flex items-center gap-2 mb-1">
              <span class="font-bold text-sm text-text-main truncate">${displayName}</span>
              <span class="text-[0.625rem] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${badgeColor}">${proc.state}</span>
              ${ownerBadgeHTML(proc.engine || ROOT_ENGINE_ID)}
            </div>
            <div class="text-[0.625rem] text-text-muted font-mono truncate" title="${proc.path}">${proc.path} ${displayName !== proc.pid && !isDaemon ? `(${proc.pid})` : ''}</div>
          </div>
        </div>
      `;

      const btnKill = document.createElement('button');
      btnKill.className =
        'shrink-0 w-8 h-8 flex items-center justify-center rounded-lg bg-card hover:bg-error/20 text-text-muted hover:text-error border border-border-main transition';
      btnKill.innerHTML = '✕';
      btnKill.onclick = () => {
        this.processManager.kill(USER_MOVER, proc.pid);
        this._renderList(); // 即時反映
      };

      row.appendChild(btnKill);
      this.listContainer!.appendChild(row);
    });
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
