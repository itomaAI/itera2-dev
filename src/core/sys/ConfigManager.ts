/**
 * src/core/sys/ConfigManager.ts
 * Itera OS v2: System Configuration Manager
 */

import type { VfsService } from '../vfs/VfsService';
import type { VfsEventBus } from '../vfs/VfsEventBus';
import { SYSTEM_PRINCIPAL } from '../vfs/types';

/**
 * 自律ループで連続実行できるツール回数の既定の上限。
 * `preferences.maxContinuousTools` が未設定・不正なときはこの値へ倒す。
 */
export const DEFAULT_MAX_CONTINUOUS_TOOLS = 50;

export interface OsConfig {
  preferences: {
    username: string;
    agentName: string;
    language: string;
    autoUpdateSystemFiles: boolean;
    /** 自律ループで連続実行できるツール回数の上限。0 以下で無制限。 */
    maxContinuousTools: number;
    /**
     * チャットに描かないイベントの種類（`MetaOS.ai.log(message, type)` の type）。
     * 例: ["tool_available", "info"]。履歴には常に残り AI には届く。「利用者に見せない」だけ
     * （T-0246。ミャク楽は tool_available と info を隠して配る）。
     */
    hiddenEventTypes?: string[];
  };
  appearance: {
    theme: string;
    locale?: string;
    typography?: {
      uiFont: string;
      monoFont: string;
      fontSize: string;
      /** 会話本文（ユーザー入力とIteraの発話）の寸法。既定尺での px 値をキーにする。 */
      chatBodySize?: string;
      /** 機構レイヤ（LLM生出力・システムログ）の書体。'mono' | 'sans' */
      systemFont?: string;
      /** 機構レイヤの寸法。既定尺での px 値をキーにする。 */
      systemFontSize?: string;
    };
    layout?: { animations: boolean; homePath?: string };
  };
  llm: { model: string; [key: string]: any };
  network: { proxyUrl: string; allowCredentialsWithProxy: boolean };
  [category: string]: any;
}

const DEFAULT_CONFIG: OsConfig = {
  preferences: {
    username: 'User',
    agentName: 'Itera',
    language: 'English',
    autoUpdateSystemFiles: true,
    maxContinuousTools: DEFAULT_MAX_CONTINUOUS_TOOLS,
    hiddenEventTypes: [],
  },
  appearance: {
    theme: 'system/themes/light.json',
    locale: 'en',
    typography: {
      uiFont: 'system-ui',
      monoFont: 'monospace',
      fontSize: 'medium',
      chatBodySize: '14',
      systemFont: 'mono',
      systemFontSize: '12',
    },
    layout: { animations: true, homePath: 'apps/home.html' },
  },
  llm: { model: 'gemini-3.6-flash' },
  network: {
    proxyUrl: 'https://corsproxy.io/?',
    allowCredentialsWithProxy: false,
  },
};

/**
 * 設定の変更を受け取る側。
 * `changed` には**値が実際に変わったカテゴリ**だけが入る（書き直されただけのものは入らない）。
 */
export type ConfigUpdateListener = (config: OsConfig, changed: ReadonlySet<string>) => void;

export class ConfigManager {
  private vfs: VfsService;
  private cache: OsConfig;
  private configDir = 'system/config';
  private listeners: ConfigUpdateListener[] = [];

  constructor(vfs: VfsService, eventBus: VfsEventBus) {
    this.vfs = vfs;
    // ディープコピーで初期化
    this.cache = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

    // VFSの変更を監視し、設定ファイルが更新されたら再ロードする
    eventBus.subscribe(async (events) => {
      const loadPromises: Promise<{ category: string; changed: boolean }>[] = [];
      for (const event of events) {
        if (event.path.startsWith(`${this.configDir}/`) && event.path.endsWith('.json')) {
          // apps.json と services.json は別のマネージャが扱うので無視
          const filename = event.path.split('/').pop();
          if (filename === 'apps.json' || filename === 'services.json') continue;

          loadPromises.push(this._loadCategory(filename!));
        }
      }
      if (loadPromises.length === 0) return;

      // 「ファイルが書かれた」ではなく「値が変わった」ときだけ知らせる（T-0304）。
      // 旧値と新値を同時に持つのはここだけなので、この判定はここにしか置けない。
      // 購読者ごとに同じ番人を書かせると、書き忘れた購読者が黙って空回りする。
      const results = await Promise.all(loadPromises);
      const changed = new Set(results.filter((r) => r.changed).map((r) => r.category));
      if (changed.size > 0) this._notify(changed);
    });
  }

