/**
 * src/shell/modals/TaskSwitcherModal.ts
 * Itera OS v2: Recent Apps / Task Switcher
 */

import type { ProcessManager } from '../windowing/ProcessManager';
import type { AppRegistry } from '../../core/sys/AppRegistry';

const DOM_IDS = {
  MODAL: 'task-switcher-modal',
  GRID: 'task-switcher-grid',
  BTN_OPEN: 'btn-tasks',
  BTN_CLOSE: 'btn-close-tasks',
};

export class TaskSwitcherModal {
  private els: Record<string, HTMLElement | null> = {};
  private processManager: ProcessManager;
  private appRegistry: AppRegistry;

  constructor(processManager: ProcessManager, appRegistry: AppRegistry) {
    this.processManager = processManager;
    this.appRegistry = appRegistry;

    this._initElements();
    this._bindEvents();
  }

  private _initElements(): void {
    for (const [key, id] of Object.entries(DOM_IDS)) {
      this.els[key] = document.getElementById(id);
    }
  }

  private _bindEvents(): void {
    if (this.els.BTN_OPEN) {
      this.els.BTN_OPEN.onclick = () => this.open();
    }
    if (this.els.BTN_CLOSE) {
      this.els.BTN_CLOSE.onclick = () => this.close();
    }
    if (this.els.MODAL) {
      this.els.MODAL.onclick = (e) => {
        // モーダルの背景、またはカード間の余白をクリックした場合に閉じる
        if (e.target === this.els.MODAL || e.target === this.els.GRID) {
          this.close();
        }
      };
    }
  }

  open(): void {
    if (this.els.MODAL) {
      this._renderGrid();
      this.els.MODAL.classList.remove('hidden');
    }
  }

  close(): void {
    if (this.els.MODAL) {
      this.els.MODAL.classList.add('hidden');
    }
  }

  private _renderGrid(): void {
    const grid = this.els.GRID;
    if (!grid) return;
    grid.innerHTML = '';

    const apps = Array.from(this.processManager.processes.values())
      .filter((p) => p.type === 'app')
      .sort((a, b) => b.lastActiveTime - a.lastActiveTime);

    if (apps.length === 0) {
      grid.innerHTML = '<div class="text-white/50 text-center w-full mt-10 text-sm">No recent apps</div>';
      return;
    }

    const allRegisteredApps = this.appRegistry.getAllApps();

    apps.forEach((app) => {
      const card = document.createElement('div');
      card.className =
        'snap-center shrink-0 w-28 sm:w-36 flex flex-col items-center gap-3 transition-transform hover:scale-105 group relative';

      const basePath = app.path.split(/[?#]/)[0];

      // レジストリからアプリ情報を検索してアイコンや名前をリッチにする
      let appName = basePath.split('/').pop()?.replace('.html', '') || 'App';
      let appIcon = '⚙️';

      if (basePath === 'apps/home.html') {
        appName = 'Dashboard';
        appIcon = '🏠';
      } else {
        const regInfo = allRegisteredApps.find((r) => r.path === basePath);
        if (regInfo) {
          appName = regInfo.name;
          appIcon = regInfo.icon;
        }
      }

      const iconWrapper = document.createElement('div');
      const activeRing =
        app.state === 'foreground'
          ? 'border-primary ring-4 ring-primary/30'
          : 'border-border-main group-hover:border-primary/50';
      iconWrapper.className = `w-24 h-24 sm:w-32 sm:h-32 bg-card rounded-3xl border-2 flex items-center justify-center text-5xl sm:text-6xl shadow-xl relative cursor-pointer transition-colors ${activeRing}`;
      iconWrapper.innerHTML = `<span>${appIcon}</span>`;

      const title = document.createElement('div');
      title.className =
        'text-white font-bold tracking-wide capitalize drop-shadow-md text-sm truncate w-full text-center';
      title.textContent = appName;

      const btnKill = document.createElement('button');
      btnKill.className =
        'absolute -top-2 -right-2 w-8 h-8 bg-error hover:bg-error/80 text-white rounded-full shadow-lg flex items-center justify-center opacity-0 md:opacity-0 group-hover:opacity-100 transition-opacity z-10 font-bold text-sm border-2 border-white/20';
      btnKill.innerHTML = '✕';

      // アプリをクリックして切り替え
      iconWrapper.onclick = () => {
        // フォアグラウンドモードで起動 (ProcessManager 側で再利用/前面引き上げを判断)
        this.processManager.spawn(app.pid, app.path, 'foreground', false, app.args);
        this.close();
      };

      // ✕ボタンをクリックしてプロセス終了
      btnKill.onclick = (e) => {
        e.stopPropagation();
        this.processManager.kill(app.pid);
        this._renderGrid(); // 即時再描画
      };

      iconWrapper.appendChild(btnKill);
      card.appendChild(iconWrapper);
      card.appendChild(title);
      grid.appendChild(card);
    });
  }
}
