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

  isMountPoint(path: string): boolean {
    const normPath = this.pathResolver.normalizePath(path);
    return this.mounts.has(normPath);
  }

  /**
   * 現在登録されている Sync Provider の一覧を返す（読み取り専用）。
   *
   * 用途: ルート全体をマウントする同期デーモンが「自分の管轄外の部分木」を
   * 導出するために使う。除外パスをデーモン側にハードコードすると、
   * マウント構成の変更に追随できずアドホックな設定が増えるため、
   * マウント表を唯一の情報源とする。
   *
   * なお findProviderForPath() は既に最長プレフィックス一致であり、
   * ルートマウント('')はより深いマウントに必ず負ける。本メソッドは
   * その優先規則を、ツリー走査を自前で行うデーモンからも参照可能にするもの。
   */
  listMounts(): ProviderInfo[] {
    return Array.from(this.mounts.values()).map((info) => ({ ...info }));
  }

  registerProvider(path: string, pid: string): void {
    const normPath = this.pathResolver.normalizePath(path);
    this.mounts.set(normPath, { mountPath: normPath, pid });
    console.log(`[ProviderManager] Registered Sync Provider: PID '${pid}' at '/${normPath}'`);
    this._notifyMountChange(normPath);
  }

  unregisterProvider(path: string): void {
    const normPath = this.pathResolver.normalizePath(path);
    this.mounts.delete(normPath);
    console.log(`[ProviderManager] Unregistered Sync Provider at '/${normPath}'`);
    this._notifyMountChange(normPath);
  }

  private _notifyMountChange(path: string): void {
    // UIを強制的に再描画させるためのダミーMUTATEイベントを発行
    this.eventBus.publish({
      type: 'MUTATE',
      nodeId: 'dummy_mount',
      node: null,
      path: path,
      changedProperties: ['isMountPoint'],
      sourcePrincipal: { type: 'system', id: 'kernel' },
    });
  }

  findProviderForPath(path: string): ProviderInfo | null {
    const normPath = this.pathResolver.normalizePath(path);
    let longestMatch = '';
    let matchedInfo: ProviderInfo | null = null;

    for (const [mountedPath, info] of this.mounts.entries()) {
      // ルートマウント('')の場合は常にマッチさせる
      if (mountedPath === '' || normPath === mountedPath || normPath.startsWith(mountedPath + '/')) {
        // 空文字の場合は length が 0 なので、他のより深いマウントポイントがあればそちらが優先される
        if (mountedPath === '' && longestMatch !== '') continue;

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
        // 変更の発生元（PrincipalのID）がプロバイダのPIDと同じなら、そのプロバイダには通知しない。
        //
        // ★ type は判定に含めない。id の一致のみで判定する。
        //
        // 以前は type === 'app' を条件に含めていた。しかし systemPrivilege: true の
        // デーモンは HostApiRouter の getPrincipal() により { type: 'system', id: pid }
        // となるため、この条件に一致せず、自分自身の書き込みが自分に通知されていた。
        //
        // その結果、同期デーモンがアンカー (system/temp/sync_anchor*.json) を保存する
        // たびに自分の onMutate が発火し、同期すべき変更が何も無くても
        // 「保存 → 自己通知 → 再同期 → 保存」がデバウンス間隔で永久に回り続ける。
        // なお saveAnchor が渡している { silent: true } は AI のイベントログ出力を
        // 抑止するだけのオプションであり (HostApiRouter._checkAndEmitEvent)、
        // Mutation の発行そのものは止めない。ここで止める必要がある。
        //
        // id 空間が衝突しないことは確認済み: OS 共通の Principal 定数は
        // 'kernel' / 'local_user' / 'Itera_AI' であり、プロバイダの pid は
        // プロセスIDであるため、id だけで判定しても他者の変更を取りこぼさない。
        if (mutation.sourcePrincipal.id === info.pid) {
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
