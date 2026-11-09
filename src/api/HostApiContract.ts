/**
 * Compile-time contract for stable Host API routes.
 *
 * This intentionally starts with routes whose request and response shapes are
 * unambiguous. Runtime routing and wire data remain unchanged.
 */

import type { CompiledGuest } from '../shell/windowing/GuestCompiler';

export interface ProcessInfo {
  pid: string;
  path: string;
  type: 'app' | 'daemon';
  state: 'foreground' | 'background' | 'running';
}

export interface GuestSpawnOptions {
  pid?: string;
  type?: 'app' | 'daemon';
  show?: boolean;
  forceReload?: boolean;
  args?: Record<string, string>;
}

/** この端末の VFS の容量（バイト）。ゲストが書ける上限は `max - reserved`。 */
export interface VfsUsage {
  used: number;
  max: number;
  reserved: number;
}

export interface DynamicToolRegistration {
  name: string;
  description?: string;
  definition?: string;
}

export interface HostApiContract {
  /** 二段起動の 1 段目から。送信元のプロセスの本体（compile の結果）。資源の blob は structured clone で渡る（T-0770） */
  'sys:boot': {
    request: Record<string, never>;
    response: CompiledGuest;
  };
  /** 本体の文書が load した（ブリッジから）。spawn の待ち合わせを解く（T-0784） */
  'sys:ready': {
    request: Record<string, never>;
    response: boolean;
  };
  /** MetaOS.fs.resolveUrl の実体。Blob（OPFS の File の handle）と MIME。object URL はゲストが作る */
  'fs:read_blob': {
    request: { path: string };
    response: { blob: Blob; mime: string };
  };
  'sys:spawn': {
    request: { path: string; opts?: GuestSpawnOptions };
    response: boolean;
  };
  'sys:kill': {
    request: { pid: string };
    response: boolean;
  };
  'sys:ps': {
    request: Record<string, never>;
    response: ProcessInfo[];
  };
  'sys:info': {
    request: Record<string, never>;
    response: ProcessInfo | null;
  };
  'sys:get_args': {
    request: Record<string, never>;
    response: Record<string, string> | null;
  };
  /** 併合済みの設定（層を重ねた値）。ゲストが設定ファイルを直接読むと層を写すことになる（T-0431） */
  'sys:get_config': {
    request: { category: string };
    response: any;
  };
  /** 設定の更新。書き先は最後の層・書くのは下の層との差分だけ（ConfigManager.update と同じ規律） */
  'sys:update_config': {
    request: { category: string; updates: Record<string, unknown> };
    response: any;
  };
  /** 併合済みの登録簿（apps / services / associations）。ゲストが登録簿を直接読むと層を写すことになる（T-0447） */
  /** 起動中のアプリへ配るテーマの CSS（ホストで計算済みの変数）。theme_changed を受けたブリッジが取り直す（T-0539） */
  'sys:get_theme_css': {
    request: Record<string, never>;
    response: string;
  };
  'sys:get_registry': {
    request: { name: string };
    response: any;
  };
  /** 登録簿の 1 項目を更新（apps / services）。書き先は最後の層・書くのは下の層との差分だけ */
  'sys:update_registry': {
    request: { name: string; id: string; updates: Record<string, unknown> };
    response: any;
  };
  /**
   * 端末ローカルの小さな状態（MetaOS.storage.local。T-0771）。ホストの localStorage に pid ごとに 1 件の JSON。
   * 設定の層（同期される）とは別の口。pid は送信元から取るので引数に無い
   */
  'storage:local_get': {
    request: { key: string };
    response: unknown;
  };
  'storage:local_set': {
    request: { key: string; value: unknown };
    response: boolean;
  };
  'storage:local_remove': {
    request: { key: string };
    response: boolean;
  };
  'storage:local_keys': {
    request: Record<string, never>;
    response: string[];
  };
  'fs:get_usage': {
    request: Record<string, never>;
    response: VfsUsage;
  };
  'host:go_home': {
    request: Record<string, never>;
    response: boolean;
  };
  'tools:register': {
    request: DynamicToolRegistration;
    response: boolean;
  };
  'tools:unregister': {
    request: { name: string };
    response: boolean;
  };
}

export type HostApiAction = keyof HostApiContract;
export type HostApiRequest<K extends HostApiAction> = HostApiContract[K]['request'];
export type HostApiResponse<K extends HostApiAction> = HostApiContract[K]['response'];
