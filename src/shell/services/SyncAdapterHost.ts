/**
 * src/shell/services/SyncAdapterHost.ts
 * Itera OS v2: Pluggable Sync Adapter Host
 *
 * 目的:
 *   クラウド同期プロバイダ（Google Drive, Firebase, Dropbox 等）の
 *   「認証まわりの UI とロジック」を、ホストのビルド成果物から切り離し、
 *   VFS 上の JavaScript ファイルとして差し替え可能にする。
 *
 * ホストはプロバイダを一切知らない。ホストが提供するのは
 *   - 描画先の DOM スロット
 *   - 状態を報告するためのコールバック
 *   - VFS / ConfigManager / ProcessManager への参照
 * のみであり、プロバイダ固有の処理はすべてアダプタ側にある。
 *
 * ── セキュリティ上の注意 ──────────────────────────────
 * アダプタは **ホスト window 内で** 動的 import され、iframe サンドボックスの
 * 外側で実行される。すなわちアダプタのコードはホストと同じ権限を持つ。
 * これはゲストアプリより明確に強い権限であり、意図的な設計判断である
 * （認証ポップアップの opener 連携や、起動時に常駐する必要があるため）。
 *
 * したがって `system/adapters/` への書き込み権限は、実質的に
 * 「ホストの任意コード実行権限」と等価である。
 * VfsInitializer は system/ 配下を read-only とし、書き込みを許すのは
 * config / themes / registry / temp / upstream に限っている。
 * **`system/adapters` を書き込み可能領域に追加してはならない。**
 * ─────────────────────────────────────────────────
 */

import type { VfsService } from '../../core/vfs/VfsService';
import type { ConfigManager } from '../../core/sys/ConfigManager';
import type { ProcessManager } from '../windowing/ProcessManager';
import { SYSTEM_PRINCIPAL } from '../../core/vfs/types';

/** アダプタが報告する接続状態 */
export type SyncAdapterState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface SyncAdapterStatus {
  state: SyncAdapterState;
  /** 短いラベル（例: "Connected"） */
  label?: string;
  /** 補足情報（例: サインイン中のメールアドレス） */
  detail?: string;
  /** アクセントに使う Tailwind クラス（例: 'text-[#4285F4]'） */
  accentClass?: string;
}

/** レジストリ (system/registry/adapters.json) の 1 エントリ */
export interface SyncAdapterManifest {
  id: string;
  name: string;
  /** VFS 上の ES module パス */
  path: string;
  description?: string;
  enabled?: boolean;
}

/** アダプタの init() に渡されるコンテキスト */
export interface SyncAdapterContext {
  /** 破壊的変更を入れた場合はこの番号を上げる。アダプタ側で分岐できるようにするため。 */
  apiVersion: number;
  manifest: SyncAdapterManifest;
  vfs: VfsService;
  configManager: ConfigManager;
  processManager: ProcessManager;
  ui: {
    /** このアダプタ専用の描画スロット。他アダプタと干渉しない。 */
    container: HTMLElement;
    /** 接続状態を報告する。集約結果がモーダルとサイドバーに反映される。 */
    setStatus: (status: SyncAdapterStatus) => void;
  };
  log: (message: string, level?: 'info' | 'warn' | 'error') => void;
}

export interface LoadedAdapter {
  manifest: SyncAdapterManifest;
  status: SyncAdapterStatus;
  blobUrl: string;
}

const ADAPTER_API_VERSION = 1;
const REGISTRY_PATH = 'system/registry/adapters.json';

export class SyncAdapterHost {
  private vfs: VfsService;
  private configManager: ConfigManager;
  private processManager: ProcessManager;

  private adapters: Map<string, LoadedAdapter> = new Map();
  private statusListeners: ((summary: SyncAdapterStatus, all: LoadedAdapter[]) => void)[] = [];
  private containerFactory: ((manifest: SyncAdapterManifest) => HTMLElement) | null = null;
  private loaded = false;

  constructor(vfs: VfsService, configManager: ConfigManager, processManager: ProcessManager) {
    this.vfs = vfs;
    this.configManager = configManager;
    this.processManager = processManager;
  }

  /**
   * アダプタの描画先を供給するファクトリを登録する。
   * SyncModal 側が「アダプタ 1 つにつき 1 つの DOM スロット」を返す。
   */
  setContainerFactory(factory: (manifest: SyncAdapterManifest) => HTMLElement): void {
    this.containerFactory = factory;
  }

  onStatusChange(listener: (summary: SyncAdapterStatus, all: LoadedAdapter[]) => void): void {
    this.statusListeners.push(listener);
  }

