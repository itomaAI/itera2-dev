/**
 * src/core/sys/AppRegistry.ts
 * Itera OS v2: Application Registry Manager
 */

import type { VfsService } from '../vfs/VfsService';
import type { VfsEventBus } from '../vfs/VfsEventBus';
import { SYSTEM_PRINCIPAL } from '../vfs/types';
import { REGISTRY_LAYERS } from '../../config/config_layers';

export interface FileHandler {
  action: 'view' | 'edit';
  extensions?: string[];
  mimeTypes?: string[];
}

export interface AppManifest {
  id: string;
  name: string;
  icon: string;
  path: string;
  description?: string;
  fileHandlers?: FileHandler[];
}

export interface ServiceManifest {
  id: string;
  name: string;
  icon?: string;
  path: string;
  description?: string;
  autoStart?: boolean;
}

export class AppRegistry {
  private vfs: VfsService;
  private apps: Map<string, AppManifest> = new Map();
  private services: Map<string, ServiceManifest> = new Map();

  /** 読む順。後の層が勝つ（`src/config/config_layers.ts`）。 */
  private readonly registryDirs: readonly string[];
  private listeners: (() => void)[] = [];

  constructor(vfs: VfsService, eventBus: VfsEventBus, layers: readonly string[] = REGISTRY_LAYERS) {
    this.vfs = vfs;
    this.registryDirs = layers.length > 0 ? [...layers] : [...REGISTRY_LAYERS];

    const watched = new Set<string>();
    for (const dir of this.registryDirs) {
      watched.add(`${dir}/apps.json`);
      watched.add(`${dir}/services.json`);
    }

    eventBus.subscribe((events) => {
      const isUpdated = events.some((e) => watched.has(e.path));
      if (isUpdated) {
        this._load().then(() => this._notify());
      }
    });
  }

  async loadAll(): Promise<void> {
    await this._load();
  }

  private async _load(): Promise<void> {
    this.apps.clear();
    this.services.clear();

    // 層を順に重ねる。同じ id は後の層で置き換わる。
    // 壊れている層は飛ばし、そこまでに積んだ内容は保つ（1 つ壊れて全部消えると OS が立たない）。
    for (const dir of this.registryDirs) {
      await this._loadInto(`${dir}/apps.json`, this.apps);
      await this._loadInto(`${dir}/services.json`, this.services);
    }

    console.log(`[AppRegistry] Loaded ${this.apps.size} apps.`);
    console.log(`[AppRegistry] Loaded ${this.services.size} services.`);
  }

  /** 1 つの層を読んで重ねる。項目に id が無ければ捨てる（黙って壊れた登録簿を通さない）。 */
  private async _loadInto<T extends { id?: string }>(path: string, into: Map<string, T>): Promise<void> {
    try {
      if (!this.vfs.exists(SYSTEM_PRINCIPAL, path)) return;
      const content = await this.vfs.readFile(SYSTEM_PRINCIPAL, path);
      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed)) {
        console.warn(`[AppRegistry] ${path} is not an array. Ignoring this layer.`);
        return;
      }
      for (const entry of parsed as T[]) {
        if (!entry || !entry.id) {
          console.warn(`[AppRegistry] An entry in ${path} has no id. Ignoring it.`, entry);
          continue;
        }
        into.set(entry.id, entry);
      }
    } catch (e) {
      console.warn(`[AppRegistry] Failed to load ${path}. Skipping this layer.`, e);
    }
  }

  getAllApps(): AppManifest[] {
    return Array.from(this.apps.values());
  }

  getApp(appId: string): AppManifest | undefined {
    return this.apps.get(appId);
  }

  getAllServices(): ServiceManifest[] {
    return Array.from(this.services.values());
  }

  getService(serviceId: string): ServiceManifest | undefined {
    return this.services.get(serviceId);
  }

  onChange(callback: () => void): () => void {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter((cb) => cb !== callback);
    };
  }

  private _notify(): void {
    this.listeners.forEach((cb) => cb());
  }
}
