// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { HostApiRouter } from './HostApiRouter';
import { OS_VERSION } from '../config/version';

/**
 * src/api/HostApiRouter.info.test.ts
 * sys:info（MetaOS.system.info）: 呼んだプロセス自身のことと、OS の版（T-0910）。
 * ゲストが OS の版を読む口はここ（画面の下の帯はホストの文書に在り、ゲストからは見えない）。
 */

function world() {
  const handlers = new Map<string, (payload: any, sourcePid: string) => Promise<any>>();
  const transport = {
    registerHandler: (action: string, handler: any) => handlers.set(action, handler),
    sendEvent: vi.fn(),
  };
  const processes = new Map<string, any>([
    [
      'viewer',
      { pid: 'viewer', app: 'viewer_app', path: 'apps/viewer.html', type: 'app', state: 'foreground', iframe: null },
    ],
  ]);
  new HostApiRouter(transport as any, {
    vfs: {} as any,
    configManager: {} as any,
    processManager: { processes, on: vi.fn() } as any,
    engineFor: () => null,
    engines: null,
    guestLocalStore: {} as any,
  });
  return {
    call: (action: string, payload: any, pid: string) => handlers.get(action)!(payload, pid),
  };
}

describe('sys:info', () => {
  it('呼んだプロセスの pid・path・type・state と、OS の版', async () => {
    const w = world();
    expect(await w.call('sys:info', {}, 'viewer')).toEqual({
      pid: 'viewer',
      path: 'apps/viewer.html',
      type: 'app',
      state: 'foreground',
      osVersion: OS_VERSION,
    });
    expect(OS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('記録に無い pid には null', async () => {
    expect(await world().call('sys:info', {}, 'ghost')).toBeNull();
  });
});
