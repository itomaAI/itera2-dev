/**
 * src/shell/modals/CommandPaletteModal.ts
 * Itera OS v2: Command Palette Modal
 */

import type { VfsService } from '../../core/vfs/VfsService';
import type { AppRegistry } from '../../core/sys/AppRegistry';
import type { UriRouter } from '../core/UriRouter';
import type { Principal, VfsStat } from '../../core/vfs/types';

export interface CommandItem {
  id: string;
  title: string;
  subtitle: string;
  icon: string;
  score: number;
  action: () => void;
}

export class CommandPaletteModal {
  private vfs: VfsService;
  private appRegistry: AppRegistry;
  private uriRouter: UriRouter;
  private getActivePrincipal: () => Principal;
  private events: Record<string, Function> = {};

  private overlay: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private listContainer: HTMLElement | null = null;

  private isOpen = false;
  private currentItems: CommandItem[] = [];
  private selectedIndex = 0;

  constructor(vfs: VfsService, appRegistry: AppRegistry, uriRouter: UriRouter, getActivePrincipal: () => Principal) {
    this.vfs = vfs;
    this.appRegistry = appRegistry;
    this.uriRouter = uriRouter;
    this.getActivePrincipal = getActivePrincipal;
  }

  on(event: string, callback: Function) {
    this.events[event] = callback;
  }

  private _createDOM() {
    if (this.overlay) return;

    this.overlay = document.createElement('div');
    this.overlay.className =
      'fixed inset-0 bg-black/60 backdrop-blur-sm z-[10001] flex items-start justify-center pt-[15vh] itera-animate-fade select-none';

    this.overlay.onclick = (e) => {
      if (e.target === this.overlay) this.close();
    };

    const box = document.createElement('div');
    box.className =
      'bg-panel border border-border-main rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col overflow-hidden';

    // Header (Input)
    const header = document.createElement('div');
    header.className = 'flex items-center px-5 border-b border-border-main bg-card/50';

    const searchIcon = document.createElement('div');
    searchIcon.className = 'text-text-muted text-xl mr-3';
    searchIcon.innerHTML = '🔍';

    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.placeholder = 'Search files, apps, or ask AI...';
    this.input.className =
      'w-full bg-transparent border-none py-5 text-xl font-bold text-text-main focus:outline-none placeholder-text-muted/50';
    this.input.setAttribute('spellcheck', 'false');
    this.input.setAttribute('autocomplete', 'off');

    header.appendChild(searchIcon);
    header.appendChild(this.input);

    // List Container
    this.listContainer = document.createElement('div');
    this.listContainer.className = 'max-h-[50vh] overflow-y-auto flex flex-col p-2 bg-app';

    // Footer
    const footer = document.createElement('div');
    footer.className = 'px-5 py-3 border-t border-border-main bg-card flex items-center justify-between shrink-0';
    footer.innerHTML = `
      <div class="text-[10px] text-text-muted font-bold tracking-wider flex items-center gap-4">
        <span><kbd class="bg-panel px-1.5 py-0.5 rounded border border-border-main font-mono text-text-main shadow-sm">↑</kbd> <kbd class="bg-panel px-1.5 py-0.5 rounded border border-border-main font-mono text-text-main shadow-sm">↓</kbd> Navigate</span>
        <span><kbd class="bg-panel px-1.5 py-0.5 rounded border border-border-main font-mono text-text-main shadow-sm">Enter</kbd> Select</span>
        <span><kbd class="bg-panel px-1.5 py-0.5 rounded border border-border-main font-mono text-text-main shadow-sm">Esc</kbd> Close</span>
      </div>
      <div class="text-[10px] text-text-muted font-mono uppercase tracking-widest font-bold">Itera OS</div>
    `;

    box.appendChild(header);
    box.appendChild(this.listContainer);
    box.appendChild(footer);
    this.overlay.appendChild(box);
    document.body.appendChild(this.overlay);

    this._bindInputEvents();
  }

