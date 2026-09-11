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
import { SyncAdapterHost } from '../services/SyncAdapterHost';
import { StorageLossGuard } from '../../core/sys/StorageLossGuard';
import { instanceGuard } from '../../core/sys/InstanceGuard';
import { LocalReset } from '../../core/sys/LocalReset';
import { VfsFsck } from '../../core/vfs/VfsFsck';

export class SystemBootstrapper {
  public static async boot(): Promise<void> {
    console.log('[Itera] Booting OS v2...');

    // ==========================================
    // 0. Storage Persistence & UI Initialization
    // ==========================================
    try {
      if (navigator.storage && navigator.storage.persist) {
        const isPersisted = await navigator.storage.persist();
        console.log(`[SystemBootstrapper] Storage persistence: ${isPersisted ? 'Granted' : 'Denied'}`);
      }
    } catch (e) {
      console.warn('[SystemBootstrapper] Failed to request storage persistence:', e);
    }

    const dialogService = new DialogService();
    window.AppUI = dialogService;

    // 起動失敗画面で「工場出荷状態に戻す」が押されていれば、DB 接続もデーモンも無いこの時点で消す（T-0381）。
    await LocalReset.enforceAtBoot();

    // ==========================================
    // 1. VFS Subsystem Initialization
    // ==========================================
    const nodeStore = new NodeStore();
    const contentStore = new ContentStore();
    const pathResolver = new PathResolver(nodeStore);
    const eventBus = new VfsEventBus();
    const vfs = new VfsService(nodeStore, contentStore, pathResolver, eventBus);

    await nodeStore.loadAll();

    // 起動失敗画面で「修復して起動」が押されていれば、配信の書き直しより前にメタデータと実体の食い違いを直す（T-0381）。
    if (LocalReset.consumeRepairRequest()) {
      try {
        const report = await new VfsFsck(nodeStore, contentStore).runRepair();
        console.warn('[SystemBootstrapper] Repair before boot:', report);
        LocalReset.setNotice(
          report.totalErrorsFixed > 0 ? { kind: 'repaired', fixed: report.totalErrorsFixed } : { kind: 'repair_clean' },
        );
      } catch (e) {
        console.error('[SystemBootstrapper] Repair before boot failed:', e);
        LocalReset.setNotice({
          kind: 'repair_failed',
          reason: (e as { message?: string } | null)?.message || String(e),
        });
      }
    }

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
    const processManager = new ProcessManager(vfs, appRegistry, configManager);

    // 動作中にブラウザのデータが消されたら、全プロセス（デーモンを含む）を止めてから読み込み直す。
    // 古い在庫のまま走らせない（T-0383。Itera にはクラウドが無いので消えたものは戻らない）。
    const haltAllProcesses = () => {
      for (const pid of Array.from(processManager.processes.keys())) {
        try {
          processManager.kill(pid);
        } catch {
          /* 止められないものは放置して読み込み直す */
        }
      }
    };
    StorageLossGuard.onTrip(haltAllProcesses);

    // 別のタブが「Use this tab」を押したら、全プロセスを止めて鍵を渡し、読み込み直して待機中のタブになる（T-0384）。
    // 覆いの文は部品の既定（英語）のまま。
    instanceGuard.onHandover(haltAllProcesses);
    nodeStore.setStorageLossHandler((reason) => void StorageLossGuard.trip(`vfs ${reason}`));
    history.setStorageLossHandler((reason) => void StorageLossGuard.trip(`history ${reason}`));
    const uriRouter = new UriRouter('open');

    // 同期アダプタのホスト。実際の読み込みは DesktopEnvironment（=描画スロットの供給元）
    // の構築後に行う必要があるため、ここでは生成のみ。
    const syncAdapterHost = new SyncAdapterHost(vfs, configManager, processManager);

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
      configManager,
      syncAdapterHost,
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
      _closeMobileDrawers: () => desktop.closeMobileDrawers(),
      _revealInExplorer: (path: string) => desktop.revealInExplorer(path),
      // 関連付けで開く（ゲストの MetaOS.host.open。T-0344）。intent の登録は EventOrchestrator にあり、
      // dispatch は同期で登録済みの handler を呼ぶだけなので、ここで router を握っていれば足りる
      _openPath: (path: string) => uriRouter.dispatch(`metaos://open/${path}`),
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
      configManager,
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
    cognitiveManager.start(); // llm.json の変更でアダプタを作り直す（入口では作り直さない。T-0313）

    // 初期化タスクの実行
    await themeService.applyAppearance(configManager.get('appearance') || { theme: 'system/themes/dark.json' });
    // チャットに描かないイベントの種類（preferences.hiddenEventTypes。既定 []、ミャク楽は tool_available/info を隠して配る）
    //
    // 判定は持ち主に置く（T-0304）:
    //   「設定が変わったか」   … ConfigManager（旧値と新値を同時に持つ唯一の場所）
    //   「その変化が絵に効くか」… ChatPanel（自分が何に依存して描いているかを知る唯一の場所）
    // 配線であるここは何も計算しない。返事に従って描き直すだけである。
    // かつてここが無条件に描き直していたため、設定ファイルが書かれるたびに
    // 履歴が丸ごと組み直され、チャット欄が最下部へ飛んでいた。
    desktop.panels.chat.setHiddenEventTypes(configManager.get('preferences')?.hiddenEventTypes);
    // 一覧の並びの上書き（appearance.sortWeight）。同じ形で、判定は持ち主（Explorer）に置く。
    desktop.panels.explorer.setSortWeights(configManager.get('appearance')?.sortWeight);
    desktop.panels.explorer.setRootIcons(configManager.get('appearance')?.rootIcons);
    configManager.onUpdate((config) => {
      if (desktop.panels.chat.setHiddenEventTypes(config.preferences?.hiddenEventTypes)) {
        desktop.panels.chat.renderHistory(history.get());
      }
      desktop.panels.explorer.setSortWeights(config.appearance?.sortWeight);
      desktop.panels.explorer.setRootIcons(config.appearance?.rootIcons);
    });
    desktop.panels.chat.renderHistory(history.get());
    desktop.updateStorageUI(vfs.getUsage());

    await cognitiveManager.refreshEngineConfig();
    await maintenanceDaemon.start();

    // 同期アダプタの読み込み。
    // DesktopEnvironment の構築後でなければ描画スロットを受け取れないため、
    // ここまで遅延させている。個々のアダプタの失敗は内部で握り潰され、
    // 起動シーケンス全体を止めない。
    await syncAdapterHost.loadAll();

    // ダッシュボードの起動
    const homePath = configManager.get('appearance')?.layout?.homePath || 'apps/home.html';
    await processManager.spawn({ path: homePath, show: true });

    // 前回、動作中にブラウザのデータが消されて読み込み直したなら、1 度だけ伝える（黙って戻すと障害に見える）
    const storageLoss = StorageLossGuard.consumeNotice();
    if (storageLoss) {
      logger.log('system', {
        action: 'storage_loss',
        message: `Reloaded after local storage was removed underneath a running session (${storageLoss}).`,
      });
      dialogService.notify(
        'Browser storage was cleared while Itera was running, so it was reloaded. Local files and chat history on this device are gone unless you have a backup or a sync target.',
        'warning',
      );
    }

    // 起動失敗画面からの消去・修復の結果を 1 度だけ伝える（黙って消すと障害に見える）
    const resetNotice = LocalReset.consumeNotice();
    if (resetNotice) {
      const text = {
        reset_done: ['Local data has been reset to factory state.', 'warning'],
        reset_failed: [
          `Could not erase local data. Close other tabs and try again: ${(resetNotice as any).reason}`,
          'error',
        ],
        repair_clean: ['Repair ran, but no problems were found in the file system.', 'info'],
        repaired: [
          `Repaired the file system (${(resetNotice as any).fixed} issues). Rescued files are in .lost+found.`,
          'warning',
        ],
        repair_failed: [`Repair failed: ${(resetNotice as any).reason}`, 'error'],
      }[resetNotice.kind] as [string, string];
      logger.log('system', { action: 'local_reset', message: `${resetNotice.kind}: ${text[0]}` });
      dialogService.notify(text[0], text[1]);
    }

    logger.log('system', {
      action: 'boot',
      message: 'System booted successfully',
    });
    console.log('[Itera] OS Ready.');
  }
}
