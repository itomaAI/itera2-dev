/**
 * src/core/sys/AppRegistry.ts
 * Itera OS v2: Application Registry Manager
 */

import type { VfsService } from '../vfs/VfsService';
import type { VfsEventBus } from '../vfs/VfsEventBus';
import { SYSTEM_PRINCIPAL } from '../vfs/types';
import { REGISTRY_LAYERS } from '../../config/config_layers';
import { overlayEntry, diffEntry, isEmptyDiff } from './registryMerge';

/** ゲストの口から書ける登録簿。adapters.json は含めない（層そのものを認めていない）。 */
export type WritableRegistryKind = 'apps' | 'services';

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

/**
 * 値が実際に変わった登録簿の名前（'apps' / 'services'）を受け取る（T-0540）。
 * ファイルが書かれただけで中身が同じなら呼ばれない（ConfigManager の onUpdate と同じ規律。T-0304）。
 */
export type RegistryChangeListener = (changed: ReadonlySet<WritableRegistryKind>) => void;

export class AppRegistry {
  private vfs: VfsService;
  private apps: Map<string, AppManifest> = new Map();
  private services: Map<string, ServiceManifest> = new Map();

  /** 読む順。後の層が勝つ（`src/config/config_layers.ts`）。 */
  private readonly registryDirs: readonly string[];
  private listeners: RegistryChangeListener[] = [];
  /** 最後に知らせた（または最初に読んだ）ときの値。「変わったか」はこれと比べる。読む前は null */
  private published: Record<WritableRegistryKind, string> | null = null;

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
        this._load().then(() => this._notifyIfChanged());
      }
    });
  }

  async loadAll(): Promise<void> {
    await this._load();
    this.published = this._snapshot();
  }

  private _snapshot(): Record<WritableRegistryKind, string> {
    return {
      apps: JSON.stringify(this.getAllApps()),
      services: JSON.stringify(this.getAllServices()),
    };
  }

  private async _load(): Promise<void> {
    // 🔴 新しい表に積んでから一度に差し替える（T-0540）。
    // 以前は this.apps を空にしてから await しながら詰め直していたので、読み込みの途中に
    // getAllApps() を呼ぶと空や途中の一覧が返った。updateEntry は自分の書き込みの VFS イベントで
    // もう一度 _load が走るため、registry_changed を受けて読み直したランチャーが空の一覧を描いていた
    // （2026-09-25 実機）。途中の状態で比べると、告知の判定（_notifyIfChanged）も狂う。
    const apps = new Map<string, AppManifest>();
    const services = new Map<string, ServiceManifest>();

    // 層を順に重ねる。同じ id は、後の層が持っている鍵だけ勝つ（registryMerge.ts）。
    // 壊れている層は飛ばし、そこまでに積んだ内容は保つ（1 つ壊れて全部消えると OS が立たない）。
    for (const dir of this.registryDirs) {
      await this._loadInto(`${dir}/apps.json`, apps);
      await this._loadInto(`${dir}/services.json`, services);
    }

    this.apps = apps;
    this.services = services;

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
        into.set(entry.id, overlayEntry(into.get(entry.id), entry));
      }
    } catch (e) {
      console.warn(`[AppRegistry] Failed to load ${path}. Skipping this layer.`, e);
    }
  }

  /**
   * 1 項目を更新する。書き先は**最後の層**、書くのは**下の層に重ねると望む項目になる差分だけ**
   * （ConfigManager.update と同じ規律）。下の層と同じ値に戻したら、その層から項目が消える。
   *
   * 層が 1 つの配布物では下の層が無いので項目を丸ごと書く＝これまで設定アプリがしていたことと同じ。
   * 書き先の層が壊れていれば空の配列から作り直す（壊れた登録簿のせいで設定できないままにしない）。
   */
  async updateEntry(kind: 'apps', id: string, updates: Record<string, unknown>): Promise<AppManifest | undefined>;
  async updateEntry(
    kind: 'services',
    id: string,
    updates: Record<string, unknown>,
  ): Promise<ServiceManifest | undefined>;
  async updateEntry(
    kind: WritableRegistryKind,
    id: string,
    updates: Record<string, unknown>,
  ): Promise<AppManifest | ServiceManifest | undefined>;
  async updateEntry(
    kind: WritableRegistryKind,
    id: string,
    updates: Record<string, unknown>,
  ): Promise<AppManifest | ServiceManifest | undefined> {
    if (typeof id !== 'string' || !id) throw new Error('id is required');
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) throw new Error('updates must be an object');

    const writeDir = this.registryDirs[this.registryDirs.length - 1];
    const path = `${writeDir}/${kind}.json`;

    const below = new Map<string, any>();
    for (const dir of this.registryDirs.slice(0, -1)) {
      await this._loadInto(`${dir}/${kind}.json`, below);
    }

    let current: any[] = [];
    try {
      if (this.vfs.exists(SYSTEM_PRINCIPAL, path)) {
        const parsed = JSON.parse(await this.vfs.readFile(SYSTEM_PRINCIPAL, path));
        if (Array.isArray(parsed)) current = parsed.filter((e) => e && e.id);
        else console.warn(`[AppRegistry] ${path} is not an array. Rewriting it from scratch.`);
      }
    } catch (e) {
      console.warn(`[AppRegistry] Failed to read ${path}. Rewriting it from scratch.`, e);
    }

    const index = current.findIndex((e) => e.id === id);
    const own = index >= 0 ? current[index] : undefined;
    const merged = overlayEntry(overlayEntry(below.get(id), own ?? { id }), { ...updates, id });
    const toWrite = diffEntry(below.get(id), merged);

    const next = [...current];
    if (isEmptyDiff(toWrite) && below.has(id)) {
      if (index >= 0) next.splice(index, 1);
    } else if (index >= 0) {
      next[index] = toWrite;
    } else {
      next.push(toWrite);
    }

    await this.vfs.writeFile(SYSTEM_PRINCIPAL, path, JSON.stringify(next, null, 2), {
      overwrite: true,
      system: true,
    });
    await this._load();
    this._notifyIfChanged();
    return kind === 'apps' ? this.apps.get(id) : this.services.get(id);
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

  /** 値が変わった登録簿の名前を受け取る。戻り値を呼ぶと外れる */
  onChange(callback: RegistryChangeListener): () => void {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter((cb) => cb !== callback);
    };
  }

  /**
   * 「値が変わったか」は、旧値と新値を同時に持つここでしか判定できない（T-0304）。
   * 並びも含めて比べる（ランチャーやホームは登録簿の順に並べるので、順が変わるのは見た目の変化）。
   */
  private _notifyIfChanged(): void {
    const next = this._snapshot();
    const prev = this.published;
    this.published = next;
    if (!prev) return; // まだ一度も読んでいない＝知らせる相手にとっての「前」が無い
    const changed = new Set<WritableRegistryKind>();
    if (prev.apps !== next.apps) changed.add('apps');
    if (prev.services !== next.services) changed.add('services');
    if (changed.size === 0) return;
    for (const cb of [...this.listeners]) {
      try {
        cb(changed);
      } catch (e) {
        console.warn('[AppRegistry] A listener failed', e);
      }
    }
  }
}
