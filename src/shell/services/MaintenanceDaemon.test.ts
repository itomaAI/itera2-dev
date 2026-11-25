import { describe, it, expect, vi } from 'vitest';
import { MaintenanceDaemon } from './MaintenanceDaemon';
import { AppRegistry } from '../../core/sys/AppRegistry';
import { VfsEventBus } from '../../core/vfs/VfsEventBus';
import { OS_MOVER } from '../windowing/processGate';

/**
 * 自動起動は登録簿の層を重ねた値から決める（T-0447）。
 * services.json を直接読むと、利用者が自分の層に置いた `autoStart: false` が効かない。
 */
function makeVfs(files: Record<string, string>) {
  return {
    files,
    exists: (_p: any, path: string) => path in files,
    readFile: async (_p: any, path: string) => files[path],
  } as any;
}

describe('MaintenanceDaemon: 自動起動', () => {
  it('利用者の層で autoStart を切った配信デーモンは起動しない', async () => {
    const SYS = 'system/registry';
    const USR = 'user/registry';
    const files = {
      [`${SYS}/services.json`]: JSON.stringify([
        { id: 'a', name: 'A', path: 'system/services/a.html', autoStart: true },
        { id: 'b', name: 'B', path: 'system/services/b.html', autoStart: true },
      ]),
      [`${USR}/services.json`]: JSON.stringify([
        { id: 'b', autoStart: false },
        { id: 'mine', name: 'Mine', path: 'user/services/mine.html', autoStart: true },
      ]),
    };
    const vfs = makeVfs(files);
    const registry = new AppRegistry(vfs, new VfsEventBus(), [SYS, USR]);
    await registry.loadAll();

    const spawn = vi.fn(async () => 'ok');
    const daemon = new MaintenanceDaemon({ spawn } as any, {} as any, vfs, {} as any, registry);
    await (daemon as any)._startInitialDaemons();

    const spawned = spawn.mock.calls.map((c: any[]) => c[1].pid).sort();
    expect(spawned).toEqual(['a', 'mine']);
    // 自動起動は OS が起こす
    expect(spawn.mock.calls.every((c: any[]) => c[0] === OS_MOVER)).toBe(true);
  });

  it('1 本の起動が投げても、残りのデーモンは起動する', async () => {
    const SYS = 'system/registry';
    const files = {
      [`${SYS}/services.json`]: JSON.stringify([
        { id: 'a', name: 'A', path: 'system/services/a.html', autoStart: true },
        { id: 'broken', name: 'Broken', path: 'system/services/broken.html', autoStart: true },
        { id: 'c', name: 'C', path: 'system/services/c.html', autoStart: true },
      ]),
    };
    const vfs = makeVfs(files);
    const registry = new AppRegistry(vfs, new VfsEventBus(), [SYS]);
    await registry.loadAll();

    const spawn = vi.fn(async (_mover: unknown, opts: { pid: string }) => {
      if (opts.pid === 'broken') throw new Error('boom');
      return 'ok';
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const daemon = new MaintenanceDaemon({ spawn } as any, {} as any, vfs, {} as any, registry);
    await (daemon as any)._startInitialDaemons();
    const warned = warn.mock.calls.map((c: any[]) => String(c[0]));
    warn.mockRestore();

    // 壊れた 1 本のあとの c も起こされる
    expect(spawn.mock.calls.map((c: any[]) => c[1].pid)).toEqual(['a', 'broken', 'c']);
    // 失敗はどの 1 本かが分かる形で残す
    expect(warned.some((w) => w.includes('"broken"'))).toBe(true);
  });
});
