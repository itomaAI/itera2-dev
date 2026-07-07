/**
 * src/shell/core/ShellController.ts
 * Itera OS v2: Main UI Orchestrator
 */

// VFS Subsystem
import { NodeStore } from "../../core/vfs/NodeStore";
import { ContentStore } from "../../core/vfs/ContentStore";
import { PathResolver } from "../../core/vfs/PathResolver";
import { VfsEventBus } from "../../core/vfs/VfsEventBus";
import { VfsService } from "../../core/vfs/VfsService";
import { VfsInitializer } from "../../core/vfs/VfsInitializer";
import { SYSTEM_PRINCIPAL, USER_PRINCIPAL } from "../../core/vfs/types";

// System Services
import { ConfigManager } from "../../core/sys/ConfigManager";
import { AppRegistry } from "../../core/sys/AppRegistry";
import {
  FileAssociationResolver,
  type ResolvedApp,
} from "../../core/sys/FileAssociationResolver";
import { HistoryManager } from "../../core/state/HistoryManager";
import { SystemLogger } from "../../core/state/SystemLogger";

// Cognitive Layer
import { Translator } from "../../core/cognitive/Translator";
import {
  GeminiProjector,
  OpenAIProjector,
  AnthropicProjector,
} from "../../core/cognitive/Projector";
import { GeminiAdapter } from "../../core/cognitive/adapters/GeminiAdapter";
import { OpenAIAdapter } from "../../core/cognitive/adapters/OpenAIAdapter";
import { AnthropicAdapter } from "../../core/cognitive/adapters/AnthropicAdapter";
import { SYSTEM_PROMPT } from "../../config/system_prompts";

// Control Layer
import { ToolRegistry } from "../../core/control/ToolRegistry";
import { registerBasicTools } from "../../core/control/tools/basic_tools";
import { registerFSTools } from "../../core/control/tools/fs_tools";
import { registerSearchTools } from "../../core/control/tools/search_tools";
import { registerSysTools } from "../../core/control/tools/sys_tools";
import { registerUITools } from "../../core/control/tools/ui_tools";
import { Engine } from "../../core/control/Engine";

// IPC & Windowing
import { HostTransport } from "../../ipc/HostTransport";
import { HostApiRouter } from "../../api/HostApiRouter";
import { ProcessManager } from "../windowing/ProcessManager";
import { UriRouter } from "./UriRouter"; // ★追加

// UI Panels & Modals
import { Explorer } from "../panels/Explorer";
import { ChatPanel } from "../panels/ChatPanel";
import { LpmlRenderer } from "../services/LpmlRenderer";
import { EditorModal } from "../modals/EditorModal";
import { MediaViewer } from "../modals/MediaViewer";
import { SystemModal } from "../modals/SystemModal";
import { ApiSettingsModal } from "../modals/ApiSettingsModal";
import { SyncModal } from "../modals/SyncModal";
import { TaskSwitcherModal } from "../modals/TaskSwitcherModal";
import { CameraModal } from "../modals/CameraModal";
import { AudioModal } from "../modals/AudioModal";
import { ProcessMonitorModal } from "../modals/ProcessMonitorModal";

export class ShellController {
  private vfs!: VfsService;
  private nodeStore!: NodeStore;
  private eventBus!: VfsEventBus;
  private configManager!: ConfigManager;
  private appRegistry!: AppRegistry;
  private resolver!: FileAssociationResolver;

  private history!: HistoryManager;
  private logger!: SystemLogger;
  private toolRegistry!: ToolRegistry;
  private engine!: Engine;

  private processManager!: ProcessManager;
  private explorer!: Explorer;
  private chatPanel!: ChatPanel;
  private lpmlRenderer!: LpmlRenderer;
  private editorModal!: EditorModal;
  private mediaViewer!: MediaViewer;
  private systemModal!: SystemModal;
  private apiSettingsModal!: ApiSettingsModal;
  private syncModal!: SyncModal;
  private taskSwitcherModal!: TaskSwitcherModal;
  private cameraModal!: CameraModal;
  private audioModal!: AudioModal;
  private processMonitorModal!: ProcessMonitorModal;

  public transport!: HostTransport;
  private uriRouter!: UriRouter;

  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {}

