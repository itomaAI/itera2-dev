/**
 * src/core/vfs/ProviderManager.ts
 * Itera OS VFS v2: Sync Provider Routing and Echo Cancellation
 */

import type { VfsEventBus } from './VfsEventBus';
import type { VfsMutation } from './types';
import type { HostTransport } from '../../ipc/HostTransport';
import type { ProcessManager } from '../../shell/windowing/ProcessManager';
import type { PathResolver } from './PathResolver';

export interface ProviderInfo {
  mountPath: string;
  pid: string;
}

export class ProviderManager {
  private mounts: Map<string, ProviderInfo> = new Map(); // normalizedPath -> ProviderInfo
  private fetchPromises: Map<string, Promise<boolean>> = new Map();

  private eventBus: VfsEventBus;
  private transport: HostTransport;
  private processManager: ProcessManager;
  private pathResolver: PathResolver;

  constructor(
    eventBus: VfsEventBus,
    transport: HostTransport,
    processManager: ProcessManager,
    pathResolver: PathResolver,
  ) {
    this.eventBus = eventBus;
    this.transport = transport;
    this.processManager = processManager;
    this.pathResolver = pathResolver;
    this._bindEventBus();
  }

  registerProvider(path: string, pid: string): void {
    const normPath = this.pathResolver.normalizePath(path);
    this.mounts.set(normPath, { mountPath: normPath, pid });
    console.log(`[ProviderManager] Registered Sync Provider: PID '${pid}' at '/${normPath}'`);
  }

  unregisterProvider(path: string): void {
    const normPath = this.pathResolver.normalizePath(path);
    this.mounts.delete(normPath);
    console.log(`[ProviderManager] Unregistered Sync Provider at '/${normPath}'`);
  }

  findProviderForPath(path: string): ProviderInfo | null {
    const normPath = this.pathResolver.normalizePath(path);
    let longestMatch = '';
    let matchedInfo: ProviderInfo | null = null;

    for (const [mountedPath, info] of this.mounts.entries()) {
      if (normPath === mountedPath || normPath.startsWith(mountedPath + '/')) {
        if (mountedPath.length >= longestMatch.length) {
          longestMatch = mountedPath;
          matchedInfo = info;
        }
      }
    }
    return matchedInfo;
  }

  async fetchContent(path: string): Promise<boolean> {
    const info = this.findProviderForPath(path);
    if (!info) return false;

    const proc = this.processManager.processes.get(info.pid);
    if (!proc || !proc.iframe || !proc.iframe.contentWindow) return false;

    // 同一パスへの同時フェッチを防止（重複リクエストの排除）
    if (!this.fetchPromises.has(path)) {
      const fetchTask = this.transport
        .invokeGuest(info.pid, 'fs:resolve_missing', { path }, proc.iframe.contentWindow)
        .catch((e) => {
          console.error(`[ProviderManager] Fetch failed for ${path}:`, e);
          return false;
        })
        .finally(() => {
          this.fetchPromises.delete(path);
        });
      this.fetchPromises.set(path, fetchTask);
    }

    return await this.fetchPromises.get(path)!;
  }

  private _bindEventBus(): void {
    this.eventBus.subscribe((mutations) => {
      // 変更を該当するProviderごとに振り分ける
      const routingMap = new Map<string, VfsMutation[]>(); // pid -> mutations

      for (const mutation of mutations) {
        const info = this.findProviderForPath(mutation.path);
        if (!info) continue;

        // ★ OSレベルのエコーキャンセル
        // 変更の発生元（PrincipalのID）がプロバイダのPIDと同じなら、そのプロバイダには通知しない
        if (mutation.sourcePrincipal.type === 'app' && mutation.sourcePrincipal.id === info.pid) {
          continue;
        }

        if (!routingMap.has(info.pid)) {
          routingMap.set(info.pid, []);
        }
        routingMap.get(info.pid)!.push(mutation);
      }

      // 各プロバイダにRPC送信
      for (const [pid, providerMutations] of routingMap.entries()) {
        const proc = this.processManager.processes.get(pid);
        if (proc && proc.iframe && proc.iframe.contentWindow) {
          // sendEventを使ってゲスト側の onMutate イベントを発火
          this.transport.sendEvent(pid, 'sync:onMutate', { mutations: providerMutations }, proc.iframe.contentWindow);
        }
      }
    });
  }
}
