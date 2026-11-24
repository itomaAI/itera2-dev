import { describe, expect, it } from 'vitest';
import { appIdFromPath, choosePid, resolveApp } from './processIdentity';

const registry = {
  getAllApps: () => [{ id: 'notes', path: 'system/apps/notes.html' }],
  getAllServices: () => [{ id: 'sync_daemon', path: 'system/services/sync.html' }],
};
const home = () => 'system/apps/home.html';

describe('resolveApp: 何のアプリか（T-0903）', () => {
  it('登録簿にそのパスが在れば、その id（付けた名前より先）', () => {
    expect(resolveApp('system/apps/notes.html', undefined, registry, home)).toEqual({
      app: 'notes',
      defaultType: 'app',
    });
    expect(resolveApp('system/apps/notes.html', 'second_notes', registry, home)).toEqual({
      app: 'notes',
      defaultType: 'app',
    });
    expect(resolveApp('system/services/sync.html', 'whatever', registry, home)).toEqual({
      app: 'sync_daemon',
      defaultType: 'daemon',
    });
  });

  it('登録簿に無いホームのパスは home', () => {
    expect(resolveApp('system/apps/home.html', undefined, registry, home)).toEqual({ app: 'home', defaultType: 'app' });
    expect(resolveApp('system/apps/home.html', 'x', registry, home)).toEqual({ app: 'home', defaultType: 'app' });
  });

  it('登録簿に無いパスは、付けた名前がそのままアプリ。名前も無ければパスから', () => {
    expect(resolveApp('data/x/tool.html', 'my_tool', registry, home)).toEqual({ app: 'my_tool', defaultType: 'app' });
    expect(resolveApp('data/x/tool.html', undefined, registry, home)).toEqual({
      app: 'app_data_x_tool_html',
      defaultType: 'app',
    });
    expect(resolveApp('data/x/tool.html', '', registry, home).app).toBe('app_data_x_tool_html');
    expect(appIdFromPath('data/日本語/a b.html')).toBe('app_data_____a_b_html');
  });

  it('特権のあるデーモンの名前を別のファイルに付けても、そのデーモンにはならない（登録簿に在るファイルなら）', () => {
    // 登録簿に在る別のファイル → そのファイルの id
    expect(resolveApp('system/apps/notes.html', 'sync_daemon', registry, home).app).toBe('notes');
    // 登録簿に無いファイル → 付けた名前（特権を与えないのは principal.ts の側: 登録簿の項目がこのパスを指していること）
    expect(resolveApp('system/temp/evil.html', 'sync_daemon', registry, home).app).toBe('sync_daemon');
  });

  it('登録簿に在れば、ホームのパスは訊かない', () => {
    const never = () => {
      throw new Error('not asked');
    };
    expect(resolveApp('system/apps/notes.html', undefined, registry, never).app).toBe('notes');
  });
});

describe('choosePid: どの個体か（T-0903）', () => {
  const procs = (entries: Record<string, [string, string]>) =>
    new Map(Object.entries(entries).map(([pid, [app, engine]]) => [pid, { app, engine }]));

  it('名前の指定が在れば、それが pid（誰が居ても）', () => {
    expect(choosePid('second_notes', 'notes', 'root', procs({}))).toBe('second_notes');
    expect(choosePid('notes', 'calc', 'root', procs({ notes: ['notes', 'root'] }))).toBe('notes');
  });

  it('指定が無ければアプリの id。同じ（アプリ, エンジン）の個体が居れば、その個体', () => {
    expect(choosePid(undefined, 'notes', 'root', procs({}))).toBe('notes');
    expect(choosePid(undefined, 'notes', 'root', procs({ notes: ['notes', 'root'] }))).toBe('notes');
    expect(choosePid('', 'notes', 'root', procs({}))).toBe('notes');
  });

  it('名前を付けた別の個体が居ても、名前なしはアプリの id の個体を指す', () => {
    expect(choosePid(undefined, 'notes', 'root', procs({ second_notes: ['notes', 'root'] }))).toBe('notes');
  });

  it('アプリの id がほかのエンジンの個体・ほかのアプリで埋まっていれば枝番', () => {
    expect(choosePid(undefined, 'notes', 'e1', procs({ notes: ['notes', 'root'] }))).toBe('notes-2');
    expect(choosePid(undefined, 'notes', 'root', procs({ notes: ['calc', 'root'] }))).toBe('notes-2');
    // 枝番の個体が自分のものなら、それ
    expect(choosePid(undefined, 'notes', 'e1', procs({ notes: ['notes', 'root'], 'notes-2': ['notes', 'e1'] }))).toBe(
      'notes-2',
    );
    // 枝番も他人のものなら、次
    expect(choosePid(undefined, 'notes', 'e2', procs({ notes: ['notes', 'root'], 'notes-2': ['notes', 'e1'] }))).toBe(
      'notes-3',
    );
    // ルートから見れば、アプリの id の個体は自分のもの
    expect(choosePid(undefined, 'notes', 'root', procs({ notes: ['notes', 'root'], 'notes-2': ['notes', 'e1'] }))).toBe(
      'notes',
    );
  });
});
