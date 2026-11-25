/**
 * @vitest-environment jsdom
 * 道具に渡す、プロセスの取っ手（T-0908）。ProcessManager は本物（compile は終わらせない: 記録が出来るところまでを見る）。
 */
import { describe, expect, it, vi } from 'vitest';
import { createEngineProcesses } from './engineProcesses';
import { ProcessManager } from './ProcessManager';
import { ROOT_ENGINE_ID } from '../../core/control/Engine';
import { MAX_APPS_SUB } from '../../config/engine_limits';

const NOTES = 'system/apps/notes.html';
const SYNC = 'system/services/sync.html';

function mk() {
  const vfs = { releaseContent: async () => {} };
  const registry = {
    getAllApps: () => [{ id: 'notes', path: NOTES }],
    getAllServices: () => [{ id: 'sync_daemon', path: SYNC }],
  };
  // ゲストへの道（HostTransport の代わり）。持つのは ProcessManager
  const evals: any[] = [];
  const transport = {
    invokeGuest: vi.fn(async (pid: string, action: string, payload: any, target: any) => {
      evals.push({ pid, action, payload, target });
      return 42;
    }),
  };
  const pm = new ProcessManager(
    vfs as any,
    registry as any,
    { homePath: () => 'system/apps/home.html' } as any,
    transport as any,
  );
  (pm as any).compiler = { compile: () => new Promise(() => {}) };
  const resumed: string[] = [];
  pm.on('process_resumed', (p: any) => resumed.push(p.pid));
  const killed: string[] = [];
  pm.on('process_killed', (pid: string) => killed.push(pid));
  const handle = (engineId: string) => createEngineProcesses({ processManager: pm }, engineId);
  const rows = () =>
    Array.from(pm.processes.values())
      .map((p) => `${p.pid} app=${p.app} engine=${p.engine} type=${p.type}`)
      .sort();
  /** 窓を持たせる（jsdom では iframe が文書に付かないので contentWindow が無い） */
  const giveWindow = (pid: string) => {
    const win = { tag: `win-${pid}` };
    (pm.processes.get(pid) as any).iframe = { contentWindow: win, remove() {} };
    return win;
  };
  return {
    pm,
    root: handle(ROOT_ENGINE_ID),
    a: handle('eng-a'),
    b: handle('eng-b'),
    rows,
    resumed,
    killed,
    evals,
    transport,
    giveWindow,
  };
}

const toolError = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    return { name: (e as Error).name, message: (e as Error).message };
  }
  return null;
};

