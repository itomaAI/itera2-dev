// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { HostApiRouter } from './HostApiRouter';
import { ProcessManager } from '../shell/windowing/ProcessManager';
import { USER_MOVER } from '../shell/windowing/processGate';

/**
 * src/api/HostApiRouter.process.test.ts
 * ゲストがプロセスを動かす口（MetaOS.system.spawn / kill・MetaOS.host.goHome / open）は、
 * 呼んだプロセスが仕えるエンジンとして関所（ProcessManager）へ渡る（T-0912）。
 * 規則は processGate.test.ts、関所の口は ProcessManager.gate.test.ts。ここでは、口が「誰が」を正しく渡すことを見る。
 * ProcessManager は本物（compile は終わらせない: 新しく起こす spawn は返らないので、待たずに記録を見る）。
 */

const HOME = 'system/apps/home.html';
const NOTES = 'system/apps/notes.html';

function world() {
  const handlers = new Map<string, (payload: any, sourcePid: string) => Promise<any>>();
  const transport = { registerHandler: (action: string, handler: any) => handlers.set(action, handler) };
  const registry = { getAllApps: () => [{ id: 'notes', path: NOTES }], getAllServices: () => [] };
  const config = { homePath: () => HOME };
  const pm = new ProcessManager({ releaseContent: async () => {} } as any, registry as any, config as any);
  (pm as any).compiler = { compile: () => new Promise(() => {}) };
  const resumed: string[] = [];
  pm.on('process_resumed', (p: any) => resumed.push(p.pid));
  const killed: string[] = [];
  pm.on('process_killed', (pid: string) => killed.push(pid));

  // ルートに仕えるもの 2 つと、エンジン eng-a・eng-b に仕えるもの
  void pm.spawn(USER_MOVER, { path: HOME, show: false });
  void pm.spawn(USER_MOVER, { path: NOTES, show: false });
  void pm.spawn(USER_MOVER, { pid: 'a_app', engine: 'eng-a', path: 'data/a_app.html', show: false });
  void pm.spawn(USER_MOVER, { pid: 'a_helper', engine: 'eng-a', path: 'data/a_helper.html', type: 'daemon' });
  void pm.spawn(USER_MOVER, { pid: 'b_app', engine: 'eng-b', path: 'data/b_app.html', show: false });

  const openPath = vi.fn();
  new HostApiRouter(transport as any, {
    vfs: {} as any,
    configManager: config as any,
    processManager: pm as any,
    shell: { _closeMobileDrawers: () => {}, _openPath: openPath, modals: {} as any },
    engineFor: () => null,
    engines: null,
    guestLocalStore: {} as any,
  });
  const call = (action: string, payload: any, pid: string) => handlers.get(action)!(payload, pid);
  const rows = () =>
    Array.from(pm.processes.values())
      .map((p) => `${p.pid} engine=${p.engine}`)
      .sort();
  return { pm, call, rows, resumed, killed, openPath };
}

const BEFORE = [
  'a_app engine=eng-a',
  'a_helper engine=eng-a',
  'b_app engine=eng-b',
  'home engine=root',
  'notes engine=root',
];

describe('sys:kill（MetaOS.system.kill）', () => {
  it('同じエンジンに仕える仲間と自分は終わらせられる。居なければ false', async () => {
    const w = world();
    expect(await w.call('sys:kill', { pid: 'a_helper' }, 'a_app')).toBe(true);
    expect(await w.call('sys:kill', { pid: 'a_helper' }, 'a_app')).toBe(false);
    expect(await w.call('sys:kill', { pid: 'a_app' }, 'a_app')).toBe(true);
    expect(w.killed).toEqual(['a_helper', 'a_app']);
  });

  it('ほかのエンジンに仕えるプロセスは断る（ルートに仕えるものも、別のサブに仕えるものも）', async () => {
    const w = world();
    await expect(w.call('sys:kill', { pid: 'home' }, 'a_app')).rejects.toThrow(
      'Process "home" serves another engine ("root"). This engine cannot kill it.',
    );
    await expect(w.call('sys:kill', { pid: 'b_app' }, 'a_helper')).rejects.toThrow(
      'Process "b_app" serves another engine ("eng-b"). This engine cannot kill it.',
    );
    expect(w.killed).toEqual([]);
    expect(w.rows()).toEqual(BEFORE);
  });

  it('ルートに仕えるプロセスは、どのプロセスも終わらせられる', async () => {
    const w = world();
    expect(await w.call('sys:kill', { pid: 'a_app' }, 'home')).toBe(true);
    expect(await w.call('sys:kill', { pid: 'notes' }, 'home')).toBe(true);
    expect(w.killed).toEqual(['a_app', 'notes']);
  });
});

