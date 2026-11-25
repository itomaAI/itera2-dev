/**
 * @vitest-environment jsdom
 * 窓の上限はエンジンごと（T-0908）。数えるのは画面を持つプロセス（type が app）。
 *   ルート … 16。越えたら、ルートに仕える背景の古いものから閉じる
 *   ほか   … 4。越えるなら、起こす前に断る（押し出さない）
 */
import { describe, expect, it } from 'vitest';
import { ProcessManager, SpawnRefusedError } from './ProcessManager';
import { MAX_APPS_ROOT, MAX_APPS_SUB } from '../../config/engine_limits';
import { USER_MOVER } from './processGate';

function mk() {
  const vfs = { releaseContent: async () => {} };
  const registry = { getAllApps: () => [], getAllServices: () => [] };
  const pm = new ProcessManager(vfs as any, registry as any, { homePath: () => 'system/apps/home.html' } as any);
  (pm as any).compiler = { compile: () => new Promise(() => {}) };
  const killed: string[] = [];
  pm.on('process_killed', (pid: string) => killed.push(pid));
  const resumed: string[] = [];
  pm.on('process_resumed', (p: any) => resumed.push(p.pid));
  /** 背景の窓を 1 つ起こす。lastActiveTime は起こした順に並べる */
  let clock = 0;
  const app = (pid: string, engine?: string) => {
    void pm.spawn(USER_MOVER, { pid, engine, path: `data/${pid}.html`, show: false });
    pm.processes.get(pid)!.lastActiveTime = ++clock;
  };
  const daemon = (pid: string, engine?: string) =>
    void pm.spawn(USER_MOVER, { pid, engine, path: `data/${pid}.html`, type: 'daemon' });
  const pids = () => Array.from(pm.processes.keys());
  return { pm, killed, resumed, app, daemon, pids };
}

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return null;
};

describe('ProcessManager — 窓の上限: ルート', () => {
  it(`${MAX_APPS_ROOT} までは閉じない。越えたら、背景の古いものを 1 つ閉じる`, () => {
    expect(MAX_APPS_ROOT).toBe(16);
    const w = mk();
    for (let i = 1; i <= MAX_APPS_ROOT; i++) w.app(`r${i}`);
    expect(w.killed).toEqual([]);

    w.app('r17');
    expect(w.killed).toEqual(['r1']);
    expect(w.pids()).toHaveLength(MAX_APPS_ROOT);
    expect(w.pm.processes.has('r17')).toBe(true);
  });

  it('デーモンは数えない', () => {
    const w = mk();
    for (let i = 1; i <= 5; i++) w.daemon(`d${i}`);
    for (let i = 1; i <= MAX_APPS_ROOT; i++) w.app(`r${i}`);
    expect(w.killed).toEqual([]);
  });

  it('ほかのエンジンに仕える窓は、数えも閉じもしない', () => {
    const w = mk();
    // いちばん古いのは、ほかのエンジンに仕える窓
    for (let i = 1; i <= MAX_APPS_SUB; i++) w.app(`s${i}`, 'eng-a');
    for (let i = 1; i <= MAX_APPS_ROOT; i++) w.app(`r${i}`);
    expect(w.killed).toEqual([]);

    w.app('r17');
    expect(w.killed).toEqual(['r1']);
    expect(w.pids().filter((pid) => pid.startsWith('s'))).toHaveLength(MAX_APPS_SUB);
  });
});

