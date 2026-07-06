/**
 * src/core/sys/AppRegistry.ts
 * Itera OS v2: Application Registry Manager
 */

import type { VfsService } from "../vfs/VfsService";
import type { VfsEventBus } from "../vfs/VfsEventBus";
import { SYSTEM_PRINCIPAL } from "../vfs/types";

export interface FileHandler {
  action: "view" | "edit";
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

export class AppRegistry {
  private vfs: VfsService;
  private apps: Map<string, AppManifest> = new Map();
  private registryPath = "system/config/apps.json";
  private listeners: (() => void)[] = [];

  constructor(vfs: VfsService, eventBus: VfsEventBus) {
    this.vfs = vfs;

    eventBus.subscribe((events) => {
      const isUpdated = events.some((e) => e.path === this.registryPath);
      if (isUpdated) {
        this._load().then(() => this._notify());
      }
    });
  }

  async loadAll(): Promise<void> {
    await this._load();
  }

  private async _load(): Promise<void> {
    try {
      this.apps.clear(); // 常に一度クリアする

      if (this.vfs.exists(SYSTEM_PRINCIPAL, this.registryPath)) {
        const content = await this.vfs.readFile(
          SYSTEM_PRINCIPAL,
          this.registryPath,
        );
        const parsed: AppManifest[] = JSON.parse(content);

        for (const app of parsed) {
          this.apps.set(app.id, app);
        }
        console.log(`[AppRegistry] Loaded ${this.apps.size} apps.`);
      } else {
        console.log(
          `[AppRegistry] Registry file not found. Apps list is now empty.`,
        );
      }
    } catch (e) {
      console.warn(
        `[AppRegistry] Failed to load or parse ${this.registryPath}. Apps list is now empty.`,
        e,
      );
    }
  }

  getAllApps(): AppManifest[] {
    return Array.from(this.apps.values());
  }

  getApp(appId: string): AppManifest | undefined {
    return this.apps.get(appId);
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
