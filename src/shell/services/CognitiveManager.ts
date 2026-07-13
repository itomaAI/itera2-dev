/**
 * src/shell/services/CognitiveManager.ts
 * Itera OS v2: AI Engine Configuration Manager
 */

import type { ConfigManager } from "../../core/sys/ConfigManager";
import type { Engine } from "../../core/control/Engine";
import type { SystemLogger } from "../../core/state/SystemLogger";
import type { VfsService } from "../../core/vfs/VfsService";
import { SYSTEM_PRINCIPAL } from "../../core/vfs/types";
import { SYSTEM_PROMPT } from "../../config/system_prompts";
import { PROVIDERS } from "../../config/providers";

import {
  GeminiProjector,
  OpenAIProjector,
  AnthropicProjector,
} from "../../core/cognitive/Projector";
import { GeminiAdapter } from "../../core/cognitive/adapters/GeminiAdapter";
import { OpenAIAdapter } from "../../core/cognitive/adapters/OpenAIAdapter";
import { AnthropicAdapter } from "../../core/cognitive/adapters/AnthropicAdapter";

export class CognitiveManager {
  private configManager: ConfigManager;
  private engine: Engine;
  private logger: SystemLogger;
  private vfs: VfsService;
  private onStatusUpdate: ((modelString: string) => void) | null = null;

  constructor(
    configManager: ConfigManager,
    engine: Engine,
    logger: SystemLogger,
    vfs: VfsService,
  ) {
    this.configManager = configManager;
    this.engine = engine;
    this.logger = logger;
    this.vfs = vfs;
  }

  public setStatusCallback(callback: (modelString: string) => void): void {
    this.onStatusUpdate = callback;
  }

  public async getMergedProviders(): Promise<any[]> {
    const merged = JSON.parse(JSON.stringify(PROVIDERS));

    try {
      if (
        this.vfs.exists(SYSTEM_PRINCIPAL, "system/registry/llm_profiles.json")
      ) {
        const content = await this.vfs.readFile(
          SYSTEM_PRINCIPAL,
          "system/registry/llm_profiles.json",
        );
        const parsed = JSON.parse(content);

        if (parsed && Array.isArray(parsed.providers)) {
          for (const vfsProv of parsed.providers) {
            const baseProv = merged.find((p: any) => p.id === vfsProv.id);
            if (baseProv) {
              if (Array.isArray(vfsProv.models)) {
                baseProv.models = vfsProv.models;
              }
              if (vfsProv.defaultCapabilities) {
                baseProv.defaultCapabilities = {
                  ...baseProv.defaultCapabilities,
                  ...vfsProv.defaultCapabilities,
                };
              }
            } else {
              merged.push(vfsProv);
            }
          }
        }
      }
    } catch (e) {
      console.warn(
        "[CognitiveManager] Failed to parse llm_profiles.json, using defaults.",
        e,
      );
    }

    return merged;
  }

  public async refreshEngineConfig(): Promise<void> {
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

    if (this.onStatusUpdate) {
      this.onStatusUpdate(`${provider}/${modelName}`);
    }

    let capabilities: any = undefined;
    const mergedProviders = await this.getMergedProviders();
    const providerData = mergedProviders.find((p: any) => p.id === provider);

    if (providerData) {
      capabilities = { ...providerData.defaultCapabilities };
      if (Array.isArray(providerData.models)) {
        const modelData = providerData.models.find(
          (m: any) => m.id === modelName,
        );
        if (modelData && modelData.capabilities) {
          capabilities = { ...capabilities, ...modelData.capabilities };
        }
      }
    }

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
        newProjector = new OpenAIProjector(SYSTEM_PROMPT, capabilities);
        newLlm = new OpenAIAdapter(
          apiKey,
          modelName,
          baseUrl,
          llmConfig,
          this.logger,
        );
        break;
      case "anthropic":
        newProjector = new AnthropicProjector(
          SYSTEM_PROMPT,
          capabilities,
          apiKey,
        );
        newLlm = new AnthropicAdapter(
          apiKey,
          modelName,
          llmConfig,
          this.logger,
        );
        break;
      case "google":
      default:
        newProjector = new GeminiProjector(SYSTEM_PROMPT, capabilities, apiKey);
        newLlm = new GeminiAdapter(apiKey, modelName, llmConfig, this.logger);
        break;
    }

    this.engine.projector = newProjector;
    this.engine.llm = newLlm;
  }
}
