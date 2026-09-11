/**
 * src/core/sys/ConfigManager.ts
 * Itera OS v2: System Configuration Manager
 */

import type { VfsService } from '../vfs/VfsService';
import type { VfsEventBus } from '../vfs/VfsEventBus';
import { SYSTEM_PRINCIPAL } from '../vfs/types';
import { CONFIG_LAYERS } from '../../config/config_layers';

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
    /**
     * 一覧の並びの上書き。名前 → 重み（小さいほど先。既定 0）。
     * 配信の既定（system / local を後ろ、trash をいちばん下）に **重ねて** 効く。
     * 既定を外したいときは、その名前に 0 を書く。実装は src/shell/panels/nodeOrder.ts。
     */
    sortWeight?: Record<string, number>;
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
  /** 読む順。後が勝つ。書き先は最後（`src/config/config_layers.ts`）。 */
  private readonly configDirs: readonly string[];
  private listeners: ConfigUpdateListener[] = [];

  constructor(vfs: VfsService, eventBus: VfsEventBus, layers: readonly string[] = CONFIG_LAYERS) {
    this.vfs = vfs;
    // 空で渡されても動けなくならないようにする（層が無い＝コードの既定だけ、ではなく必ず 1 層は持つ）
    this.configDirs = layers.length > 0 ? [...layers] : [...CONFIG_LAYERS];
    // ディープコピーで初期化
    this.cache = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

    // VFSの変更を監視し、設定ファイルが更新されたら再ロードする
    eventBus.subscribe(async (events) => {
      const loadPromises: Promise<{ category: string; changed: boolean }>[] = [];
      for (const event of events) {
        if (this.configDirs.some((dir) => event.path.startsWith(`${dir}/`)) && event.path.endsWith('.json')) {
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
    const previous = this.cache[category];

    const next = await this._mergeLayers(category, filename, this.configDirs.length);

    this.cache[category] = next;
    return { category, changed: !this._isEqual(previous, next) };
  }

  /**
   * コードの既定に、層を `count` 個ぶん順に重ねた値を作る。
   *
   * **壊れている層は飛ばす。** その層だけを無かったことにし、そこまでに積んだ値は保つ。
   * （層ごとに読むので「1 つ壊れたら全部既定に戻る」にはしない。）
   */
  private async _mergeLayers(category: string, filename: string, count: number): Promise<any> {
    let acc = DEFAULT_CONFIG[category] ? JSON.parse(JSON.stringify(DEFAULT_CONFIG[category])) : {};
    for (const dir of this.configDirs.slice(0, count)) {
      const path = `${dir}/${filename}`;
      try {
        if (!this.vfs.exists(SYSTEM_PRINCIPAL, path)) continue;
        const content = await this.vfs.readFile(SYSTEM_PRINCIPAL, path);
        acc = this._deepMerge(acc, JSON.parse(content));
      } catch (e) {
        console.warn(`[ConfigManager] Failed to load or parse ${path}. Skipping this layer.`, e);
      }
    }
    return acc;
  }

  /**
   * `base` に重ねたときに `next` になる最小の差分。
   *
   * 🔴 **層に書くのは差分だけである。** 併合した全体を書くと、
   * その時点の下位の値が写しとして固まり、**あとから既定が変わっても届かなくなる**
   * （層に分けた意味が消える）。同じ値に戻した項目は、差分から落ちて「上書きしていない」に戻る。
   */
  private _deepDiff(base: any, next: any): any {
    if (!this._isObject(base) || !this._isObject(next)) return next;
    const out: any = {};
    for (const key of Object.keys(next)) {
      const b = base[key];
      const n = next[key];
      if (this._isEqual(b, n)) continue;
      out[key] = this._isObject(b) && this._isObject(n) ? this._deepDiff(b, n) : n;
    }
    return out;
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

    // 書き先は最後の層。書くのは**その下までを重ねた値との差分だけ**。
    const filename = `${String(category)}.json`;
    const writeDir = this.configDirs[this.configDirs.length - 1];
    const path = `${writeDir}/${filename}`;
    const below = await this._mergeLayers(String(category), filename, this.configDirs.length - 1);
    const toWrite = this._deepDiff(below, newCategoryData);
    try {
      await this.vfs.writeFile(SYSTEM_PRINCIPAL, path, JSON.stringify(toWrite, null, 2), {
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