  private _bindInputEvents() {
    if (!this.input) return;

    this.input.addEventListener('input', () => {
      this._updateSearch();
    });

    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.selectedIndex = Math.min(this.selectedIndex + 1, this.currentItems.length - 1);
        this._renderList();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
        this._renderList();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (this.currentItems[this.selectedIndex]) {
          this.currentItems[this.selectedIndex].action();
          this.close();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  open() {
    this._createDOM();
    if (this.overlay && this.input) {
      this.input.value = '';
      this._updateSearch();
      this.overlay.classList.remove('hidden');
      this.input.focus();
      this.isOpen = true;
    }
  }

  close() {
    if (this.overlay) {
      this.overlay.classList.add('hidden');
      this.isOpen = false;
      if (this.input) this.input.blur();
    }
  }

  private _updateSearch() {
    if (!this.input) return;
    const query = this.input.value.trim().toLowerCase();

    let items: CommandItem[] = [];

    if (!query) {
      items = this._getDefaultItems();
    } else {
      items = this._getFilteredItems(query);
    }

    this.currentItems = items.sort((a, b) => b.score - a.score).slice(0, 50); // 上位50件
    this.selectedIndex = 0;
    this._renderList();
  }

  private _getDefaultItems(): CommandItem[] {
    const items: CommandItem[] = [];

    // System commands
    items.push({
      id: 'sys-settings',
      title: 'System Settings',
      subtitle: 'Preferences, Theme, LLM, Network',
      icon: '⚙️',
      score: 100,
      action: () => this.uriRouter.dispatch('metaos://system/settings'),
    });
    items.push({
      id: 'sys-api-keys',
      title: 'API Keys',
      subtitle: 'Manage LLM API Secrets',
      icon: '🔑',
      score: 99,
      action: () => this.uriRouter.dispatch('metaos://system/api_keys'),
    });
    items.push({
      id: 'sys-monitor',
      title: 'Activity Monitor',
      subtitle: 'View background processes',
      icon: '📊',
      score: 98,
      action: () => this.uriRouter.dispatch('metaos://system/monitor'),
    });

    // Apps
    const apps = this.appRegistry.getAllApps();
    apps.forEach((app) => {
      items.push({
        id: `app-${app.id}`,
        title: app.name,
        subtitle: `App • ${app.path}`,
        icon: app.icon || '📱',
        score: 90,
        action: () => this.uriRouter.dispatch(`metaos://run/${app.path}`),
      });
    });

    return items;
  }

  private _getFilteredItems(query: string): CommandItem[] {
    const items: CommandItem[] = [];
    const queryTerms = query.split(/\s+/);

    const scoreMatch = (text: string, terms: string[]) => {
      let score = 0;
      const lowerText = text.toLowerCase();
      for (const term of terms) {
        if (lowerText === term) score += 10;
        else if (lowerText.startsWith(term)) score += 5;
        else if (lowerText.includes(term)) score += 1;
      }
      return score;
    };

    // 1. System Commands
    const sysCmds = [
      {
        id: 'sys-settings',
        title: 'System Settings',
        sub: 'Preferences, Theme, LLM, Network',
        icon: '⚙️',
        uri: 'metaos://system/settings',
      },
      {
        id: 'sys-api-keys',
        title: 'API Keys',
        sub: 'Manage LLM API Secrets',
        icon: '🔑',
        uri: 'metaos://system/api_keys',
      },
      {
        id: 'sys-monitor',
        title: 'Activity Monitor',
        sub: 'View background processes',
        icon: '📊',
        uri: 'metaos://system/monitor',
      },
    ];
    sysCmds.forEach((cmd) => {
      const score = scoreMatch(cmd.title + ' ' + cmd.sub, queryTerms);
      if (score > 0) {
        items.push({
          id: cmd.id,
          title: cmd.title,
          subtitle: cmd.sub,
          icon: cmd.icon,
          score: score + 50,
          action: () => this.uriRouter.dispatch(cmd.uri),
        });
      }
    });

    // 2. Apps
    const apps = this.appRegistry.getAllApps();
    apps.forEach((app) => {
      const score = scoreMatch(app.name + ' ' + app.path + ' ' + (app.description || ''), queryTerms);
      if (score > 0) {
        items.push({
          id: `app-${app.id}`,
          title: app.name,
          subtitle: `App • ${app.path}`,
          icon: app.icon || '📱',
          score: score + 40,
          action: () => this.uriRouter.dispatch(`metaos://run/${app.path}`),
        });
      }
    });

    // 3. Files
    const files = this.vfs.listFiles(this.getActivePrincipal(), {
      recursive: true,
      detail: true,
    }) as VfsStat[];
    files.forEach((stat) => {
      if (stat.kind === 'directory') return; // ファイルのみ検索
      const score = scoreMatch(stat.name + ' ' + stat.path, queryTerms);
      if (score > 0) {
        let icon = '📄';
        if (stat.name.endsWith('.md')) icon = '📝';
        else if (stat.name.endsWith('.json')) icon = '🔧';
        else if (stat.name.endsWith('.html')) icon = '🌐';
        else if (stat.name.endsWith('.js') || stat.name.endsWith('.ts')) icon = '📜';
        else if (stat.name.match(/\.(png|jpg|jpeg|svg|gif|webp)$/i)) icon = '🖼️';

        items.push({
          id: `file-${stat.id}`,
          title: stat.name,
          subtitle: `File • /${stat.path}`,
          icon: icon,
          score: score,
          action: () => this.uriRouter.dispatch(`metaos://open/${stat.path}`),
        });
      }
    });

    // 4. AI Ask
    items.push({
      id: 'ai-ask',
      title: `Ask AI: "${this.input!.value.trim()}"`,
      subtitle: 'Itera Agent',
      icon: '✨',
      score: 1000, // 常にトップに出す
      action: () => {
        if (this.events['ask_ai']) this.events['ask_ai'](this.input!.value.trim());
      },
    });

    return items;
  }

  private _renderList() {
    if (!this.listContainer) return;
    this.listContainer.innerHTML = '';

    if (this.currentItems.length === 0) {
      this.listContainer.innerHTML = `<div class="p-4 text-center text-sm text-text-muted">No results found.</div>`;
      return;
    }

    this.currentItems.forEach((item, index) => {
      const el = document.createElement('div');
      const isSelected = index === this.selectedIndex;
      el.className = `flex items-center gap-4 p-3 rounded-lg cursor-pointer transition ${isSelected ? 'bg-primary text-white shadow-md' : 'text-text-main hover:bg-hover'}`;

      // アイコンにAI Ask専用の特別スタイルを当てる
      const iconClass = item.id === 'ai-ask' ? 'text-warning animate-pulse text-2xl' : 'text-2xl';
      const titleClass = isSelected ? 'text-white' : item.id === 'ai-ask' ? 'text-primary' : 'text-text-main';

      el.innerHTML = `
        <div class="${iconClass}">${item.icon}</div>
        <div class="flex flex-col min-w-0">
          <div class="text-sm font-bold truncate ${titleClass}">${item.title}</div>
          <div class="text-[10px] font-mono truncate opacity-80 ${isSelected ? 'text-white/80' : 'text-text-muted'}">${item.subtitle}</div>
        </div>
        ${isSelected ? '<div class="ml-auto text-xs opacity-70">↵</div>' : ''}
      `;

      el.onclick = () => {
        item.action();
        this.close();
      };

      this.listContainer!.appendChild(el);

      if (isSelected) {
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    });
  }
}
