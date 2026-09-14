/**
 * src/shell/services/CognitiveManager.ts
 * Itera OS v2: AI Engine Configuration Manager
 */

import type { ConfigManager } from '../../core/sys/ConfigManager';
import type { Engine } from '../../core/control/Engine';
import type { SystemLogger } from '../../core/state/SystemLogger';
import type { VfsService } from '../../core/vfs/VfsService';
import { SYSTEM_PRINCIPAL } from '../../core/vfs/types';
import { buildSystemPrompt } from '../../config/system_prompts';
import { PROVIDERS } from '../../config/providers';

import { GeminiProjector, OpenAIProjector, AnthropicProjector } from '../../core/cognitive/Projector';
import { GeminiAdapter } from '../../core/cognitive/adapters/GeminiAdapter';
import { OpenAIAdapter } from '../../core/cognitive/adapters/OpenAIAdapter';
import { AnthropicAdapter } from '../../core/cognitive/adapters/AnthropicAdapter';
import type { RelayTransport } from '../../core/cognitive/adapters/BaseAdapter';
import {
  RELAY_PROVIDER_ID,
  RELAY_CATALOG_STORAGE_KEY,
  CLOUD_CONFIG_PATH,
  buildRelayBaseUrl,
  fetchRelayCatalog,
  RelayCatalogCache,
  resolveRelayModel,
  type RelayCatalogStore,
  UnavailableRelayAdapter,
  type RelayModelEntry,
} from '../../core/cognitive/relay/CloudRelay';

/** サインイン状態と ID トークンを認証アダプタ（system/adapters/firebase_auth.js）が書く先。ゲストの web 検索と同じ出どころ */
const AUTH_STATE_PATH = 'system/temp/firebase_auth.json';

/** localStorage を RelayCatalogStore として渡す。使えない環境（試験等）では何もしない。 */
function localStorageStore(key: string): RelayCatalogStore | null {
  try {
    if (typeof localStorage === 'undefined') return null;
  } catch {
    return null;
  }
  return {
    get: () => {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set: (value: string) => {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* noop */
      }
    },
  };
}

export class CognitiveManager {
  private configManager: ConfigManager;
  private engine: Engine;
  private logger: SystemLogger;
  private vfs: VfsService;
  private onStatusUpdate: ((modelString: string) => void) | null = null;
  // 運営の台帳（中継の GET /models）の控え。コード側に選択肢は無い。取れないときは最後に取れた台帳だけ
  private relayCatalog = new RelayCatalogCache(localStorageStore(RELAY_CATALOG_STORAGE_KEY));

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

  /**
   * 選べるプロバイダとモデルの一覧。
   *
   * 運営の中継（`managed`）は **繋ぎ先（cloud.json）のある配布物にだけ在る**。無ければ一覧から外す ——
   * itera2-dev には出ない。在れば選択肢を運営の台帳で**置き換える**（追加ではない。運営が消した選択肢を
   * 出し続けると、選んだ瞬間に中継が断る）。
   *
   * @param options.relayCatalog 台帳を取りに行くか。既定は取りに行く（設定画面のため）。
   *   生成のたびに呼ばれる経路では、中継を選んでいるときだけ true にする。自分の鍵で他社を使っている
   *   利用者にまで、毎回クラウドへ問い合わせる筋合いはない。
   */
  public async getMergedProviders(options: { relayCatalog?: boolean } = {}): Promise<any[]> {
    let merged: any[] = JSON.parse(JSON.stringify(PROVIDERS));

    const relayBase = buildRelayBaseUrl(await this.readFunctionsBase());
    if (!relayBase) {
      merged = merged.filter((p: any) => !p.managed);
    }

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

    const relayProvider =
      relayBase && options.relayCatalog !== false ? merged.find((p: any) => p.id === RELAY_PROVIDER_ID) : null;
    if (relayProvider) {
      const catalog = await this.loadRelayCatalog(relayBase!);
      if (catalog) relayProvider.models = catalog;
    }

    return merged;
  }

  /**
   * 運営の台帳を取り込む。サインインしていない・通信に失敗したときは null を返し、
   * 呼び出し側は手元の一覧のまま続ける。ここで選択肢を空にすると設定画面から何も選べなくなる。
   */
  private async loadRelayCatalog(relayBase: string): Promise<RelayModelEntry[] | null> {
    return await this.relayCatalog.get(async () =>
      fetchRelayCatalog(relayBase, async () => {
        const token = await this.readIdToken();
        return token ? { Authorization: `Bearer ${token}` } : null;
      }),
    );
  }

  /** 繋ぎ先。`system/config/cloud.json` の `functionsBase`。無ければ null（推測しない）。 */
  private async readFunctionsBase(): Promise<string | null> {
    try {
      if (!this.vfs.exists(SYSTEM_PRINCIPAL, CLOUD_CONFIG_PATH)) return null;
      const parsed = JSON.parse((await this.vfs.readFile(SYSTEM_PRINCIPAL, CLOUD_CONFIG_PATH)) || '{}');
      const base = parsed?.functionsBase;
      return typeof base === 'string' && base.trim() ? base.trim() : null;
    } catch (e) {
      console.warn('[CognitiveManager] Failed to read cloud.json for the LLM relay URL.', e);
      return null;
    }
  }

