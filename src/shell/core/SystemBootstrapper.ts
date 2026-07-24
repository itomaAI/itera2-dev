/**
 * src/shell/core/SystemBootstrapper.ts
 * Itera OS v2: System Bootstrapper and DI Container
 */

// VFS Subsystem
import { NodeStore } from '../../core/vfs/NodeStore';
import { ContentStore } from '../../core/vfs/ContentStore';
import { PathResolver } from '../../core/vfs/PathResolver';
import { VfsEventBus } from '../../core/vfs/VfsEventBus';
import { VfsService } from '../../core/vfs/VfsService';
import { VfsInitializer } from '../../core/vfs/VfsInitializer';

// System Core & State
import { ConfigManager } from '../../core/sys/ConfigManager';
import { AppRegistry } from '../../core/sys/AppRegistry';
import { FileAssociationResolver } from '../../core/sys/FileAssociationResolver';
import { HistoryManager } from '../../core/state/HistoryManager';
import { SystemLogger } from '../../core/state/SystemLogger';

// Control & Cognitive
import { ToolRegistry } from '../../core/control/ToolRegistry';
import { ToolExecutionRecorder } from '../../core/control/ToolExecutionRecorder';
import { Engine } from '../../core/control/Engine';
import { Translator } from '../../core/cognitive/Translator';
import { registerBasicTools } from '../../core/control/tools/basic_tools';
import { registerFSTools } from '../../core/control/tools/fs_tools';
import { registerSearchTools } from '../../core/control/tools/search_tools';
import { registerSysTools } from '../../core/control/tools/sys_tools';
import { registerUITools } from '../../core/control/tools/ui_tools';

// Windowing & IPC
import { ProcessManager } from '../windowing/ProcessManager';
import { HostTransport } from '../../ipc/HostTransport';
import { HostApiRouter } from '../../api/HostApiRouter';

// Shell Core & Services
import { UriRouter } from './UriRouter';
import { DesktopEnvironment } from './DesktopEnvironment';
import { EventOrchestrator } from './EventOrchestrator';
import { CognitiveManager } from '../services/CognitiveManager';
import { SessionManager } from '../services/SessionManager';
import { ThemeService } from '../services/ThemeService';
import { MaintenanceDaemon } from '../services/MaintenanceDaemon';
import { DialogService } from '../services/DialogService';
import { VfsEventRecorder } from '../services/VfsEventRecorder';
import { ProcessEventRecorder } from '../services/ProcessEventRecorder';
import { HostGuestToolInvoker } from '../services/HostGuestToolInvoker';
import { ProviderManager } from '../../core/vfs/ProviderManager';
import { HistoryEventRecorder } from '../services/HistoryEventRecorder';