  // 内部ルーティング（HostApiRouter）から叩かれるための公開ゲッター
  public get panels() {
    return { chat: this.chatPanel };
  }
  public get modals() {
    return {
      editor: this.editorModal,
      camera: this.cameraModal,
      audio: this.audioModal,
    };
  }

  /**
   * OSの起動シーケンス
   */
  async init(): Promise<void> {
    console.log("[Itera] Booting OS v2...");

    // 1. VFS インフラの構築
    this.nodeStore = new NodeStore();
    const contentStore = new ContentStore();
    const pathResolver = new PathResolver(this.nodeStore);
    this.eventBus = new VfsEventBus();
    this.vfs = new VfsService(
      this.nodeStore,
      contentStore,
      pathResolver,
      this.eventBus,
    );

    try {
      await this.nodeStore.loadAll();

      // 2. システム初期化と調停
      const initializer = new VfsInitializer(
        this.vfs,
        this.nodeStore,
        pathResolver,
      );
      await initializer.initialize();

      // 3. システム設定・レジストリ・履歴の構築
      this.configManager = new ConfigManager(this.vfs, this.eventBus);
      await this.configManager.loadAll();

      this.appRegistry = new AppRegistry(this.vfs, this.eventBus);
      await this.appRegistry.loadAll();

      this.resolver = new FileAssociationResolver(
        this.configManager,
        this.appRegistry,
      );

      this.history = new HistoryManager();
      await this.history.loadFromDB();
      this.logger = new SystemLogger(this.vfs);

      // 4. ツールレジストリとAI認知レイヤーの構築
      this.toolRegistry = new ToolRegistry(this.appRegistry);
      registerBasicTools(this.toolRegistry);
      registerFSTools(this.toolRegistry);
      registerSearchTools(this.toolRegistry);
      registerSysTools(this.toolRegistry);
      registerUITools(this.toolRegistry);

      const translator = new Translator();

      // 5. ウィンドウ管理・UIコンポーネントの構築
      this.processManager = new ProcessManager(this.vfs);
      this.lpmlRenderer = new LpmlRenderer();
      this.chatPanel = new ChatPanel(this.lpmlRenderer);
      this.chatPanel.setVfs(this.vfs);

      this.editorModal = new EditorModal();
      this.mediaViewer = new MediaViewer();
      this.systemModal = new SystemModal(
        this.vfs,
        this.nodeStore,
        contentStore,
      );
      this.apiSettingsModal = new ApiSettingsModal();
      this.syncModal = new SyncModal();
      this.taskSwitcherModal = new TaskSwitcherModal(
        this.processManager,
        this.appRegistry,
      );
      this.cameraModal = new CameraModal();
      this.audioModal = new AudioModal();
      this.processMonitorModal = new ProcessMonitorModal(this.processManager);

      this.explorer = new Explorer(this.vfs, this.eventBus, this.resolver);

      // URIルーターの構築とハンドラの登録
      this.uriRouter = new UriRouter("open"); // デフォルトインテントを 'open' に変更
      this._registerUriHandlers();

      // 6. Engine (自律ループ) の構築
      this.engine = new Engine(
        {
          history: this.history,
          vfs: this.vfs,
          configManager: this.configManager,
        },
        null, // Projector は後で注入
        null, // Adapter は後で注入
        translator,
        this.toolRegistry,
        { shell: this },
      );

      // 7. IPC (HostApiRouter) の構築
      this.transport = new HostTransport();

      // セキュリティ: メッセージの送信元検証（PIDの偽装防止）
      this.transport.setSourceValidator((pid: string, sourceWindow: Window) => {
        const proc = this.processManager.processes.get(pid);
        if (!proc || !proc.iframe) return false;
        // ブラウザの実装上、iframeのcontentWindow と メッセージの source は厳密等価(===)で比較可能
        return proc.iframe.contentWindow === sourceWindow;
      });

      new HostApiRouter(this.transport, {
        vfs: this.vfs,
        configManager: this.configManager,
        processManager: this.processManager,
        history: this.history,
        engine: this.engine,
        toolRegistry: this.toolRegistry,
        shell: this,
      });

      // 8. 初期テーマとLLMの適用
      await this._applyTheme(
        this.configManager.get("appearance")?.theme ||
          "system/themes/dark.json",
      );
      this.chatPanel.renderHistory(this.history.get());
      this._refreshEngineConfig();

      // 9. イベントバインディングと起動完了
      this._bindEvents();
      this._bindMobileUI();
      this._updateStorageUI();

      await this._startDaemons();
      await this.processManager.spawn("main", "index.html", "foreground");

      // OS-level daily maintenance (Cron)
      const performDailyMaintenance = async () => {
        try {
          let purged = 0;
          if (this.logger) {
            purged = await this.logger.purgeOldLogs(7);
          }

          // メタデータの自動バックアップ
          if (this.nodeStore && this.vfs) {
            const indexJson = this.nodeStore.exportIndex();
            await this.vfs.mkdir(SYSTEM_PRINCIPAL, "system/backups");
            await this.vfs.writeFile(
              SYSTEM_PRINCIPAL,
              "system/backups/index_auto_backup.json",
              indexJson,
              { overwrite: true, system: true },
            );
          }

          if (purged > 0) {
            console.log(
              `[System Cron] Daily maintenance completed. Purged ${purged} old logs.`,
            );
          } else {
            console.log(`[System Cron] Daily maintenance completed.`);
          }
        } catch (e) {
          console.error("[System Cron] Daily maintenance failed:", e);
        }
      };

      // 起動時に1回実行し、以降は24時間ごと
      performDailyMaintenance();
      setInterval(performDailyMaintenance, 24 * 60 * 60 * 1000);

      console.log("[Itera] OS Ready.");
    } catch (e) {
      console.error("[Itera] Critical Failure during boot:", e);
      throw e;
    }
  }