  getAdapters(): LoadedAdapter[] {
    return Array.from(this.adapters.values());
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * レジストリを読み、有効なアダプタをすべて読み込む。
   *
   * 個々のアダプタは互いに独立して初期化する。
   * 1 つが例外を投げても他は動き続ける（itera-saas 版は全体が 1 つの try で
   * 囲まれていたため、1 つ壊れると全滅していた）。
   */
  async loadAll(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;

    let manifests: SyncAdapterManifest[] = [];
    try {
      const raw = await this.vfs.readFile(SYSTEM_PRINCIPAL, REGISTRY_PATH).catch(() => '');
      if (raw && raw.trim()) {
        const parsed = JSON.parse(raw);
        manifests = Array.isArray(parsed) ? parsed : parsed.adapters || [];
      }
    } catch (e) {
      console.warn('[SyncAdapterHost] Failed to read adapter registry:', e);
      return;
    }

    for (const manifest of manifests) {
      if (manifest.enabled === false) continue;
      if (!manifest.id || !manifest.path) {
        console.warn('[SyncAdapterHost] Skipping malformed adapter entry:', manifest);
        continue;
      }
      await this._loadOne(manifest);
    }

    this._emitStatus();
  }

  private async _loadOne(manifest: SyncAdapterManifest): Promise<void> {
    let blobUrl = '';
    try {
      const code = await this.vfs.readFile(SYSTEM_PRINCIPAL, manifest.path);
      const blob = new Blob([code], { type: 'application/javascript' });
      blobUrl = URL.createObjectURL(blob);

      const mod = await import(/* @vite-ignore */ blobUrl);
      if (typeof mod.init !== 'function') {
        throw new Error(`Adapter '${manifest.id}' does not export init()`);
      }

      const entry: LoadedAdapter = {
        manifest,
        status: { state: 'disconnected' },
        blobUrl,
      };
      this.adapters.set(manifest.id, entry);

      const container = this.containerFactory
        ? this.containerFactory(manifest)
        : document.createElement('div');

      const ctx: SyncAdapterContext = {
        apiVersion: ADAPTER_API_VERSION,
        manifest,
        vfs: this.vfs,
        configManager: this.configManager,
        processManager: this.processManager,
        ui: {
          container,
          setStatus: (status: SyncAdapterStatus) => {
            const cur = this.adapters.get(manifest.id);
            if (!cur) return;
            cur.status = status || { state: 'disconnected' };
            this._emitStatus();
          },
        },
        log: (message: string, level: 'info' | 'warn' | 'error' = 'info') => {
          const tag = `[SyncAdapter:${manifest.id}]`;
          if (level === 'error') console.error(tag, message);
          else if (level === 'warn') console.warn(tag, message);
          else console.log(tag, message);
        },
      };

      await mod.init(ctx);
      console.log(`[SyncAdapterHost] Loaded adapter '${manifest.id}' from ${manifest.path}`);
    } catch (e) {
      // 1 つのアダプタの失敗を全体の失敗にしない
      console.error(`[SyncAdapterHost] Failed to load adapter '${manifest.id}':`, e);
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      this.adapters.set(manifest.id, {
        manifest,
        status: { state: 'error', label: 'Load failed', detail: String((e as Error)?.message || e) },
        blobUrl: '',
      });
    }
  }

  /**
   * 全アダプタの状態を 1 つに集約する。
   * 優先順位: connected > connecting > error > disconnected
   * （「1 つでも繋がっていれば繋がっている」と表示するため）
   */
  private _summarize(): SyncAdapterStatus {
    const all = this.getAdapters();
    if (all.length === 0) return { state: 'disconnected', label: 'No Adapters' };

    const connected = all.filter((a) => a.status.state === 'connected');
    if (connected.length > 0) {
      const first = connected[0];
      return {
        state: 'connected',
        label: connected.length === 1 ? first.status.label || 'Connected' : `${connected.length} Connected`,
        detail: connected.length === 1 ? first.status.detail : connected.map((a) => a.manifest.name).join(', '),
        accentClass: first.status.accentClass,
      };
    }
    if (all.some((a) => a.status.state === 'connecting')) return { state: 'connecting', label: 'Connecting...' };

    const errored = all.find((a) => a.status.state === 'error');
    if (errored) return { state: 'error', label: 'Error', detail: errored.status.detail };

    return { state: 'disconnected', label: 'Local Mode Only', detail: 'Not Signed In' };
  }

  private _emitStatus(): void {
    const summary = this._summarize();
    const all = this.getAdapters();
    for (const listener of this.statusListeners) {
      try {
        listener(summary, all);
      } catch (e) {
        console.error('[SyncAdapterHost] Status listener failed:', e);
      }
    }
  }
}