describe('engineProcesses: 起こす', () => {
  it('起こしたプロセスは、その取っ手のエンジンに仕える', () => {
    const w = mk();
    void w.root.spawn({ path: NOTES, show: false });
    void w.a.spawn({ path: NOTES, show: false });
    void w.a.spawn({ path: SYNC });
    expect(w.rows()).toEqual([
      'notes app=notes engine=root type=app',
      'notes-2 app=notes engine=eng-a type=app',
      'sync_daemon app=sync_daemon engine=eng-a type=daemon',
    ]);
  });

  it('名指し: 空いた名前・自分に仕えるプロセスの名前は使える（再開）', () => {
    const w = mk();
    void w.a.spawn({ pid: 'mine', path: NOTES, show: false });
    void w.a.spawn({ pid: 'mine', path: NOTES, show: false });
    expect(w.rows()).toEqual(['mine app=notes engine=eng-a type=app']);
    expect(w.resumed).toEqual(['mine']);
  });

  it('名指し: ほかのエンジンに仕えるプロセスの名前は断る（再開も起こし直しもしない）', async () => {
    const w = mk();
    void w.root.spawn({ path: NOTES, show: false });
    void w.b.spawn({ pid: 'theirs', path: NOTES, show: false });

    expect(await toolError(w.a.spawn({ pid: 'notes', path: NOTES, show: false }))).toEqual({
      name: 'ToolError',
      message: 'Process "notes" serves another engine ("root"). This engine cannot resume or restart it.',
    });
    expect(await toolError(w.a.spawn({ pid: 'theirs', path: NOTES, forceReload: true }))).toEqual({
      name: 'ToolError',
      message: 'Process "theirs" serves another engine ("eng-b"). This engine cannot resume or restart it.',
    });
    expect(w.rows()).toEqual(['notes app=notes engine=root type=app', 'theirs app=notes engine=eng-b type=app']);
    expect(w.resumed).toEqual([]);
    expect(w.killed).toEqual([]);
  });

  it('名指し: ルートは、ほかのエンジンに仕えるプロセスも動かせる', () => {
    const w = mk();
    void w.a.spawn({ pid: 'theirs', path: NOTES, show: false });
    void w.root.spawn({ pid: 'theirs', path: NOTES, show: false });
    expect(w.resumed).toEqual(['theirs']);
  });

  it('名前なし: このエンジンから見た「そのアプリ」の個体になる（居れば再開・ほかのエンジンの個体には触らない）', () => {
    const w = mk();
    void w.root.spawn({ path: NOTES, show: false });
    void w.a.spawn({ path: NOTES, show: false });
    void w.a.spawn({ path: NOTES, show: false });
    void w.root.spawn({ path: NOTES, show: false });
    expect(w.rows()).toEqual(['notes app=notes engine=root type=app', 'notes-2 app=notes engine=eng-a type=app']);
    expect(w.resumed).toEqual(['notes-2', 'notes']);
    expect(w.killed).toEqual([]);
  });

  it('起こす口には、「誰が」（このエンジン）と、渡されたものをそのまま渡す（仕える先は関所が決める）', () => {
    const w = mk();
    const spawn = vi.spyOn(w.pm, 'spawn');
    void w.a.spawn({
      pid: 'x',
      path: NOTES,
      type: 'app',
      show: false,
      forceReload: true,
      args: { file: 'a.md' },
      currentUri: 'u',
    });
    expect(spawn.mock.calls[0][0]).toEqual({ kind: 'engine', engine: 'eng-a' });
    expect(spawn.mock.calls[0][1]).toEqual({
      pid: 'x',
      path: NOTES,
      type: 'app',
      show: false,
      forceReload: true,
      args: { file: 'a.md' },
      currentUri: 'u',
    });
    expect(w.rows()).toEqual(['x app=notes engine=eng-a type=app']);
  });

  it('窓の上限で断られたら、道具の失敗として返す', async () => {
    const w = mk();
    for (let i = 0; i < MAX_APPS_SUB; i++) void w.a.spawn({ pid: `w${i}`, path: `data/w${i}.html`, show: false });
    expect(await toolError(w.a.spawn({ pid: 'one-more', path: 'data/more.html', show: false }))).toEqual({
      name: 'ToolError',
      message: `Engine "eng-a" already has ${MAX_APPS_SUB} app windows (limit ${MAX_APPS_SUB}). Close one first.`,
    });
    expect(w.pm.processes.has('one-more')).toBe(false);
  });
});

describe('engineProcesses: 終わらせる', () => {
  it('自分に仕えるプロセスは終わらせられる。居なければ false', () => {
    const w = mk();
    void w.a.spawn({ pid: 'mine', path: NOTES, show: false });
    expect(w.a.kill('mine')).toBe(true);
    expect(w.a.kill('mine')).toBe(false);
    expect(w.killed).toEqual(['mine']);
  });

  it('ほかのエンジンに仕えるプロセスは断る。ルートは全部を終わらせられる', async () => {
    const w = mk();
    void w.root.spawn({ path: NOTES, show: false });
    void w.b.spawn({ pid: 'theirs', path: NOTES, show: false });

    expect(await toolError(() => w.a.kill('notes'))).toEqual({
      name: 'ToolError',
      message: 'Process "notes" serves another engine ("root"). This engine cannot kill it.',
    });
    expect(await toolError(() => w.a.kill('theirs'))).toEqual({
      name: 'ToolError',
      message: 'Process "theirs" serves another engine ("eng-b"). This engine cannot kill it.',
    });
    expect(w.killed).toEqual([]);

    expect(w.root.kill('theirs')).toBe(true);
    expect(w.killed).toEqual(['theirs']);
  });
});

