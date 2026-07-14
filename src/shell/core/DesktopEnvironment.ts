/**
 * src/shell/core/DesktopEnvironment.ts
 * Itera OS v2: UI & Presentation Layer Manager
 */

import type { VfsService } from '../../core/vfs/VfsService';
import type { NodeStore } from '../../core/vfs/NodeStore';
import type { ContentStore } from '../../core/vfs/ContentStore';
import type { VfsEventBus } from '../../core/vfs/VfsEventBus';
import type { AppRegistry } from '../../core/sys/AppRegistry';
import type { FileAssociationResolver } from '../../core/sys/FileAssociationResolver';
import type { ProcessManager } from '../windowing/ProcessManager';
import type { UriRouter } from './UriRouter';
import type { CognitiveManager } from '../services/CognitiveManager';

// Panels
import { SYSTEM_PRINCIPAL, USER_PRINCIPAL, type Principal } from '../../core/vfs/types';

// Panels
import { Explorer } from '../panels/Explorer';
import { ChatPanel } from '../panels/ChatPanel';
// Modals
import { EditorModal } from '../modals/EditorModal';
import { MediaViewer } from '../modals/MediaViewer';
import { SystemModal } from '../modals/SystemModal';
import { ApiSettingsModal } from '../modals/ApiSettingsModal';
import { SyncModal } from '../modals/SyncModal';
import { TaskSwitcherModal } from '../modals/TaskSwitcherModal';
import { CameraModal } from '../modals/CameraModal';
import { AudioModal } from '../modals/AudioModal';
import { ProcessMonitorModal } from '../modals/ProcessMonitorModal';
import { PropertiesModal } from '../modals/PropertiesModal';
import { CommandPaletteModal } from '../modals/CommandPaletteModal';
// Services
import { LpmlRenderer } from '../services/LpmlRenderer';

export class DesktopEnvironment {
  // Components
  public readonly explorer: Explorer;
  public readonly chatPanel: ChatPanel;
  public readonly commandPalette: CommandPaletteModal;

  private _editorModal: EditorModal;
  private _mediaViewer: MediaViewer;
  private _cameraModal: CameraModal;
  private _audioModal: AudioModal;
  private _systemModal: SystemModal;
  private _apiSettingsModal: ApiSettingsModal;
  private _syncModal: SyncModal;
  private _taskSwitcherModal: TaskSwitcherModal;
  private _processMonitorModal: ProcessMonitorModal;
  private _propertiesModal: PropertiesModal;

  private saveFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  private activePrincipal: Principal = USER_PRINCIPAL;
  public isSudoMode: boolean = false;

  constructor(
    vfs: VfsService,
    nodeStore: NodeStore,
    contentStore: ContentStore,
    eventBus: VfsEventBus,
    appRegistry: AppRegistry,
    resolver: FileAssociationResolver,
    processManager: ProcessManager,
    uriRouter: UriRouter,
    cognitiveManager: CognitiveManager,
  ) {
    const lpmlRenderer = new LpmlRenderer();

    // Panels
    this.chatPanel = new ChatPanel(lpmlRenderer);
    this.chatPanel.setVfs(vfs);
    this.chatPanel.setPrincipalProvider(() => this.getActivePrincipal());
    this.explorer = new Explorer(vfs, eventBus, resolver, () => this.getActivePrincipal());

    // Modals
    this._editorModal = new EditorModal();
    this._mediaViewer = new MediaViewer();
    this._cameraModal = new CameraModal();
    this._audioModal = new AudioModal();
    this._systemModal = new SystemModal(vfs, nodeStore, contentStore);

    // ApiSettingsModal は duck typing で CognitiveManager を渡す (getMergedProviders を持つため)
    this._apiSettingsModal = new ApiSettingsModal(cognitiveManager);
    this._syncModal = new SyncModal();
    this._taskSwitcherModal = new TaskSwitcherModal(processManager, appRegistry);
    this._processMonitorModal = new ProcessMonitorModal(processManager);
    this._propertiesModal = new PropertiesModal(vfs);
    this.commandPalette = new CommandPaletteModal(vfs, appRegistry, uriRouter, () => this.getActivePrincipal());

    this._bindMobileNavigation();
    this._bindCommandPaletteShortcut();
    this._bindSudoToggle();
  }

  public getActivePrincipal(): Principal {
    return this.activePrincipal;
  }

  // --- Getters for HostApiRouter and Orchestrator ---

  public get panels() {
    return {
      chat: this.chatPanel,
      explorer: this.explorer,
    };
  }

  public get modals() {
    return {
      editor: this._editorModal,
      media: this._mediaViewer, // ★ バグ修正: media が公開されるように追加
      camera: this._cameraModal,
      audio: this._audioModal,
      system: this._systemModal,
      apiSettings: this._apiSettingsModal,
      sync: this._syncModal,
      taskSwitcher: this._taskSwitcherModal,
      processMonitor: this._processMonitorModal,
      properties: this._propertiesModal,
    };
  }

  // --- UI Manipulation Methods ---

  public updateStorageUI(usage: { used: number; max: number; percent: number }): void {
    const bar = document.getElementById('storage-usage-bar');
    const text = document.getElementById('storage-usage-text');
    if (!bar || !text) return;

    const usedMB = (usage.used / 1024 / 1024).toFixed(1);
    const maxMB = (usage.max / 1024 / 1024).toFixed(1);

    text.textContent = `${usedMB} / ${maxMB} MB`;
    bar.style.width = `${usage.percent}%`;

    bar.classList.remove('bg-primary', 'bg-warning', 'bg-error', 'animate-pulse');
    text.classList.remove('text-error', 'font-bold');

    if (usage.percent > 95) {
      bar.classList.add('bg-error', 'animate-pulse');
      text.classList.add('text-error', 'font-bold');
    } else if (usage.percent > 80) {
      bar.classList.add('bg-warning');
    } else {
      bar.classList.add('bg-primary');
    }
  }

