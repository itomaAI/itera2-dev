/**
 * src/shell/services/CognitiveManager.ts
 * Itera OS v2: AI Engine Configuration Manager
 */

import type { ConfigManager } from '../../core/sys/ConfigManager';
import type { Engine } from '../../core/control/Engine';
import type { SystemLogger } from '../../core/state/SystemLogger';
import type { VfsService } from '../../core/vfs/VfsService';
import { SYSTEM_PRINCIPAL } from '../../core/vfs/types';
import { SYSTEM_PROMPT } from '../../config/system_prompts';
import { PROVIDERS } from '../../config/providers';

import { GeminiProjector, OpenAIProjector, AnthropicProjector } from '../../core/cognitive/Projector';
import { GeminiAdapter } from '../../core/cognitive/adapters/GeminiAdapter';
import { OpenAIAdapter } from '../../core/cognitive/adapters/OpenAIAdapter';
import { AnthropicAdapter } from '../../core/cognitive/adapters/AnthropicAdapter';

export class CognitiveManager {
  private configManager: ConfigManager;
  private engine: Engine;
  private logger: SystemLogger;
  private vfs: VfsService;
  private onStatusUpdate: ((modelString: string) => void) | null = null;

  constructor(configManager: ConfigManager, engine: Engine, logger: SystemLogger, vfs: VfsService) {
    this.configManager = configManager;
    this.engine = engine;
    this.logger = logger;
    this.vfs = vfs;
  }

  public setStatusCallback(callback: (modelString: string) => void): void {
    this.onStatusUpdate = callback;
  }

  /**
   * llm.json の変更を購読し、値が変わったときだけアダプタを作り直す（T-0313）。
   *
   * かつて作り直しは「入口」に配線されていた（チャット送信・ai.ask・ai.task・ai.log(trigger)）。
   * その結果、設定を変えても次にそれらの入口を通るまで旧モデルのまま走り、
   * ツール結果からの継続や set_timer の起床では反映されなかった。
   * Engine はステップごとに `this.llm` を読むので、変更の持ち主（ConfigManager）が知らせた時点で
   * 差し替えれば、各ステップは常に直前の設定で走る。入口が設定のことを知る必要は無い。
   *
   * 走っている generateStream は呼び出し時の参照を持つので、進行中の生成には影響しない。
   * 秘密鍵（localStorage）は VFS を通らないため、その保存は別途（secrets_updated）で知らされる。
   */
  public start(): void {
    this.configManager.onUpdate((_config, changed) => {
      if (!changed.has('llm')) return;
      void this.refreshEngineConfig();
    });
  }

  public async getMergedProviders(): Promise<any[]> {
    const merged = JSON.parse(JSON.stringify(PROVIDERS));

    try {
      if (this.vfs.exists(SYSTEM_PRINCIPAL, 'system/registry/llm_profiles.json')) {
        const content = await this.vfs.readFile(SYSTEM_PRINCIPAL, 'system/registry/llm_profiles.json');
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
              if (vfsProv.defaultConfig) {
                baseProv.defaultConfig = vfsProv.defaultConfig;
              }
            } else {
              merged.push(vfsProv);
            }
          }
        }
      }
    } catch (e) {
      console.warn('[CognitiveManager] Failed to parse llm_profiles.json, using defaults.', e);
    }

    return merged;
  }

  public async refreshEngineConfig(): Promise<void> {
    if (!this.engine) return;

    const llmConfig = this.configManager.get('llm') || {
      model: 'gemini-3.6-flash',
    };
    const rawModel = llmConfig.model;

    let provider = 'google';
    let modelName = rawModel;

    const slashIdx = rawModel.indexOf('/');
    if (slashIdx !== -1) {
      provider = rawModel.substring(0, slashIdx).toLowerCase();
      modelName = rawModel.substring(slashIdx + 1);
    }

    let secrets: any = {};
    try {
      secrets = JSON.parse(localStorage.getItem('itera_llm_secrets') || '{}');
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
        const modelData = providerData.models.find((m: any) => m.id === modelName);
        if (modelData && modelData.capabilities) {
          capabilities = { ...capabilities, ...modelData.capabilities };
        }
      }
    }

    const apiKey = secrets[provider] || '';
    let newLlm, newProjector;

    switch (provider) {
      case 'openai':
      case 'openrouter':
      case 'custom':
        const baseUrl =
          provider === 'openrouter'
            ? 'https://openrouter.ai/api/v1'
            : provider === 'custom'
              ? secrets.custom_url || 'http://localhost:11434/v1'
              : 'https://api.openai.com/v1';
        newProjector = new OpenAIProjector(SYSTEM_PROMPT, capabilities);
        newLlm = new OpenAIAdapter(apiKey, modelName, baseUrl, llmConfig, this.logger);
        break;
      case 'anthropic':
        newProjector = new AnthropicProjector(SYSTEM_PROMPT, capabilities);
        newLlm = new AnthropicAdapter(apiKey, modelName, llmConfig, this.logger);
        break;
      case 'google':
      default:
        newProjector = new GeminiProjector(SYSTEM_PROMPT, capabilities, apiKey);
        newLlm = new GeminiAdapter(apiKey, modelName, llmConfig, this.logger);
        break;
    }

    this.engine.projector = newProjector;
    this.engine.llm = newLlm;
  }
}