describe('ProcessManager — 窓の上限: ルート以外のエンジン', () => {
  it(`${MAX_APPS_SUB} つまで。越えるなら起こす前に断り、何も閉じない`, async () => {
    expect(MAX_APPS_SUB).toBe(4);
    const w = mk();
    for (let i = 1; i <= MAX_APPS_SUB; i++) w.app(`s${i}`, 'eng-a');

    const e = await refusal(w.pm.spawn(USER_MOVER, { pid: 's5', engine: 'eng-a', path: 'data/s5.html', show: false }));
    expect(e).toBeInstanceOf(SpawnRefusedError);
    expect((e as Error).message).toBe('Engine "eng-a" already has 4 app windows (limit 4). Close one first.');
    expect(w.killed).toEqual([]);
    expect(w.pids()).toEqual(['s1', 's2', 's3', 's4']);
  });

  it('上限に居ても、いま在る窓の再開と起こし直しは出来る（増えないので）', () => {
    const w = mk();
    for (let i = 1; i <= MAX_APPS_SUB; i++) w.app(`s${i}`, 'eng-a');

    void w.pm.spawn(USER_MOVER, { pid: 's2', engine: 'eng-a', path: 'data/s2.html', show: false });
    expect(w.resumed).toEqual(['s2']);

    const before = w.pm.processes.get('s3')!.boot;
    void w.pm.spawn(USER_MOVER, { pid: 's3', engine: 'eng-a', path: 'data/s3.html', show: false, forceReload: true });
    expect(w.pm.processes.get('s3')!.boot).not.toBe(before);
    expect(w.pids()).toHaveLength(MAX_APPS_SUB);
  });

  it('上限に居ても、デーモンは起こせる。窓を 1 つ閉じれば、また起こせる', async () => {
    const w = mk();
    for (let i = 1; i <= MAX_APPS_SUB; i++) w.app(`s${i}`, 'eng-a');
    w.daemon('d1', 'eng-a');
    expect(w.pm.processes.get('d1')!.engine).toBe('eng-a');

    w.pm.kill(USER_MOVER, 's1');
    w.app('s5', 'eng-a');
    expect(w.pm.processes.has('s5')).toBe(true);
  });

  it('上限に居るとき、デーモンを同じ pid の窓に起こし直すのは「増える」に数える', async () => {
    const w = mk();
    for (let i = 1; i <= MAX_APPS_SUB; i++) w.app(`s${i}`, 'eng-a');
    w.daemon('d1', 'eng-a');
    const e = await refusal(
      w.pm.spawn(USER_MOVER, { pid: 'd1', engine: 'eng-a', path: 'data/d1.html', type: 'app', show: false }),
    );
    expect(e).toBeInstanceOf(SpawnRefusedError);
    expect(w.pm.processes.get('d1')!.type).toBe('daemon');
    expect(w.killed).toEqual([]);
  });

  it('数えるのはエンジンごと。ルートに仕える窓や、ほかのエンジンの窓は数に入らない', async () => {
    const w = mk();
    for (let i = 1; i <= 6; i++) w.app(`r${i}`);
    for (let i = 1; i <= MAX_APPS_SUB; i++) w.app(`a${i}`, 'eng-a');
    for (let i = 1; i <= MAX_APPS_SUB; i++) w.app(`b${i}`, 'eng-b');
    expect(w.pids()).toHaveLength(6 + MAX_APPS_SUB * 2);

    expect(
      await refusal(w.pm.spawn(USER_MOVER, { pid: 'b5', engine: 'eng-b', path: 'data/b5.html', show: false })),
    ).toBeInstanceOf(SpawnRefusedError);
  });

  it('同じ pid でも、ほかのエンジンに仕える窓の起こし直しは「増える」に数える', async () => {
    const w = mk();
    for (let i = 1; i <= MAX_APPS_SUB; i++) w.app(`s${i}`, 'eng-a');
    w.app('r1');
    const e = await refusal(
      w.pm.spawn(USER_MOVER, { pid: 'r1', engine: 'eng-a', path: 'data/r1.html', show: false, forceReload: true }),
    );
    expect(e).toBeInstanceOf(SpawnRefusedError);
    expect(w.pm.processes.get('r1')!.engine).toBe('root');
    expect(w.killed).toEqual([]);
  });
});

describe('ProcessManager — 全部を起こし直す（restartAll）', () => {
  it('起こし直すのは、ルートに仕えるプロセスだけ。ほかのエンジンに仕えるものは終わらせる', () => {
    const w = mk();
    w.app('r1');
    w.daemon('d1');
    w.app('s1', 'eng-a');
    w.daemon('sd1', 'eng-a');
    const boots = new Map(Array.from(w.pm.processes.values()).map((p) => [p.pid, p.boot]));

    void (w.pm as any).restartAll();

    const changed = Array.from(w.pm.processes.values())
      .filter((p) => p.boot !== boots.get(p.pid))
      .map((p) => p.pid)
      .sort();
    expect(changed).toEqual(['d1', 'r1']);
    expect(w.pids().sort()).toEqual(['d1', 'r1']);
    expect(w.killed.sort()).toEqual(['d1', 'r1', 's1', 'sd1']);
  });

  it('前面が、ほかのエンジンに仕える窓だったら、残るアプリが前面になって起こし直される', () => {
    const w = mk();
    w.app('r1');
    void w.pm.spawn(USER_MOVER, { pid: 's1', engine: 'eng-a', path: 'data/s1.html', show: true });
    expect(w.pm.processes.get('s1')!.state).toBe('foreground');

    void (w.pm as any).restartAll();

    expect(w.pids()).toEqual(['r1']);
    expect(w.pm.processes.get('r1')!.state).toBe('foreground');
  });
});