  public triggerAutoSaveFeedback(): void {
    const bar = document.getElementById('storage-usage-bar');
    const statusEl = document.getElementById('save-status');

    if (this.saveFeedbackTimer) clearTimeout(this.saveFeedbackTimer);

    if (bar) {
      bar.classList.add('brightness-150', 'shadow-[0_0_8px_rgba(255,255,255,0.6)]');
    }

    if (statusEl) {
      statusEl.classList.remove('opacity-0');
      statusEl.textContent = 'Saved';
      statusEl.className = 'text-[9px] text-success italic transition-opacity';
    }

    this.saveFeedbackTimer = setTimeout(() => {
      if (bar) {
        bar.classList.remove('brightness-150', 'shadow-[0_0_8px_rgba(255,255,255,0.6)]');
      }
      if (statusEl) {
        statusEl.classList.add('opacity-0');
      }
    }, 300);
  }

  public updateAddressBar(uri: string): void {
    const addressBar = document.getElementById('preview-address-bar') as HTMLInputElement;
    if (addressBar) {
      addressBar.value = uri;
    }
  }

  public closeMobileDrawers(): void {
    const btnView = document.getElementById('mobile-nav-view');
    if (btnView) {
      btnView.click();
    }
  }

  // --- Internal Binding ---

  private _bindMobileNavigation(): void {
    const btnFiles = document.getElementById('mobile-nav-files');
    const btnChat = document.getElementById('mobile-nav-chat');
    const btnView = document.getElementById('mobile-nav-view');
    const overlay = document.getElementById('mobile-overlay');
    const sidebar = document.getElementById('sidebar');
    const chatPanel = document.getElementById('chat-panel');

    if (!btnFiles) return;

    const reset = () => {
      if (sidebar) {
        sidebar.classList.remove('translate-x-0');
        sidebar.classList.add('-translate-x-full');
      }
      if (chatPanel) {
        chatPanel.classList.remove('translate-x-0');
        chatPanel.classList.add('translate-x-full');
      }
      if (overlay) overlay.classList.add('hidden');

      [btnFiles, btnChat, btnView].forEach((b) => {
        if (b) {
          b.classList.remove('text-primary', 'font-bold', 'bg-hover');
          b.classList.add('text-text-muted');
        }
      });
    };

    const activate = (btn: HTMLElement | null) => {
      if (!btn) return;
      btn.classList.remove('text-text-muted');
      btn.classList.add('text-primary', 'font-bold', 'bg-hover');
    };

    btnFiles.onclick = () => {
      reset();
      activate(btnFiles);
      if (sidebar) {
        sidebar.classList.remove('-translate-x-full');
        sidebar.classList.add('translate-x-0');
      }
      if (overlay) overlay.classList.remove('hidden');
    };

    if (btnChat) {
      btnChat.onclick = () => {
        reset();
        activate(btnChat);
        if (chatPanel) {
          chatPanel.classList.remove('translate-x-full');
          chatPanel.classList.add('translate-x-0');
        }
        if (overlay) overlay.classList.remove('hidden');
      };
    }

    if (btnView) {
      btnView.onclick = () => {
        reset();
        activate(btnView);
      };
    }

    if (overlay) {
      overlay.onclick = () => {
        reset();
        activate(btnView);
      };
    }
  }

  private _bindCommandPaletteShortcut(): void {
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        this.commandPalette.toggle();
      }
    });
  }

  private _bindSudoToggle(): void {
    const btnSudo = document.getElementById('btn-sudo');
    if (btnSudo) {
      btnSudo.onclick = () => this._toggleSudoMode();
    }
  }

  private async _toggleSudoMode(): Promise<void> {
    if (this.isSudoMode) {
      this.isSudoMode = false;
      this.activePrincipal = USER_PRINCIPAL;
      this._updateSudoUI();
      if (window.AppUI) window.AppUI.notify('System privileges disabled.', 'info');
    } else {
      const confirmed = await window.AppUI?.confirm(
        'WARNING: Enabling System Privileges (Sudo) allows you to modify or delete core OS files.\\n\\nIncorrect actions may break the system. Are you sure you want to proceed?',
        'Enable Sudo Mode'
      );
      if (confirmed) {
        this.isSudoMode = true;
        this.activePrincipal = SYSTEM_PRINCIPAL;
        this._updateSudoUI();
        if (window.AppUI) window.AppUI.notify('System privileges enabled.', 'warning');
      }
    }
  }

  private _updateSudoUI(): void {
    const btn = document.getElementById('btn-sudo');
    if (!btn) return;
    
    if (this.isSudoMode) {
      btn.classList.add('text-error', 'bg-error/10');
      btn.classList.remove('text-text-muted', 'hover:text-warning');
      btn.title = 'Disable System Privileges';
      btn.innerHTML = `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z"></path></svg>`;
    } else {
      btn.classList.remove('text-error', 'bg-error/10');
      btn.classList.add('text-text-muted', 'hover:text-warning');
      btn.title = 'Enable System Privileges';
      btn.innerHTML = `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path></svg>`;
    }
  }
}
