/**
 * src/shell/services/SessionManager.ts
 * Itera OS v2: Session & Context Manager
 */

import type { VfsService } from "../../core/vfs/VfsService";
import type { HistoryManager } from "../../core/state/HistoryManager";
import type { SystemLogger } from "../../core/state/SystemLogger";
import type { ToolRegistry } from "../../core/control/ToolRegistry";
import { SYSTEM_PRINCIPAL } from "../../core/vfs/types";

export interface ClearSessionOptions {
  purgeMedia?: boolean;
  summary?: string;
  triggerLlm?: boolean;
  restoreTools?: boolean;
}

export class SessionManager {
  private vfs: VfsService;
  private history: HistoryManager;
  private logger: SystemLogger;
  private toolRegistry: ToolRegistry;
  private onCleared: (() => void) | null = null;

  constructor(
    vfs: VfsService,
    history: HistoryManager,
    logger: SystemLogger,
    toolRegistry: ToolRegistry,
  ) {
    this.vfs = vfs;
    this.history = history;
    this.logger = logger;
    this.toolRegistry = toolRegistry;
  }

  public setOnClearedCallback(callback: () => void): void {
    this.onCleared = callback;
  }

  public async clearSession(options: ClearSessionOptions = {}): Promise<void> {
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
          console.log("[SessionManager] Media cache cleared.");
        }
      } catch (e) {
        console.warn("[SessionManager] Failed to clear media cache:", e);
      }
    }

    if (restoreTools && this.toolRegistry) {
      const activeToolDefs = this.toolRegistry.getActiveDynamicToolDefinitions();
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

    if (this.onCleared) {
      this.onCleared();
    }
  }
}