export class SystemBootstrapper {
  public static async boot(): Promise<void> {
    console.log('[Itera] Booting OS v2...');

    // ==========================================
    // 0. UI Dialog Service Initialization
    // ==========================================
    const dialogService = new DialogService();
    window.AppUI = dialogService;

    // ==========================================
    // 1. VFS Subsystem Initialization
    // ==========================================
    const nodeStore = new NodeStore();
    const contentStore = new ContentStore();
    const pathResolver = new PathResolver(nodeStore);
    const eventBus = new VfsEventBus();
    const vfs = new VfsService(nodeStore, contentStore, pathResolver, eventBus);

    await nodeStore.loadAll();

    const initializer = new VfsInitializer(vfs, nodeStore, pathResolver);
    await initializer.initialize();

    // ==========================================
    // 2. System State & Registry Initialization
    // ==========================================
    const configManager = new ConfigManager(vfs, eventBus);
    await configManager.loadAll();

    const appRegistry = new AppRegistry(vfs, eventBus);
    await appRegistry.loadAll();

    const resolver = new FileAssociationResolver(vfs, appRegistry, eventBus);
    await resolver.loadAssociations();

    const history = new HistoryManager();
    await history.loadFromDB();

    const logger = new SystemLogger(vfs);

    // ==========================================
    // 3. Control Layer Initialization
    // ==========================================
    const toolExecutionRecorder = new ToolExecutionRecorder(logger);
    const toolRegistry = new ToolRegistry(appRegistry, toolExecutionRecorder);
    registerBasicTools(toolRegistry);
    registerFSTools(toolRegistry);
    registerSearchTools(toolRegistry);
    registerSysTools(toolRegistry);
    registerUITools(toolRegistry);

    const translator = new Translator();
    const processManager = new ProcessManager(vfs, appRegistry);
    const uriRouter = new UriRouter('open');

    // ==========================================
    // 4. Shell Services & UI Layer
    // ==========================================
    // Engineの初期化 (AdapterとProjectorはCognitiveManagerが後で注入)
    const engine = new Engine({ history, vfs, configManager }, null, null, translator, toolRegistry, {});

    const cognitiveManager = new CognitiveManager(configManager, engine, logger, vfs);
    const sessionManager = new SessionManager(vfs, history, logger, toolRegistry);
    const themeService = new ThemeService(configManager, vfs);
    const maintenanceDaemon = new MaintenanceDaemon(processManager, logger, vfs, nodeStore);

    const desktop = new DesktopEnvironment(
      vfs,
      nodeStore,
      contentStore,
      eventBus,
      appRegistry,
      resolver,
      processManager,
      uriRouter,
      cognitiveManager,
    );

    // ==========================================
    // 5. IPC Routing & Event Orchestration
    // ==========================================
    const transport = new HostTransport();
    toolRegistry.setGuestToolInvoker(new HostGuestToolInvoker(processManager, transport));

    // プロバイダマネージャーの初期化と VFS への注入
    const providerManager = new ProviderManager(eventBus, transport, processManager, pathResolver);
    vfs.setProviderManager(providerManager);

    // セキュリティ: PID偽装防止のための発信元検証
    transport.setSourceValidator((pid: string, sourceWindow: Window) => {
      const proc = processManager.processes.get(pid);
      if (!proc || !proc.iframe) return false;
      return proc.iframe.contentWindow === sourceWindow;
    });

    // HostApiRouterや各種Toolが要求するインターフェースをエミュレートするFacade
    const shellFacade = {
      panels: desktop.panels,
      modals: desktop.modals,
      _refreshEngineConfig: () => cognitiveManager.refreshEngineConfig(),
      _closeMobileDrawers: () => desktop.closeMobileDrawers(),
      getMergedProviders: () => cognitiveManager.getMergedProviders(),
      processManager: processManager,
      resolver: resolver,
      transport: transport,
      clearSession: (opts: any) => sessionManager.clearSession(opts),
    };

    // EngineコンテキストにもFacadeを注入
    engine.extraContext.shell = shellFacade;

    new HostApiRouter(transport, {
      vfs,
      configManager,
      processManager,
      history,
      engine,
      toolRegistry,
      shell: shellFacade as any,
    });

    const orchestrator = new EventOrchestrator(
      desktop,
      vfs,
      history,
      engine,
      processManager,
      uriRouter,
      sessionManager,
      cognitiveManager,
      resolver,
      eventBus,
    );

    // VfsEventRecorder の初期化と起動
    const vfsEventRecorder = new VfsEventRecorder(eventBus, logger);
    vfsEventRecorder.start();

    // ProcessEventRecorder の初期化と起動
    const processEventRecorder = new ProcessEventRecorder(processManager, logger);
    processEventRecorder.start();

    // HistoryEventRecorder の初期化と起動
    const historyEventRecorder = new HistoryEventRecorder(history, logger);
    historyEventRecorder.start();

    // ==========================================
    // 6. Final Bindings & Boot Execution
    // ==========================================

    // システムリセットなどの特殊なクリーンアップバインディング
    desktop.modals.system.on('reset', async () => {
      try {
        // メタデータ（IndexedDB）を消す前に、ファイル実体（OPFS）を全削除してリソースリークを防ぐ
        await contentStore.clearAll();
        await nodeStore.clearAll();
        window.location.reload();
      } catch (e) {
        console.error('System reset failed:', e);
      }
    });

    processManager.on('process_killed', (pid: string) => {
      toolRegistry.removeToolsByPid(pid);
    });

    cognitiveManager.setStatusCallback((modelString) => {
      const statusEl = document.getElementById('model-status');
      if (statusEl) statusEl.textContent = modelString;
    });

    themeService.setOnThemeAppliedCallback((payload) => {
      desktop.modals.editor.setTheme(payload.isDark ? 'dark' : 'light');
      desktop.modals.editor.updateTypography(payload.fontSize, payload.monoFont);
    });

    // ルーティングとイベントの活性化
    orchestrator.bindAll();
    themeService.start();

    // 初期化タスクの実行
    await themeService.applyAppearance(configManager.get('appearance') || { theme: 'system/themes/dark.json' });
    desktop.panels.chat.renderHistory(history.get());
    desktop.updateStorageUI(vfs.getUsage());

    await cognitiveManager.refreshEngineConfig();
    await maintenanceDaemon.start();

    // ダッシュボードの起動
    await processManager.spawn({ path: 'apps/home.html', show: true });

    logger.log('system', {
      action: 'boot',
      message: 'System booted successfully',
    });
    console.log('[Itera] OS Ready.');
  }
}
