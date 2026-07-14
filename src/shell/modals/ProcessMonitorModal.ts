/**
 * src/shell/modals/ProcessMonitorModal.ts
 * Itera OS v2: Process Monitor (Activity Monitor) Modal
 *
 * ※ index.html を汚さないよう、DOM は TypeScript から動的に生成します。
 */

import type { ProcessManager } from '../windowing/ProcessManager';
import type { AppRegistry } from '../../core/sys/AppRegistry';

export class ProcessMonitorModal {
  private processManager: ProcessManager;
  private appRegistry: AppRegistry;
  private overlay: HTMLElement | null = null;
  private listContainer: HTMLElement | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private isOpen: boolean = false;

  constructor(processManager: ProcessManager, appRegistry: AppRegistry) {
    this.processManager = processManager;
    this.appRegistry = appRegistry;
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
          <h2 class="font-bold text-text-main text-base leading-tight">Activity Monitor</h2>
          <div class="text-[10px] text-text-muted font-mono uppercase tracking-widest mt-0.5">Real-time Process List</div>
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
    btnKillAll.innerText = 'Kill All Daemons';
    btnKillAll.onclick = async () => {
      const confirmed = await window.AppUI?.confirm('Are you sure you want to kill all background daemons?');
      if (confirmed) {
        const procs = this.processManager.list();
        procs.forEach((p) => {
          if (p.type === 'daemon') this.processManager.kill(p.pid);
        });
        this._renderList();
      }
    };

    footer.appendChild(statusText);
    footer.appendChild(btnKillAll);

    box.appendChild(header);
    box.appendChild(this.listContainer);
    box.appendChild(footer);
    this.overlay.appendChild(box);

    document.body.appendChild(this.overlay);
  }

  private _renderList(): void {
    if (!this.listContainer) return;

    const processes = this.processManager.list();

    // Sort: Foreground -> Background App -> Daemon
    processes.sort((a, b) => {
      const getScore = (p: any) => (p.state === 'foreground' ? 3 : p.type === 'app' ? 2 : 1);
      return getScore(b) - getScore(a);
    });

    this.listContainer.innerHTML = '';

    if (processes.length === 0) {
      this.listContainer.innerHTML = `<div class="flex items-center justify-center h-32 text-sm text-text-muted">No processes running.</div>`;
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
        const svc = this.appRegistry.getService(proc.pid);
        if (svc) {
          displayName = svc.name;
          icon = svc.icon || icon;
        }
      } else {
        const basePath = proc.path.split(/[?#]/)[0];
        const appInfo = this.appRegistry.getAllApps().find((a) => a.path === basePath);
        if (appInfo) {
          displayName = appInfo.name;
          icon = appInfo.icon || icon;
        } else if (basePath === 'apps/home.html') {
          displayName = 'Dashboard';
          icon = '🏠';
        }
      }

      const row = document.createElement('div');
      row.className = `flex items-center justify-between p-3 rounded-xl border transition ${isForeground ? 'border-primary/50 bg-primary/5 shadow-sm' : 'border-border-main bg-panel hover:border-primary/30'}`;

      row.innerHTML = `
        <div class="flex items-center gap-4 overflow-hidden">
          <div class="w-10 h-10 bg-card rounded-xl flex items-center justify-center text-2xl shadow-inner shrink-0">${icon}</div>
          <div class="flex flex-col min-w-0">
            <div class="flex items-center gap-2 mb-1">
              <span class="font-bold text-sm text-text-main truncate">${displayName}</span>
              <span class="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${badgeColor}">${proc.state}</span>
            </div>
            <div class="text-[10px] text-text-muted font-mono truncate" title="${proc.path}">${proc.path} ${displayName !== proc.pid && !isDaemon ? `(${proc.pid})` : ''}</div>
          </div>
        </div>
      `;

      const btnKill = document.createElement('button');
      btnKill.className =
        'shrink-0 w-8 h-8 flex items-center justify-center rounded-lg bg-card hover:bg-error/20 text-text-muted hover:text-error border border-border-main transition';
      btnKill.innerHTML = '✕';
      btnKill.onclick = () => {
        this.processManager.kill(proc.pid);
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
