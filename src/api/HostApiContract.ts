/**
 * Compile-time contract for stable Host API routes.
 *
 * This intentionally starts with routes whose request and response shapes are
 * unambiguous. Runtime routing and wire data remain unchanged.
 */

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