  /**
   * 起動時にすべての設定ファイルをロードする
   */
  async loadAll(): Promise<void> {
    const categories = Object.keys(DEFAULT_CONFIG);
    for (const category of categories) {
      await this._loadCategory(`${category}.json`);
    }
  }

  /**
   * 単一のカテゴリ（ファイル）を非同期でロードし、キャッシュを更新する。
   *
   * @returns どのカテゴリを読んだかと、値が変わったかどうか
   *   （書き直されただけ＝内容が同じなら changed: false）
   */
  private async _loadCategory(filename: string): Promise<{ category: string; changed: boolean }> {
    const category = filename.replace('.json', '');
    const path = `${this.configDir}/${filename}`;
    const previous = this.cache[category];

    // デフォルトのカテゴリ設定をディープコピーしてベースにする
    const defaultData = DEFAULT_CONFIG[category] ? JSON.parse(JSON.stringify(DEFAULT_CONFIG[category])) : {};

    let next: any = defaultData;
    try {
      if (this.vfs.exists(SYSTEM_PRINCIPAL, path)) {
        const content = await this.vfs.readFile(SYSTEM_PRINCIPAL, path);
        const parsed = JSON.parse(content);
        next = this._deepMerge(defaultData, parsed);
      }
    } catch (e) {
      console.warn(`[ConfigManager] Failed to load or parse ${path}, using defaults.`, e);
      next = defaultData;
    }

    this.cache[category] = next;
    return { category, changed: !this._isEqual(previous, next) };
  }

  /**
   * 設定が変わったときに呼ばれる。第 2 引数は**値が変わったカテゴリの名前**。
   *
   * 何が変わったかを知っているのはここなので、それを伝える。
   * 自分に関わる変化かどうかを決めるのは購読者の側であり（依存を知るのは購読者だけ）、
   * 中間の配線が代わりに決めてはいけない（T-0304）。
   */
  onUpdate(callback: ConfigUpdateListener): () => void {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter((cb) => cb !== callback);
    };
  }

  private _notify(changed: Set<string>): void {
    this.listeners.forEach((cb) => cb(this.cache, changed));
  }

  get(): OsConfig;
  get<K extends keyof OsConfig>(category: K): OsConfig[K];
  get(category?: keyof OsConfig): any {
    return category ? this.cache[category] : this.cache;
  }

  /**
   * 設定を更新し、VFSに書き込む
   */
  async update(category: keyof OsConfig, updates: any): Promise<void> {
    // ディープマージを使用して安全に更新
    const previous = this.cache[category];
    const newCategoryData = this._deepMerge(previous || {}, updates);
    const changed = !this._isEqual(previous, newCategoryData);
    this.cache[category] = newCategoryData;

    const path = `${this.configDir}/${String(category)}.json`;
    try {
      await this.vfs.writeFile(SYSTEM_PRINCIPAL, path, JSON.stringify(newCategoryData, null, 2), {
        overwrite: true,
        system: true,
      });
    } catch (e) {
      console.error(`[ConfigManager] Failed to save config to ${path}`, e);
      throw e;
    }

    // 値を変えた者が知らせる。この書き込みで飛ぶ VFS イベントは、
    // そのときすでにキャッシュが新しいので「変わらなかった」と判定されて黙る（T-0304）。
    if (changed) this._notify(new Set([String(category)]));
  }

  /**
   * 値としての同一性。キーの並びは見ない。
   *
   * JSON 文字列どうしの比較にすると、同じ値でも並びが違うだけで「変わった」になる。
   * 設定は人が書き換えるファイルなので、並びは動く。
   */
  private _isEqual(a: any, b: any): boolean {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;

    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      return a.every((v, i) => this._isEqual(v, b[i]));
    }

    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && this._isEqual(a[k], b[k]));
  }

  /**
   * ユーティリティ: オブジェクトのディープマージ
   */
  private _deepMerge(target: any, source: any): any {
    const output = { ...target };
    if (this._isObject(target) && this._isObject(source)) {
      Object.keys(source).forEach((key) => {
        if (this._isObject(source[key])) {
          if (!(key in target)) {
            Object.assign(output, { [key]: source[key] });
          } else {
            output[key] = this._deepMerge(target[key], source[key]);
          }
        } else {
          Object.assign(output, { [key]: source[key] });
        }
      });
    }
    return output;
  }

  private _isObject(item: any): boolean {
    return item && typeof item === 'object' && !Array.isArray(item);
  }
}
