/**
 * @vitest-environment jsdom
 * プロセスを動かす口（起こす・名指しで再開／起こし直す・終わらせる）は「誰が」を受け取り、関所の規則で判定する（T-0912）。
 * 規則そのものは processGate.test.ts。ここでは ProcessManager の口がその規則を通ること・断ったときに何も変わらないことを見る。
 */
import { describe, expect, it } from 'vitest';
import { ProcessManager } from './ProcessManager';
import { OS_MOVER, USER_MOVER, ProcessRefusedError, engineMover } from './processGate';
import { ROOT_ENGINE_ID } from '../../core/control/Engine';

const NOTES = 'system/apps/notes.html';

function mk() {
  const vfs = { releaseContent: async () => {} };
  const registry = { getAllApps: () => [{ id: 'notes', path: NOTES }], getAllServices: () => [] };
  const pm = new ProcessManager(vfs as any, registry as any, { homePath: () => 'system/apps/home.html' } as any);
  // compile は終わらせない（記録ができるところまでを見る）
  (pm as any).compiler = { compile: () => new Promise(() => {}) };
  const resumed: string[] = [];
  pm.on('process_resumed', (p: any) => resumed.push(p.pid));
  const killed: string[] = [];
  pm.on('process_killed', (pid: string) => killed.push(pid));
  const rows = () =>
    Array.from(pm.processes.values())
      .map((p) => `${p.pid} engine=${p.engine}`)
      .sort();
  return { pm, resumed, killed, rows };
}

const refusal = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    return e;
  }
  return null;
};

const ROOT = engineMover(ROOT_ENGINE_ID);
const A = engineMover('eng-a');
const B = engineMover('eng-b');

describe('ProcessManager — 起こしたプロセスが仕える先', () => {
  it('エンジンが起こしたプロセスは、そのエンジンに仕える（仕える先の指定は効かない）', () => {
    const w = mk();
    void w.pm.spawn(A, { pid: 'a1', path: 'data/a1.html', show: false });
    void w.pm.spawn(A, { pid: 'a2', path: 'data/a2.html', engine: 'eng-b', show: false });
    void w.pm.spawn(ROOT, { pid: 'r1', path: 'data/r1.html', engine: 'eng-b', show: false });
    expect(w.rows()).toEqual(['a1 engine=eng-a', 'a2 engine=eng-a', 'r1 engine=root']);
  });

  it('OS・利用者が起こすものは、指した先に仕える（省けばルート）', () => {
    const w = mk();
    void w.pm.spawn(OS_MOVER, { pid: 'o1', path: 'data/o1.html', show: false });
    void w.pm.spawn(USER_MOVER, { pid: 'u1', path: 'data/u1.html', show: false });
    void w.pm.spawn(USER_MOVER, { pid: 'u2', path: 'data/u2.html', engine: 'eng-a', show: false });
    expect(w.rows()).toEqual(['o1 engine=root', 'u1 engine=root', 'u2 engine=eng-a']);
  });
});

describe('ProcessManager — 名指しで再開／起こし直す', () => {
  it('ほかのエンジンに仕えるプロセスの名前は断る（再開も起こし直しもしない）', async () => {
    const w = mk();
    void w.pm.spawn(ROOT, { path: NOTES, show: false });
    void w.pm.spawn(B, { pid: 'theirs', path: NOTES, show: false });

    const e1 = await refusal(w.pm.spawn(A, { pid: 'notes', path: NOTES, show: false }));
    expect(e1).toBeInstanceOf(ProcessRefusedError);
    expect((e1 as Error).message).toBe(
      'Process "notes" serves another engine ("root"). This engine cannot resume or restart it.',
    );
    const e2 = await refusal(w.pm.spawn(A, { pid: 'theirs', path: NOTES, forceReload: true }));
    expect((e2 as Error).message).toBe(
      'Process "theirs" serves another engine ("eng-b"). This engine cannot resume or restart it.',
    );
    expect(w.rows()).toEqual(['notes engine=root', 'theirs engine=eng-b']);
    expect(w.resumed).toEqual([]);
    expect(w.killed).toEqual([]);
  });

  it('自分に仕えるプロセスは再開できる。ルート・OS・利用者は、どのプロセスも', () => {
    const w = mk();
    void w.pm.spawn(A, { pid: 'mine', path: NOTES, show: false });
    void w.pm.spawn(A, { pid: 'mine', path: NOTES, show: false });
    void w.pm.spawn(ROOT, { pid: 'mine', path: NOTES, show: false });
    void w.pm.spawn(OS_MOVER, { pid: 'mine', path: NOTES, engine: 'eng-a', show: false });
    void w.pm.spawn(USER_MOVER, { pid: 'mine', path: NOTES, engine: 'eng-a', show: false });
    expect(w.resumed).toEqual(['mine', 'mine', 'mine', 'mine']);
    expect(w.rows()).toEqual(['mine engine=eng-a']);
  });

  it('名前なし: 個体の決め方が、ほかのエンジンの個体を選ばないので、断りにならない', () => {
    const w = mk();
    void w.pm.spawn(ROOT, { path: NOTES, show: false });
    void w.pm.spawn(A, { path: NOTES, show: false });
    void w.pm.spawn(A, { path: NOTES, show: false });
    expect(w.rows()).toEqual(['notes engine=root', 'notes-2 engine=eng-a']);
    expect(w.resumed).toEqual(['notes-2']);
  });
});

describe('ProcessManager — 終わらせる', () => {
  it('ほかのエンジンに仕えるプロセスは断る（終わらせない）', async () => {
    const w = mk();
    void w.pm.spawn(ROOT, { path: NOTES, show: false });
    void w.pm.spawn(B, { pid: 'theirs', path: NOTES, show: false });

    const e1 = await refusal(() => w.pm.kill(A, 'notes'));
    expect(e1).toBeInstanceOf(ProcessRefusedError);
    expect((e1 as Error).message).toBe('Process "notes" serves another engine ("root"). This engine cannot kill it.');
    const e2 = await refusal(() => w.pm.kill(A, 'theirs'));
    expect((e2 as Error).message).toBe('Process "theirs" serves another engine ("eng-b"). This engine cannot kill it.');
    expect(w.killed).toEqual([]);
    expect(w.rows()).toEqual(['notes engine=root', 'theirs engine=eng-b']);
  });

  it('自分に仕えるプロセスは終わらせられる。居なければ、誰が呼んでも false', () => {
    const w = mk();
    void w.pm.spawn(A, { pid: 'mine', path: NOTES, show: false });
    expect(w.pm.kill(A, 'mine')).toBe(true);
    expect(w.pm.kill(A, 'mine')).toBe(false);
    expect(w.pm.kill(B, 'nope')).toBe(false);
    expect(w.pm.kill(USER_MOVER, 'nope')).toBe(false);
    expect(w.killed).toEqual(['mine']);
  });

  it('ルート・OS・利用者は、どのプロセスも終わらせられる', () => {
    const w = mk();
    for (const pid of ['p1', 'p2', 'p3']) void w.pm.spawn(A, { pid, path: `data/${pid}.html`, show: false });
    expect(w.pm.kill(ROOT, 'p1')).toBe(true);
    expect(w.pm.kill(OS_MOVER, 'p2')).toBe(true);
    expect(w.pm.kill(USER_MOVER, 'p3')).toBe(true);
    expect(w.killed).toEqual(['p1', 'p2', 'p3']);
  });
});