  private _bindEvents(): void {
    // --- Address Bar (URI Router) ---
    const addressBar = document.getElementById(
      "preview-address-bar",
    ) as HTMLInputElement;
    const btnAddressGo = document.getElementById("btn-address-go");

    const handleAddressNavigate = () => {
      if (!addressBar) return;
      const input = addressBar.value.trim();
      if (!input) return;
      try {
        this.uriRouter.dispatch(input);
      } catch (e: any) {
        console.error("[Router] Navigation failed:", e);
        if (window.AppUI) window.AppUI.notify(e.message, "warning");
        this._restoreAddressBar();
      } finally {
        addressBar.blur();
      }
    };

    if (addressBar) {
      addressBar.addEventListener("keydown", (e) => {
        if (e.key === "Enter") handleAddressNavigate();
      });
    }

    if (btnAddressGo) {
      btnAddressGo.addEventListener("mousedown", (e) => e.preventDefault());
      btnAddressGo.addEventListener("touchstart", (e) => e.preventDefault(), {
        passive: false,
      });
      btnAddressGo.addEventListener("click", handleAddressNavigate);
    }

    // --- VFS & Storage ---
    this.eventBus.subscribe(() => {
      this._updateStorageUI();
      this._triggerAutoSave();
    });

    this.configManager.onUpdate(async (config) => {
      if (config.appearance && config.appearance.theme) {
        await this._applyTheme(config.appearance.theme);
      }
    });

    // --- Explorer Events ---
    this.explorer.on(
      "open_file",
      async (path: string, resolvedApp: ResolvedApp | undefined) => {
        try {
          if (!resolvedApp) {
            const stat = this.vfs.stat(USER_PRINCIPAL, path);
            resolvedApp = this.resolver.resolveDefault(stat);
          }

          if (resolvedApp.appId === "HostRunner") {
            const currentUri = `metaos://run/${path}`;
            await this.processManager.spawn(
              "main",
              path,
              "foreground",
              true,
              {},
              currentUri,
            );
          } else if (resolvedApp.appId === "HostEditor") {
            const content = await this.vfs.readFile(USER_PRINCIPAL, path);
            this.editorModal.open(path, content);
          } else if (resolvedApp.appId === "HostMediaViewer") {
            const blob = await this.vfs.readBlob(USER_PRINCIPAL, path);
            this.mediaViewer.open(path, blob);
          } else {
            const args = { file: path };
            const currentUri = `metaos://open/${path}`;
            await this.processManager.spawn(
              resolvedApp.appId,
              resolvedApp.appPath!,
              "foreground",
              false,
              args,
              currentUri,
            );
          }
        } catch (e: any) {
          if (window.AppUI)
            window.AppUI.notify(`Cannot open file: ${e.message}`, "error");
        }
      },
    );

    this.explorer.on("history_event", (type: string, desc: string) => {
      const lpml = `<event type="${type}">\n${desc}\n</event>`;
      const turn = this.history.append("system", lpml, {
        type: "event_log",
        trigger_llm: false,
      });
      this.chatPanel.appendTurn(turn);
    });

    this.explorer.on("add_to_context", (path: string) => {
      this.chatPanel.addVfsReference(path);
    });

    // --- Chat Panel Events ---
    this.chatPanel.on(
      "send",
      async (text: string, attachments: File[], vfsReferences: string[]) => {
        const CACHE_DIR = "system/cache/media";
        const content: any[] = [];

        for (const path of vfsReferences) {
          content.push({
            text: `<user_attachment path="${path}">[Existing VFS Path]</user_attachment>`,
          });
        }

        for (const file of attachments) {
          const isText =
            file.type.startsWith("text/") ||
            file.type === "application/json" ||
            file.type === "application/xml" ||
            !!file.name.match(
              /\.(txt|md|js|json|html|css|xml|yml|yaml|csv|log|sh|py)$/i,
            );

          const reader = new FileReader();
          const data = await new Promise<string>((r) => {
            reader.onload = () => r(reader.result as string);
            if (isText) reader.readAsText(file);
            else reader.readAsDataURL(file);
          });

          const timestamp = Date.now();
          const safeName = file.name.replace(/[\/\\:*?"<>|\x00-\x1F]/g, "_");
          const path = `${CACHE_DIR}/${timestamp}_${safeName}`;

          try {
            if (isText) {
              await this.vfs.writeFile(USER_PRINCIPAL, path, data, {
                system: true,
                overwrite: true,
              });
              content.push({
                text: `<user_attachment name="${file.name}" path="${path}">\n${data}\n</user_attachment>`,
              });
            } else {
              await this.vfs.writeFile(USER_PRINCIPAL, path, file, {
                system: true,
                overwrite: true,
              });
              content.push({
                media: {
                  path: path,
                  mimeType: file.type || "application/octet-stream",
                  metadata: {},
                },
              });
              content.push({
                text: `<user_attachment path="${path}">[Binary File: ${file.name}]</user_attachment>`,
              });
            }
          } catch (e: any) {
            console.error(`[Shell] Failed to save upload: ${path}`, e);
            if (window.AppUI)
              window.AppUI.notify(
                `Failed to save attachment: ${e.message}`,
                "error",
              );
            return;
          }
        }

        if (text) content.push({ text: text });
        if (content.length === 0) return;

        this._refreshEngineConfig();
        this.chatPanel.setProcessing(true);
        await this.engine.injectUserTurn(content);
      },
    );

    this.chatPanel.on("stop", () => this.engine.stop());

    this.chatPanel.on("clear", async () => {
      const ask = window.AppUI ? window.AppUI.confirm : confirm;
      if (await ask("Clear chat history and media cache?")) {
        this.clearSession({ purgeMedia: true, triggerLlm: false });
      }
    });

    this.chatPanel.on("delete_turn", (id: string) => {
      this.history.delete(id);
      this.chatPanel.renderHistory(this.history.get());
    });

    this.chatPanel.on(
      "preview_request",
      (name: string, src: string, mime: string) => {
        if (src.startsWith("data:")) {
          const parts = src.split(",");
          const bstr = atob(parts[1]);
          let n = bstr.length;
          const u8arr = new Uint8Array(n);
          while (n--) u8arr[n] = bstr.charCodeAt(n);
          const blob = new Blob([u8arr], { type: mime });
          this.mediaViewer.open(name, blob, mime);
        }
        this._closeMobileDrawers();
      },
    );

    // --- Engine Events ---
    this.engine.on("turn_start", (data: any) => {
      if (data.role === "model") {
        this.chatPanel.setProcessing(true);
        this.chatPanel.startStreaming();
      }
    });

    this.engine.on("stream_chunk", (chunk: string) => {
      this.chatPanel.updateStreaming(chunk);
    });

    this.engine.on("turn_end", (data: any) => {
      if (data.role === "model") {
        this.chatPanel.finalizeStreaming();
      } else {
        const turn = data.turn || this.history.getLast();
        this.chatPanel.appendTurn(turn);
      }
      if (!this.engine.isRunning) this.chatPanel.setProcessing(false);
    });

    this.engine.on("loop_stop", (data: any) => {
      if (this.chatPanel.currentStreamEl) this.chatPanel.finalizeStreaming();
      this.chatPanel.setProcessing(false);
      if (data && data.reason === "error") {
        console.error("[Shell] Loop stopped due to error:", data.error);
      }
    });

    // --- Editor & Modals ---
    this.editorModal.on("save", async (path: string, content: string) => {
      try {
        await this.vfs.writeFile(USER_PRINCIPAL, path, content, {
          overwrite: true,
        });
        this.processManager.broadcast("file_changed", { path, type: "update" });
      } catch (e: any) {
        if (window.AppUI)
          window.AppUI.notify(`Save failed: ${e.message}`, "error");
      }
    });

    this.systemModal.on("reset", async () => {
      try {
        await this.nodeStore.clearAll();
        window.location.reload();
      } catch (e) {
        console.error(e);
      }
    });

    this.apiSettingsModal.on("secrets_updated", () =>
      this._refreshEngineConfig(),
    );
  }

  /**
   * LLMエンジンとプロジェクターの設定をリロードする
   */
  public _refreshEngineConfig(): void {
    if (!this.engine) return;

    const llmConfig = this.configManager.get("llm") || {
      model: "gemini-3-flash-preview",
      temperature: 1.0,
    };
    const rawModel = llmConfig.model;

    let provider = "google";
    let modelName = rawModel;

    const slashIdx = rawModel.indexOf("/");
    if (slashIdx !== -1) {
      provider = rawModel.substring(0, slashIdx).toLowerCase();
      modelName = rawModel.substring(slashIdx + 1);
    }

    let secrets: any = {};
    try {
      secrets = JSON.parse(localStorage.getItem("itera_llm_secrets") || "{}");
    } catch (e) {}

    const statusEl = document.getElementById("model-status");
    if (statusEl) statusEl.textContent = `${provider}/${modelName}`;

    const apiKey = secrets[provider] || "";
    let newLlm, newProjector;

    switch (provider) {
      case "openai":
      case "openrouter":
      case "custom":
        const baseUrl =
          provider === "openrouter"
            ? "https://openrouter.ai/api/v1"
            : provider === "custom"
              ? secrets.custom_url || "http://localhost:11434/v1"
              : "https://api.openai.com/v1";
        newProjector = new OpenAIProjector(SYSTEM_PROMPT);
        newLlm = new OpenAIAdapter(
          apiKey,
          modelName,
          baseUrl,
          llmConfig,
          this.logger,
        );
        break;
      case "anthropic":
        newProjector = new AnthropicProjector(SYSTEM_PROMPT);
        newLlm = new AnthropicAdapter(
          apiKey,
          modelName,
          llmConfig,
          this.logger,
        );
        break;
      case "google":
      default:
        newProjector = new GeminiProjector(SYSTEM_PROMPT, apiKey);
        newLlm = new GeminiAdapter(apiKey, modelName, llmConfig, this.logger);
        break;
    }

    this.engine.projector = newProjector;
    this.engine.llm = newLlm;
  }

  /**
   * セッションリセット
   */
  public async clearSession(
    options: {
      purgeMedia?: boolean;
      summary?: string;
      triggerLlm?: boolean;
      restoreTools?: boolean;
    } = {},
  ): Promise<void> {
    const purgeMedia = options.purgeMedia || false;
    const summary = options.summary || null;
    const triggerLlm = options.triggerLlm || false;
    const restoreTools = options.restoreTools || false;

    if (this.logger) {
      this.logger.log("system", {
        action: "session_reset",
        purgeMedia,
        restoreTools,
        hasSummary: !!summary,
      });
    }

    this.history.clear();

    if (purgeMedia) {
      try {
        const CACHE_DIR = "system/cache/media";
        if (this.vfs.exists(SYSTEM_PRINCIPAL, CACHE_DIR)) {
          await this.vfs.deleteFile(SYSTEM_PRINCIPAL, CACHE_DIR, {
            permanent: true,
          });
          console.log("[System] Media cache cleared.");
        }
      } catch (e) {
        console.warn("[System] Failed to clear media cache:", e);
      }
    }

    if (restoreTools && this.toolRegistry) {
      const activeToolDefs =
        this.toolRegistry.getActiveDynamicToolDefinitions();
      if (activeToolDefs.length > 0) {
        const defsText = activeToolDefs.join("\n");
        this.history.append(
          "system",
          `<event type="tool_available">\n[System: Restored Dynamic Tools]\nThe following tools are currently active from background processes:\n${defsText}\n</event>`,
          {
            type: "tool_available",
            trigger_llm: false,
          },
        );
      }
    }

    if (summary) {
      this.history.append(
        "system",
        `<event type="session_reset">\n[Session Restored & Context Compressed]\n\n${summary}\n</event>`,
        {
          type: "event_log",
          trigger_llm: triggerLlm,
        },
      );
    }

    this.chatPanel.renderHistory(this.history.get());
  }

  private async _applyTheme(themePath: string): Promise<void> {
    try {
      if (!this.vfs.exists(SYSTEM_PRINCIPAL, themePath)) return;

      const content = await this.vfs.readFile(SYSTEM_PRINCIPAL, themePath);
      const theme = JSON.parse(content);
      const colors = theme.colors;
      if (!colors) return;

      const root = document.documentElement;
      const setVar = (name: string, hex: string) => {
        if (!hex) return;
        const shorthandRegex = /^#?([a-f\d])([a-f\d])([a-f\d])$/i;
        hex = hex.replace(
          shorthandRegex,
          (_m, r, g, b) => r + r + g + g + b + b,
        );
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        if (result) {
          root.style.setProperty(
            name,
            `${parseInt(result[1], 16)} ${parseInt(result[2], 16)} ${parseInt(result[3], 16)}`,
          );
        }
      };

      setVar("--c-bg-app", colors.bg?.app);
      setVar("--c-bg-panel", colors.bg?.panel);
      setVar("--c-bg-card", colors.bg?.card);
      setVar("--c-bg-hover", colors.bg?.hover);
      setVar("--c-bg-overlay", colors.bg?.overlay);
      setVar("--c-border-main", colors.border?.main);
      setVar("--c-border-highlight", colors.border?.highlight);
      setVar("--c-text-main", colors.text?.main);
      setVar("--c-text-muted", colors.text?.muted);
      setVar("--c-text-inverted", colors.text?.inverted);
      setVar("--c-text-system", colors.text?.system);
      setVar("--c-text-tag-attr", colors.text?.tag_attr);
      setVar("--c-text-tag-content", colors.text?.tag_content);
      setVar("--c-accent-primary", colors.accent?.primary);
      setVar("--c-accent-success", colors.accent?.success);
      setVar("--c-accent-warning", colors.accent?.warning);
      setVar("--c-accent-error", colors.accent?.error);
      setVar(
        "--c-tag-thinking",
        colors.tags?.thinking || colors.accent?.primary,
      );
      setVar("--c-tag-plan", colors.tags?.plan || colors.accent?.success);
      setVar("--c-tag-report", colors.tags?.report || colors.accent?.warning);
      setVar("--c-tag-error", colors.tags?.error || colors.accent?.error);

      if (this.editorModal && typeof this.editorModal.setTheme === "function") {
        const isDark = colors.bg?.app?.toLowerCase() < "#888888";
        this.editorModal.setTheme(isDark ? "dark" : "light");
      }
    } catch (e) {
      console.warn("[Shell] Failed to apply theme", e);
    }
  }

  private async _startDaemons(): Promise<void> {
    try {
      const services = this.configManager.get("services") || [];
      for (const svc of services) {
        if (svc.pid && svc.path) {
          await this.processManager.spawn(svc.pid, svc.path, "background");
        }
      }
    } catch (e) {
      console.warn("[Shell] Failed to start services", e);
    }
  }

  private _updateStorageUI(): void {
    const bar = document.getElementById("storage-usage-bar");
    const text = document.getElementById("storage-usage-text");
    if (!bar || !text) return;

    // UI用の使用量はユーザーが見える範囲のものとする
    const usage = this.vfs.getUsage(USER_PRINCIPAL);
    const usedMB = (usage.used / 1024 / 1024).toFixed(1);
    const maxMB = (usage.max / 1024 / 1024).toFixed(1);

    text.textContent = `${usedMB} / ${maxMB} MB`;
    bar.style.width = `${usage.percent}%`;

    bar.classList.remove(
      "bg-primary",
      "bg-warning",
      "bg-error",
      "animate-pulse",
    );
    text.classList.remove("text-error", "font-bold");

    if (usage.percent > 95) {
      bar.classList.add("bg-error", "animate-pulse");
      text.classList.add("text-error", "font-bold");
    } else if (usage.percent > 80) {
      bar.classList.add("bg-warning");
    } else {
      bar.classList.add("bg-primary");
    }
  }

  private _triggerAutoSave(): void {
    const statusEl = document.getElementById("save-status");
    if (!statusEl) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);

    statusEl.classList.remove("opacity-0");
    statusEl.textContent = "Saving...";
    statusEl.className = "text-[9px] text-warning italic transition-opacity";

    this.saveTimer = setTimeout(() => {
      statusEl.textContent = "Saved";
      statusEl.className = "text-[9px] text-success italic transition-opacity";
      setTimeout(() => statusEl.classList.add("opacity-0"), 2000);
    }, 500);
  }

  private _bindMobileUI(): void {
    const btnFiles = document.getElementById("mobile-nav-files");
    const btnChat = document.getElementById("mobile-nav-chat");
    const btnView = document.getElementById("mobile-nav-view");
    const overlay = document.getElementById("mobile-overlay");
    const sidebar = document.getElementById("sidebar");
    const chatPanel = document.getElementById("chat-panel");

    if (!btnFiles) return;

    const reset = () => {
      if (sidebar) {
        sidebar.classList.remove("translate-x-0");
        sidebar.classList.add("-translate-x-full");
      }
      if (chatPanel) {
        chatPanel.classList.remove("translate-x-0");
        chatPanel.classList.add("translate-x-full");
      }
      if (overlay) overlay.classList.add("hidden");

      [btnFiles, btnChat, btnView].forEach((b) => {
        if (b) {
          b.classList.remove("text-primary", "font-bold", "bg-hover");
          b.classList.add("text-text-muted");
        }
      });
    };

    const activate = (btn: HTMLElement | null) => {
      if (!btn) return;
      btn.classList.remove("text-text-muted");
      btn.classList.add("text-primary", "font-bold", "bg-hover");
    };

    btnFiles.onclick = () => {
      reset();
      activate(btnFiles);
      if (sidebar) {
        sidebar.classList.remove("-translate-x-full");
        sidebar.classList.add("translate-x-0");
      }
      if (overlay) overlay.classList.remove("hidden");
    };

    btnChat.onclick = () => {
      reset();
      activate(btnChat);
      if (chatPanel) {
        chatPanel.classList.remove("translate-x-full");
        chatPanel.classList.add("translate-x-0");
      }
      if (overlay) overlay.classList.remove("hidden");
    };

    btnView.onclick = () => {
      reset();
      activate(btnView);
    };

    if (overlay) {
      overlay.onclick = () => {
        reset();
        activate(btnView);
      };
    }
  }

  public _closeMobileDrawers(): void {
    const btnView = document.getElementById("mobile-nav-view");
    if (btnView) {
      btnView.click();
    }
  }

  private _registerUriHandlers(): void {
    // metaos://open/... (データファイルを関連付けアプリで開く)
    this.uriRouter.register(
      "open",
      async (
        path: string,
        queryArgs: Record<string, string>,
        searchAndHash: string,
      ) => {
        let targetPath = path || "index.html";
        try {
          const stat = this.vfs.stat(USER_PRINCIPAL, targetPath);
          const resolvedApp = this.resolver.resolveDefault(stat);

          if (resolvedApp.appId === "HostRunner") {
            const fullUri = `metaos://run/${targetPath}${searchAndHash}`;
            await this.processManager.spawn(
              "main",
              targetPath + searchAndHash,
              "foreground",
              true,
              queryArgs,
              fullUri,
            );
          } else if (resolvedApp.appId === "HostEditor") {
            const content = await this.vfs.readFile(USER_PRINCIPAL, targetPath);
            this.editorModal.open(targetPath, content);
            this._restoreAddressBar();
          } else if (resolvedApp.appId === "HostMediaViewer") {
            const blob = await this.vfs.readBlob(USER_PRINCIPAL, targetPath);
            this.mediaViewer.open(targetPath, blob);
            this._restoreAddressBar();
          } else {
            // "open" の場合、開く対象のファイルパスとクエリパラメータをマージして args として渡す
            const args = { file: targetPath, ...queryArgs };
            const fullUri = `metaos://open/${targetPath}${searchAndHash}`;
            await this.processManager.spawn(
              resolvedApp.appId,
              resolvedApp.appPath!,
              "foreground",
              false,
              args, // V2仕様: launchContext の代わりに args オブジェクトを渡す
              fullUri,
            );
          }
        } catch (e: any) {
          if (window.AppUI)
            window.AppUI.notify(`Cannot open: ${e.message}`, "error");
          this._restoreAddressBar();
        }
      },
    );

    // metaos://run/... (関連付けを無視して実行ファイルとして起動し、引数を渡す)
    this.uriRouter.register(
      "run",
      async (
        path: string,
        queryArgs: Record<string, string>,
        searchAndHash: string,
      ) => {
        let executablePath = path || "index.html";
        try {
          // "run" の場合、対象パスはアプリ自身。クエリパラメータのみを args として渡す。
          const args = { ...queryArgs };
          const fullUri = `metaos://run/${executablePath}${searchAndHash}`;
          await this.processManager.spawn(
            "main",
            executablePath,
            "foreground",
            true,
            args, // V2仕様: targetPath という誤った意図は持たせず、純粋な引数を渡す
            fullUri,
          );
        } catch (e: any) {
          if (window.AppUI)
            window.AppUI.notify(`Cannot run: ${e.message}`, "error");
          this._restoreAddressBar();
        }
      },
    );

    // metaos://edit/... (強制的にHostコードエディタで開く)
    this.uriRouter.register(
      "edit",
      async (path: string, _args: any, _search: string) => {
        try {
          const content = await this.vfs.readFile(USER_PRINCIPAL, path);
          this.editorModal.open(path, content);
          this._closeMobileDrawers();
        } catch (e: any) {
          if (window.AppUI)
            window.AppUI.notify(`File not found: ${e.message}`, "error");
        }
        this._restoreAddressBar();
      },
    );

    // metaos://view/... (強制的にHostメディアビューアで開く)
    this.uriRouter.register(
      "view",
      async (path: string, _args: any, _search: string) => {
        try {
          const blob = await this.vfs.readBlob(USER_PRINCIPAL, path);
          this.mediaViewer.open(path, blob);
          this._closeMobileDrawers();
        } catch (e: any) {
          if (window.AppUI)
            window.AppUI.notify(`File not found: ${e.message}`, "error");
        }
        this._restoreAddressBar();
      },
    );

    // metaos://system/... (システムモーダルを開く)
    this.uriRouter.register(
      "system",
      async (path: string, _args: any, _search: string) => {
        const target = path.toLowerCase();
        if (target === "settings") {
          this.systemModal.open();
        } else if (target === "api_keys") {
          this.apiSettingsModal.open();
        } else if (target === "sync") {
          this.syncModal.open();
        } else if (target === "monitor") {
          this.processMonitorModal.open();
        } else {
          if (window.AppUI)
            window.AppUI.notify(`Unknown system modal: ${target}`, "warning");
        }
        this._restoreAddressBar();
        this._closeMobileDrawers();
      },
    );
  }

  private _restoreAddressBar(): void {
    const fgApp = Array.from(this.processManager.processes.values()).find(
      (p) => p.state === "foreground",
    );
    const uri = fgApp ? fgApp.currentUri : "metaos://run/index.html";
    this.processManager._updateAddressBar(uri);
  }
}