describe('engineProcesses: 見る', () => {
  it('一覧は全部。仕える先と、自分に仕えているかが付く', () => {
    const w = mk();
    void w.root.spawn({ path: NOTES, show: false });
    void w.a.spawn({ path: SYNC });
    expect(w.a.list()).toEqual([
      { pid: 'notes', path: NOTES, type: 'app', state: 'background', engine: 'root', mine: false },
      { pid: 'sync_daemon', path: SYNC, type: 'daemon', state: 'running', engine: 'eng-a', mine: true },
    ]);
    expect(w.root.list().map((p) => [p.pid, p.mine])).toEqual([
      ['notes', true],
      ['sync_daemon', false],
    ]);
  });

  it('ProcessManager.list() はゲストに渡る形のまま。app と持ち主は listForHost() にだけ付く（T-0916）', () => {
    const w = mk();
    void w.root.spawn({ path: NOTES, show: false });
    void w.a.spawn({ path: SYNC });
    expect(w.pm.list()).toEqual([
      { pid: 'notes', path: NOTES, type: 'app', state: 'background' },
      { pid: 'sync_daemon', path: SYNC, type: 'daemon', state: 'running' },
    ]);
    expect(w.pm.listForHost()).toEqual([
      { pid: 'notes', app: 'notes', engine: 'root', path: NOTES, type: 'app', state: 'background' },
      { pid: 'sync_daemon', app: 'sync_daemon', engine: 'eng-a', path: SYNC, type: 'daemon', state: 'running' },
    ]);
  });

  it('画面写真は、どのプロセスも撮れる（そのまま ProcessManager に渡す）', async () => {
    const w = mk();
    const capture = vi.spyOn(w.pm, 'captureScreenshot').mockResolvedValue('QUJD');
    expect(await w.a.capture('notes', 30000)).toBe('QUJD');
    expect(await w.a.capture()).toBe('QUJD');
    expect(capture.mock.calls).toEqual([
      ['notes', 30000],
      [undefined, undefined],
    ]);
  });
});

describe('engineProcesses: コードを差す', () => {
  it('自分に仕えるプロセスへは届く', async () => {
    const w = mk();
    void w.a.spawn({ pid: 'mine', path: NOTES, show: false });
    const win = w.giveWindow('mine');
    expect(await w.a.evalJs('mine', 'return 1')).toBe(42);
    expect(w.evals).toEqual([{ pid: 'mine', action: 'eval_js', payload: { code: 'return 1' }, target: win }]);
  });

  it('ほかのエンジンに仕えるプロセスへは断る。ルートは全部へ届く', async () => {
    const w = mk();
    void w.root.spawn({ path: NOTES, show: false });
    void w.a.spawn({ pid: 'mine', path: NOTES, show: false });
    w.giveWindow('notes');
    w.giveWindow('mine');

    expect(await toolError(w.a.evalJs('notes', 'return 1'))).toEqual({
      name: 'ToolError',
      message: 'Process "notes" serves another engine ("root"). This engine cannot run code in it.',
    });
    expect(w.evals).toEqual([]);

    expect(await w.root.evalJs('mine', 'return 2')).toBe(42);
    expect(w.evals.map((e) => e.pid)).toEqual(['mine']);
  });

  it('居ない・窓が無いプロセスは、その名前で断る', async () => {
    const w = mk();
    void w.a.spawn({ pid: 'mine', path: NOTES, show: false });
    expect(await toolError(w.a.evalJs('nope', 'return 1'))).toEqual({
      name: 'ToolError',
      message: "Target process 'nope' is not running.",
    });
    expect(await toolError(w.a.evalJs('mine', 'return 1'))).toEqual({
      name: 'ToolError',
      message: "Target process 'mine' is not running.",
    });
    expect(w.evals).toEqual([]);
  });
});
