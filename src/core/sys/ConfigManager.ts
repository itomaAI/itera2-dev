/**
 * src/core/sys/ConfigManager.ts
 * Itera OS v2: System Configuration Manager
 */

import type { VfsService } from "../vfs/VfsService";
import type { VfsEventBus } from "../vfs/VfsEventBus";
import { SYSTEM_PRINCIPAL } from "../vfs/types";

export interface OsConfig {
  preferences: {
    username: string;
    agentName: string;
    language: string;
    autoUpdateSystemFiles: boolean;
  };
  appearance: {
    theme: string;
    typography?: { uiFont: string; monoFont: string; fontSize: string };
    layout?: { animations: boolean };
  };
  llm: { model: string; temperature: number };
  network: { proxyUrl: string; allowCredentialsWithProxy: boolean };
  associations: {
    extensions: Record<string, string>;
    mimeTypes: Record<string, string>;
  };
  [category: string]: any;
}

const DEFAULT_CONFIG: OsConfig = {
  preferences: {
    username: "User",
    agentName: "Itera",
    language: "English",
    autoUpdateSystemFiles: true,
  },
  appearance: {
    theme: "system/themes/light.json",
    typography: { uiFont: "Inter", monoFont: "monospace", fontSize: "medium" },
    layout: { animations: true },
  },
  llm: { model: "gemini-3-flash-preview", temperature: 1.0 },
  network: {
    proxyUrl: "https://corsproxy.io/?",
    allowCredentialsWithProxy: false,
  },
  associations: { extensions: {}, mimeTypes: {} },
};

export class ConfigManager {
  private vfs: VfsService;
  private cache: OsConfig;
  private configDir = "system/config";
  private listeners: ((config: OsConfig) => void)[] = [];

  constructor(vfs: VfsService, eventBus: VfsEventBus) {
    this.vfs = vfs;
    // ディープコピーで初期化
    this.cache = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

    // VFSの変更を監視し、設定ファイルが更新されたら再ロードする
    eventBus.subscribe(async (events) => {
      let configChanged = false;
      const loadPromises: Promise<void>[] = [];
      for (const event of events) {
        if (
          event.path.startsWith(`${this.configDir}/`) &&
          event.path.endsWith(".json")
        ) {
          // apps.json と services.json は別のマネージャが扱うので無視
          const filename = event.path.split("/").pop();
          if (filename === "apps.json" || filename === "services.json")
            continue;

          loadPromises.push(this._loadCategory(filename!));
          configChanged = true;
        }
      }
      if (configChanged) {
        await Promise.all(loadPromises);
        this._notify();
      }
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
   * 単一のカテゴリ（ファイル）を非同期でロードし、キャッシュを更新する
   */
  private async _loadCategory(filename: string): Promise<void> {
    const category = filename.replace(".json", "");
    const path = `${this.configDir}/${filename}`;

    // デフォルトのカテゴリ設定をディープコピーしてベースにする
    const defaultData = DEFAULT_CONFIG[category]
      ? JSON.parse(JSON.stringify(DEFAULT_CONFIG[category]))
      : {};

    try {
      if (this.vfs.exists(SYSTEM_PRINCIPAL, path)) {
        const content = await this.vfs.readFile(SYSTEM_PRINCIPAL, path);
        const parsed = JSON.parse(content);
        this.cache[category] = this._deepMerge(defaultData, parsed);
      } else {
        this.cache[category] = defaultData;
      }
    } catch (e) {
      console.warn(
        `[ConfigManager] Failed to load or parse ${path}, using defaults.`,
        e,
      );
      this.cache[category] = defaultData;
    }
  }

  onUpdate(callback: (config: OsConfig) => void): () => void {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter((cb) => cb !== callback);
    };
  }

  private _notify(): void {
    this.listeners.forEach((cb) => cb(this.cache));
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
    const newCategoryData = this._deepMerge(
      this.cache[category] || {},
      updates,
    );
    this.cache[category] = newCategoryData;

    const path = `${this.configDir}/${String(category)}.json`;
    try {
      await this.vfs.writeFile(
        SYSTEM_PRINCIPAL,
        path,
        JSON.stringify(newCategoryData, null, 2),
        { overwrite: true, system: true },
      );
    } catch (e) {
      console.error(`[ConfigManager] Failed to save config to ${path}`, e);
      throw e;
    }
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
    return item && typeof item === "object" && !Array.isArray(item);
  }
}
