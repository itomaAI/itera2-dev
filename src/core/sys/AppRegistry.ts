/**
 * src/core/sys/AppRegistry.ts
 * Itera OS v2: Application Registry Manager
 */

import type { VfsService } from '../vfs/VfsService';
import type { VfsEventBus } from '../vfs/VfsEventBus';
import { SYSTEM_PRINCIPAL } from '../vfs/types';

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

  private appsRegistryPath = 'system/registry/apps.json';
  private servicesRegistryPath = 'system/registry/services.json';
  private listeners: (() => void)[] = [];

  constructor(vfs: VfsService, eventBus: VfsEventBus) {
    this.vfs = vfs;

    eventBus.subscribe((events) => {
      const isUpdated = events.some((e) => e.path === this.appsRegistryPath || e.path === this.servicesRegistryPath);
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

    try {
      if (this.vfs.exists(SYSTEM_PRINCIPAL, this.appsRegistryPath)) {
        const content = await this.vfs.readFile(SYSTEM_PRINCIPAL, this.appsRegistryPath);
        const parsed: AppManifest[] = JSON.parse(content);
        for (const app of parsed) {
          this.apps.set(app.id, app);
        }
        console.log(`[AppRegistry] Loaded ${this.apps.size} apps.`);
      }
    } catch (e) {
      console.warn(`[AppRegistry] Failed to load ${this.appsRegistryPath}.`, e);
    }

    try {
      if (this.vfs.exists(SYSTEM_PRINCIPAL, this.servicesRegistryPath)) {
        const content = await this.vfs.readFile(SYSTEM_PRINCIPAL, this.servicesRegistryPath);
        const parsed: ServiceManifest[] = JSON.parse(content);
        for (const svc of parsed) {
          this.services.set(svc.id, svc);
        }
        console.log(`[AppRegistry] Loaded ${this.services.size} services.`);
      }
    } catch (e) {
      console.warn(`[AppRegistry] Failed to load ${this.servicesRegistryPath}.`, e);
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
