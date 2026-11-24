import { describe, expect, it } from 'vitest';
import { resolvePrincipal } from './principal';

const SYNC = 'system/services/sync.html';

/** pid `d` のプロセス 1 つと、登録簿の `d` の項目 1 つ */
function deps(path: string | undefined, service: any, proc: Record<string, unknown> = {}) {
  const processes = new Map<string, any>();
  if (path !== undefined) processes.set('d', { pid: 'd', app: 'd', path, ...proc });
  return {
    processManager: { processes },
    appRegistry: { getService: (id: string) => (id === 'd' ? service : undefined) },
  };
}

describe('resolvePrincipal (T-0617)', () => {
  it('system/ 配下のデーモンで登録簿に systemPrivilege: true があれば system', () => {
    expect(resolvePrincipal('d', deps(SYNC, { id: 'd', path: SYNC, systemPrivilege: true }))).toEqual({
      type: 'system',
      id: 'd',
    });
  });

  it('登録簿の印が無ければ system/ 配下でも app', () => {
    expect(resolvePrincipal('d', deps(SYNC, { id: 'd', path: SYNC }))).toEqual({ type: 'app', id: 'd' });
    expect(resolvePrincipal('d', deps(SYNC, { id: 'd', path: SYNC, systemPrivilege: false }))).toEqual({
      type: 'app',
      id: 'd',
    });
    expect(resolvePrincipal('d', deps(SYNC, { id: 'd', path: SYNC, systemPrivilege: 'true' }))).toEqual({
      type: 'app',
      id: 'd',
    });
  });

  it('印があっても system/ の外（利用者の置いた HTML）なら app', () => {
    const user = 'user/apps/sync.html';
    expect(resolvePrincipal('d', deps(user, { id: 'd', path: user, systemPrivilege: true }))).toEqual({
      type: 'app',
      id: 'd',
    });
  });

  it('プロセスが見つからない・登録簿が無いときは app（id は pid）', () => {
    expect(resolvePrincipal('d', deps(undefined, { id: 'd', path: SYNC, systemPrivilege: true }))).toEqual({
      type: 'app',
      id: 'd',
    });
    expect(resolvePrincipal('d', {})).toEqual({ type: 'app', id: 'd' });
    expect(resolvePrincipal('d', { processManager: null, appRegistry: null })).toEqual({ type: 'app', id: 'd' });
  });
});

describe('resolvePrincipal: 主体は個体（pid）からではなく、アプリから（T-0903）', () => {
  const privileged = { id: 'd', path: SYNC, systemPrivilege: true };
  /** 好きな pid のプロセス 1 つ */
  const withProc = (pid: string, proc: Record<string, unknown>, service: any = privileged) => ({
    processManager: { processes: new Map<string, any>([[pid, { pid, ...proc }]]) },
    appRegistry: { getService: (id: string) => (id === 'd' ? service : undefined) },
  });

  it('同じアプリの個体は、pid が違っても同じ主体（枝番の個体・名前を付けた個体）', () => {
    expect(resolvePrincipal('d-2', withProc('d-2', { app: 'd', path: SYNC }))).toEqual({ type: 'system', id: 'd' });
    expect(resolvePrincipal('second', withProc('second', { app: 'd', path: SYNC }))).toEqual({
      type: 'system',
      id: 'd',
    });
    expect(resolvePrincipal('notes_b', withProc('notes_b', { app: 'notes', path: 'system/apps/notes.html' }))).toEqual({
      type: 'app',
      id: 'notes',
    });
  });

  it('特権のあるデーモンの名前を付けただけの別のファイルは system にならない', () => {
    // 登録簿に在る別のファイル: アプリはそのファイルの id（processIdentity が決める）
    expect(resolvePrincipal('d', withProc('d', { app: 'pdf_tool', path: 'system/services/pdf_tool.html' }))).toEqual({
      type: 'app',
      id: 'pdf_tool',
    });
    // 登録簿に無いファイル: アプリは付けた名前（d）になるが、登録簿の d の項目はこのファイルを指していない
    expect(resolvePrincipal('d', withProc('d', { app: 'd', path: 'system/temp/evil.html' }))).toEqual({
      type: 'app',
      id: 'd',
    });
  });

  it('申告された場所（?query・#hash）が付いていても、ファイルは同じ', () => {
    expect(resolvePrincipal('d', withProc('d', { app: 'd', path: `${SYNC}?view=log#top` }))).toEqual({
      type: 'system',
      id: 'd',
    });
  });

  it('記録に app が無い古い形は pid をアプリとして扱う', () => {
    expect(resolvePrincipal('d', withProc('d', { path: SYNC }))).toEqual({ type: 'system', id: 'd' });
  });
});
