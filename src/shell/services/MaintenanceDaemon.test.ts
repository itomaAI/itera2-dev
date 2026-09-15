import { describe, it, expect, vi } from 'vitest';
import { MaintenanceDaemon } from './MaintenanceDaemon';
import { AppRegistry } from '../../core/sys/AppRegistry';
import { VfsEventBus } from '../../core/vfs/VfsEventBus';

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

    const spawned = spawn.mock.calls.map((c: any[]) => c[0].pid).sort();
    expect(spawned).toEqual(['a', 'mine']);
  });
});
