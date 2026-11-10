/**
 * @vitest-environment jsdom
 * kill は、そのプロセスに渡した VFS の実体（handle）の保持を手放す（T-0791）。
 * 渡すのは GuestCompiler（compile の資産）と readBlob（fs:read_blob）で、どちらも holder = pid。
 */
import { describe, expect, it } from 'vitest';
import { ProcessManager } from './ProcessManager';

function mk() {
  const released: string[] = [];
  const vfs = {
    releaseContent: async (holder: string, hold?: string) => {
      released.push(hold === undefined ? holder : `${holder}:${hold}`);
    },
  };
  const pm = new ProcessManager(vfs as any, {} as any, {} as any);
  const proc = (pid: string) =>
    ({
      pid,
      path: `system/apps/${pid}.html`,
      type: 'app',
      state: 'background',
      iframe: null as any,
      boot: { abandon() {} } as any,
      lastActiveTime: 0,
      currentUri: `metaos://run/system/apps/${pid}.html`,
    }) as any;
  pm.processes.set('a', proc('a'));
  pm.processes.set('b', proc('b'));
  return { pm, released };
}

describe('ProcessManager.kill → vfs.releaseContent (T-0791)', () => {
  it('kill した pid だけを手放す', async () => {
    const { pm, released } = mk();
    expect(pm.kill('a')).toBe(true);
    await Promise.resolve();
    expect(released).toEqual(['a']);
    expect(pm.processes.has('b')).toBe(true);
  });

  it('居ない pid の kill は何もしない', async () => {
    const { pm, released } = mk();
    expect(pm.kill('nope')).toBe(false);
    await Promise.resolve();
    expect(released).toEqual([]);
  });
});

describe('ProcessManager.releaseBlob → vfs.releaseContent(pid, hold) (T-0798)', () => {
  it('そのプロセスに渡した 1 つだけを手放す', async () => {
    const { pm, released } = mk();
    await pm.releaseBlob('n@1', 'a');
    expect(released).toEqual(['a:n@1']);
    expect(pm.processes.has('a')).toBe(true);
  });

  it('居ないプロセスからの要求は何もしない（kill が全部手放している）', async () => {
    const { pm, released } = mk();
    await pm.releaseBlob('n@1', 'nope');
    expect(released).toEqual([]);
  });
});