  /**
   * いまの ID トークン。**毎回読む** —— 1 時間ごとに書き換わるので、控えを持つと古くなる。
   * 認証アダプタがホスト側にあっても、値は VFS 経由で受け取る（itera2-dev との差分を増やさないため。T-0419）。
   */
  private async readIdToken(): Promise<string | null> {
    try {
      if (!this.vfs.exists(SYSTEM_PRINCIPAL, AUTH_STATE_PATH)) return null;
      const auth = JSON.parse((await this.vfs.readFile(SYSTEM_PRINCIPAL, AUTH_STATE_PATH)) || '{}');
      return auth && auth.signedIn && typeof auth.idToken === 'string' && auth.idToken ? auth.idToken : null;
    } catch {
      return null;
    }
  }

  public async refreshEngineConfig(): Promise<void> {
    if (!this.engine) return;

    const llmConfig = this.configManager.get('llm') || {
      model: 'gemini-3.6-flash',
    };
    const rawModel = llmConfig.model;
    const systemPrompt = buildSystemPrompt({ thinkingTag: llmConfig.thinkingTag !== false });

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
    const mergedProviders = await this.getMergedProviders({
      relayCatalog: provider === RELAY_PROVIDER_ID,
    });
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

    // 運営が用意した中継。利用者の鍵を使わず、Itera Cloud の ID トークンで通す
    if (provider === RELAY_PROVIDER_ID) {
      await this.applyRelayEngine(providerData, modelName, capabilities, llmConfig, systemPrompt);
      return;
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
        newProjector = new OpenAIProjector(systemPrompt, capabilities);
        newLlm = new OpenAIAdapter(apiKey, modelName, baseUrl, llmConfig, this.logger);
        break;
      case 'anthropic':
        newProjector = new AnthropicProjector(systemPrompt, capabilities);
        newLlm = new AnthropicAdapter(apiKey, modelName, llmConfig, this.logger);
        break;
      case 'google':
      default:
        newProjector = new GeminiProjector(systemPrompt, capabilities, apiKey);
        newLlm = new GeminiAdapter(apiKey, modelName, llmConfig, this.logger);
        break;
    }

    this.engine.projector = newProjector;
    this.engine.llm = newLlm;
  }

  /**
   * 中継（`itera`）用の Engine 部品を組み立てて挿す。
   *
   * 接続先か選択肢のどちらかが決まらないときは、**別のモデルで代用しない**。
   * 黙って中身が変わるのがいちばん分かりにくい壊れ方なので、生成時に理由を出すアダプタを挿しておく。
   */
  private async applyRelayEngine(
    providerData: any,
    modelName: string,
    capabilities: any,
    llmConfig: any,
    systemPrompt: string,
  ): Promise<void> {
    const baseUrl = buildRelayBaseUrl(await this.readFunctionsBase());
    const entry = resolveRelayModel(providerData?.models, modelName);

    if (!baseUrl || !entry) {
      // 「台帳に無い」と「台帳をまだ見に行けていない」は別である。後者で「設定画面から選び直してください」と
      // 言うと、直せない操作へ利用者を誘導する
      const catalogSeen = this.relayCatalog.peek() !== null;
      const reason = !baseUrl
        ? 'This build has no Itera Cloud relay configured (system/config/cloud.json).'
        : catalogSeen
          ? `"${modelName}" is not in the relay catalog. Pick a model from Settings.`
          : `The relay catalog has not been loaded yet (${modelName}). Sign in to Itera Cloud, wait a moment, and try again.`;
      this.engine.projector = new GeminiProjector(systemPrompt, capabilities, '');
      this.engine.llm = new UnavailableRelayAdapter(reason, llmConfig, this.logger);
      return;
    }

    const relay: RelayTransport = {
      baseUrl,
      getAuthHeaders: async () => {
        const token = await this.readIdToken();
        if (!token) throw new Error('Sign in to Itera Cloud to use the LLM relay.');
        return { Authorization: `Bearer ${token}` };
      },
      // 中継の上流は本家 OpenAI である。設定の素通しはしない
      strictOpenAISchema: true,
    };

    const modelCapabilities = entry.capabilities ? { ...capabilities, ...entry.capabilities } : capabilities;

    // 利用者が「賢い」と書いても、中継へ渡すのは台帳の正規キー（ASCII）にする。Gemini の経路では別名が URL に載る
    const alias = entry.id;

    switch (entry.upstream) {
      case 'anthropic':
        this.engine.projector = new AnthropicProjector(systemPrompt, modelCapabilities);
        this.engine.llm = new AnthropicAdapter('', alias, llmConfig, this.logger, relay);
        break;
      case 'openai':
        this.engine.projector = new OpenAIProjector(systemPrompt, modelCapabilities);
        this.engine.llm = new OpenAIAdapter('', alias, baseUrl, llmConfig, this.logger, relay);
        break;
      case 'google':
      default:
        // 🔴 Gemini の Files API は鍵が要るので中継では使えない。GeminiProjector は鍵が無いと添付を
        //    送らず、その旨を本文に書く（ミャク楽は inline data に落とす。こちらは未移植）
        this.engine.projector = new GeminiProjector(systemPrompt, modelCapabilities, '');
        this.engine.llm = new GeminiAdapter('', alias, llmConfig, this.logger, relay);
        break;
    }
  }
}
