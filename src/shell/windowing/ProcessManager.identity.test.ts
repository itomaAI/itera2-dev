/**
 * @vitest-environment jsdom
 * プロセスの記録は「何のアプリか」「どのエンジンに仕えるか」「どの個体か」を別々に持つ（T-0903）。
 * 規則そのものは processIdentity.test.ts。ここでは spawn がその規則で記録を作ること・再開と起動し直しで保たれることを見る。
 */
import { describe, expect, it } from 'vitest';
import { ProcessManager } from './ProcessManager';
import { USER_MOVER } from './processGate';
import { ProcessEventRecorder } from '../services/ProcessEventRecorder';

const NOTES = 'system/apps/notes.html';
const SYNC = 'system/services/sync.html';

function mk() {
  const vfs = { releaseContent: async () => {} };
  const registry = {
    getAllApps: () => [{ id: 'notes', path: NOTES }],
    getAllServices: () => [{ id: 'sync_daemon', path: SYNC }],
  };
  const pm = new ProcessManager(vfs as any, registry as any, { homePath: () => 'system/apps/home.html' } as any);
  // compile は終わらせない（記録ができるところまでを見る）
  (pm as any).compiler = { compile: () => new Promise(() => {}) };
  const resumed: string[] = [];
  pm.on('process_resumed', (p: any) => resumed.push(p.pid));
  const rows = () =>
    Array.from(pm.processes.values())
      .map((p) => `${p.pid} app=${p.app} engine=${p.engine} type=${p.type}`)
      .sort();
  return { pm, resumed, rows };
}

describe('ProcessManager — 何のアプリか・仕えるエンジン・個体（T-0903）', () => {
  it('登録簿に在るパスは、その id がアプリ。名前を付けなければ pid もその id、仕える先はルート', () => {
    const { pm, rows } = mk();
    void pm.spawn(USER_MOVER, { path: NOTES, show: false });
    void pm.spawn(USER_MOVER, { path: SYNC });
    void pm.spawn(USER_MOVER, { path: 'system/apps/home.html', show: false });
    expect(rows()).toEqual([
      'home app=home engine=root type=app',
      'notes app=notes engine=root type=app',
      'sync_daemon app=sync_daemon engine=root type=daemon',
    ]);
  });

  it('同じアプリに別の名前を付けると、個体が増える（アプリは同じ）', () => {
    const { pm, rows } = mk();
    void pm.spawn(USER_MOVER, { path: NOTES, show: false });
    void pm.spawn(USER_MOVER, { path: NOTES, pid: 'notes_b', show: false });
    expect(rows()).toEqual(['notes app=notes engine=root type=app', 'notes_b app=notes engine=root type=app']);
  });

  it('名前なしでもう一度起こすと、名前なしの個体を再開する（増えない。名前を付けた個体には触らない）', () => {
    const { pm, rows, resumed } = mk();
    void pm.spawn(USER_MOVER, { path: NOTES, pid: 'notes_b', show: false });
    void pm.spawn(USER_MOVER, { path: NOTES, show: false });
    void pm.spawn(USER_MOVER, { path: NOTES, show: false });
    expect(rows()).toEqual(['notes app=notes engine=root type=app', 'notes_b app=notes engine=root type=app']);
    expect(resumed).toEqual(['notes']);
  });

  it('登録簿に無いパスは、付けた名前がアプリ。名前も無ければパスから', () => {
    const { pm, rows } = mk();
    void pm.spawn(USER_MOVER, { path: 'data/x/tool.html', pid: 'my_tool', type: 'daemon' });
    void pm.spawn(USER_MOVER, { path: 'data/x/tool.html', show: false });
    expect(rows()).toEqual([
      'app_data_x_tool_html app=app_data_x_tool_html engine=root type=app',
      'my_tool app=my_tool engine=root type=daemon',
    ]);
  });

  it('別のエンジンに仕える個体は枝番の pid を持ち、それぞれのエンジンから見た「このアプリ」になる', () => {
    const { pm, rows, resumed } = mk();
    void pm.spawn(USER_MOVER, { path: NOTES, show: false });
    void pm.spawn(USER_MOVER, { path: NOTES, engine: 'e1', show: false });
    expect(rows()).toEqual(['notes app=notes engine=root type=app', 'notes-2 app=notes engine=e1 type=app']);

    void pm.spawn(USER_MOVER, { path: NOTES, engine: 'e1', show: false });
    void pm.spawn(USER_MOVER, { path: NOTES, show: false });
    expect(pm.processes.size).toBe(2);
    expect(resumed).toEqual(['notes-2', 'notes']);
  });

  it('再開では、仕える先は変わらない（名前で指しても）', () => {
    const { pm, rows, resumed } = mk();
    void pm.spawn(USER_MOVER, { path: 'data/x/tool.html', pid: 'my_tool', type: 'daemon', engine: 'e1' });
    void pm.spawn(USER_MOVER, { path: 'data/x/tool.html', pid: 'my_tool', type: 'daemon' });
    expect(resumed).toEqual(['my_tool']);
    expect(rows()).toEqual(['my_tool app=my_tool engine=e1 type=daemon']);
  });

  it('全部起動し直しても、ルートに仕えるプロセスのアプリ・仕える先・pid は同じ。ほかのエンジンに仕えるものは終わる（T-0908）', () => {
    const { pm, rows } = mk();
    void pm.spawn(USER_MOVER, { path: NOTES, show: false });
    void pm.spawn(USER_MOVER, { path: NOTES, engine: 'e1', show: false });
    void pm.spawn(USER_MOVER, { path: NOTES, pid: 'notes_b', show: false });
    void pm.spawn(USER_MOVER, { path: 'data/x/tool.html', pid: 'my_tool', type: 'daemon', engine: 'e1' });
    const before = rows();
    const frames = Array.from(pm.processes.values()).map((p) => p.iframe);

    void (pm as any).restartAll();

    // ほかのエンジンは、持ち主が起こし直された時点で畳まれる。仕えていたプロセスを起こし直すと、仕える先が無い
    expect(rows()).toEqual(before.filter((row) => row.includes(' engine=root ')));
    expect(rows()).toHaveLength(2);
    // 起動し直している（iframe は作り直されている）
    expect(Array.from(pm.processes.values()).every((p) => !frames.includes(p.iframe))).toBe(true);
  });

  it('プロセスの記録（process_events）に app と engine が載る', () => {
    const { pm } = mk();
    const lines: any[] = [];
    new ProcessEventRecorder(pm, { log: (_kind: string, payload: any) => lines.push(payload) } as any).start();
    void pm.spawn(USER_MOVER, { path: NOTES, engine: 'e1', pid: 'notes_b', show: false });
    pm.kill(USER_MOVER, 'notes_b');
    expect(lines.map((l) => [l.action, l.pid, l.app, l.engine])).toEqual([
      ['spawned', 'notes_b', 'notes', 'e1'],
      ['killed', 'notes_b', 'notes', 'e1'],
    ]);
  });
});