describe('sys:spawn（MetaOS.system.spawn）', () => {
  it('起こしたプロセスは、呼んだプロセスが仕えるエンジンに仕える', () => {
    const w = world();
    void w.call('sys:spawn', { path: 'data/x.html', opts: { pid: 'x', show: false } }, 'a_app');
    void w.call('sys:spawn', { path: 'data/y.html', opts: { pid: 'y', show: false } }, 'home');
    expect(w.rows()).toEqual([...BEFORE, 'x engine=eng-a', 'y engine=root'].sort());
  });

  it('名指し: ほかのエンジンに仕える個体は断る（再開も起こし直しもしない）', async () => {
    const w = world();
    await expect(w.call('sys:spawn', { path: NOTES, opts: { pid: 'notes' } }, 'a_app')).rejects.toThrow(
      'Process "notes" serves another engine ("root"). This engine cannot resume or restart it.',
    );
    await expect(
      w.call('sys:spawn', { path: 'data/b_app.html', opts: { pid: 'b_app', forceReload: true } }, 'a_app'),
    ).rejects.toThrow('Process "b_app" serves another engine ("eng-b"). This engine cannot resume or restart it.');
    expect(w.resumed).toEqual([]);
    expect(w.killed).toEqual([]);
    expect(w.rows()).toEqual(BEFORE);
  });

  it('名指し: 自分の仲間は再開できる。ルートに仕えるプロセスは、どの個体も', async () => {
    const w = world();
    expect(
      await w.call('sys:spawn', { path: 'data/a_helper.html', opts: { pid: 'a_helper', type: 'daemon' } }, 'a_app'),
    ).toBe(true);
    expect(await w.call('sys:spawn', { path: 'data/a_app.html', opts: { pid: 'a_app', show: false } }, 'home')).toBe(
      true,
    );
    expect(w.resumed).toEqual(['a_helper', 'a_app']);
    expect(w.rows()).toEqual(BEFORE);
  });

  it('名前なし: 呼んだプロセスのエンジンから見た「そのアプリ」の個体（ほかのエンジンの個体には触らない）', () => {
    const w = world();
    void w.call('sys:spawn', { path: NOTES, opts: { show: false } }, 'a_app');
    expect(w.rows()).toEqual([...BEFORE, 'notes-2 engine=eng-a'].sort());
    expect(w.resumed).toEqual([]);
  });
});

describe('host:go_home（MetaOS.host.goHome）', () => {
  it('ルートに仕えるプロセスが呼べば、いまのホームへ戻る', async () => {
    const w = world();
    expect(await w.call('host:go_home', {}, 'notes')).toBe(true);
    expect(w.resumed).toEqual(['home']);
    expect(w.pm.processes.get('home')!.state).toBe('foreground');
  });

  it('ほかのエンジンに仕えるプロセスが呼べば、そのエンジンに仕えるホームの個体（ルートのホームには触らない）', () => {
    const w = world();
    void w.call('host:go_home', {}, 'a_app');
    expect(w.rows()).toEqual([...BEFORE, 'home-2 engine=eng-a'].sort());
    expect(w.resumed).toEqual([]);
    expect(w.pm.processes.get('home')!.state).toBe('background');
  });
});

describe('host:open_path（MetaOS.host.open）', () => {
  it('呼んだプロセスが仕えるエンジンとして、開く口へ渡す', async () => {
    const w = world();
    expect(await w.call('host:open_path', { path: '/data/x.md/' }, 'a_app')).toBe(true);
    expect(await w.call('host:open_path', { path: 'data/y.md' }, 'home')).toBe(true);
    expect(w.openPath.mock.calls).toEqual([
      ['data/x.md', { kind: 'engine', engine: 'eng-a', via: 'a_app' }],
      ['data/y.md', { kind: 'engine', engine: 'root', via: 'home' }],
    ]);
  });
});

describe('記録に無いプロセスからの要求', () => {
  it('動かす口は断る', async () => {
    const w = world();
    await expect(w.call('sys:kill', { pid: 'notes' }, 'ghost')).rejects.toThrow('Process [ghost] not found.');
    await expect(w.call('sys:spawn', { path: NOTES }, 'ghost')).rejects.toThrow('Process [ghost] not found.');
    await expect(w.call('host:go_home', {}, 'ghost')).rejects.toThrow('Process [ghost] not found.');
    expect(w.rows()).toEqual(BEFORE);
  });
});
