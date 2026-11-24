import { describe, expect, it } from 'vitest';
import { resolvePrincipal } from './principal';

const SYNC = 'system/services/sync.html';

/** 特権の表の偽物: 載っているパスだけ true。訊かれたパスを覚える */
function privilegesOf(...paths: string[]) {
  const asked: string[] = [];
  return {
    asked,
    grants: (path: string) => {
      asked.push(path);
      return paths.includes(path);
    },
  };
}

/** 好きな pid のプロセス 1 つ */
const withProc = (pid: string, proc: Record<string, unknown>, privileges: unknown = privilegesOf(SYNC)) => ({
  processManager: { processes: new Map<string, any>([[pid, { pid, ...proc }]]) },
  privileges: privileges as { grants(path: string): boolean } | null,
});

describe('resolvePrincipal: 特権は、何のファイルかで決まる（T-0617・T-0904）', () => {
  it('配信物の特権の表に載っているファイルで動くプロセスは system', () => {
    expect(resolvePrincipal('d', withProc('d', { app: 'd', path: SYNC }))).toEqual({ type: 'system', id: 'd' });
  });

  it('表に載っていないファイルは app（`system/` の下でも）', () => {
    expect(resolvePrincipal('d', withProc('d', { app: 'd', path: 'system/services/other.html' }))).toEqual({
      type: 'app',
      id: 'd',
    });
    expect(resolvePrincipal('d', withProc('d', { app: 'd', path: 'system/temp/evil.html' }))).toEqual({
      type: 'app',
      id: 'd',
    });
    expect(resolvePrincipal('d', withProc('d', { app: 'd', path: 'user/apps/sync.html' }))).toEqual({
      type: 'app',
      id: 'd',
    });
  });

  it('表が true のほかを返しても system にならない', () => {
    const odd = { grants: () => 'yes' as unknown as boolean };
    expect(resolvePrincipal('d', withProc('d', { app: 'd', path: SYNC }, odd))).toEqual({ type: 'app', id: 'd' });
  });

  it('プロセスが見つからない・表が無いときは app（id は pid）', () => {
    expect(resolvePrincipal('d', { processManager: { processes: new Map() }, privileges: privilegesOf(SYNC) })).toEqual(
      {
        type: 'app',
        id: 'd',
      },
    );
    expect(resolvePrincipal('d', {})).toEqual({ type: 'app', id: 'd' });
    expect(resolvePrincipal('d', { processManager: null, privileges: null })).toEqual({ type: 'app', id: 'd' });
    expect(resolvePrincipal('d', withProc('d', { app: 'd', path: SYNC }, null))).toEqual({ type: 'app', id: 'd' });
  });

  it('パスの無いプロセスは、表に訊かずに app', () => {
    const privileges = privilegesOf('');
    expect(resolvePrincipal('d', withProc('d', { app: 'd' }, privileges))).toEqual({ type: 'app', id: 'd' });
    expect(privileges.asked).toEqual([]);
  });
});

describe('resolvePrincipal: 主体は個体（pid）からではなく、アプリから（T-0903）', () => {
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
    expect(resolvePrincipal('d', withProc('d', { app: 'pdf_tool', path: 'system/services/pdf_tool.html' }))).toEqual({
      type: 'app',
      id: 'pdf_tool',
    });
    expect(resolvePrincipal('d', withProc('d', { app: 'd', path: 'system/temp/evil.html' }))).toEqual({
      type: 'app',
      id: 'd',
    });
  });

  it('申告された場所（?query・#hash）が付いていても、ファイルは同じ（表にはファイルのパスで訊く）', () => {
    const privileges = privilegesOf(SYNC);
    expect(resolvePrincipal('d', withProc('d', { app: 'd', path: `${SYNC}?view=log#top` }, privileges))).toEqual({
      type: 'system',
      id: 'd',
    });
    expect(privileges.asked).toEqual([SYNC]);
  });

  it('記録に app が無い古い形は pid をアプリとして扱う', () => {
    expect(resolvePrincipal('d', withProc('d', { path: SYNC }))).toEqual({ type: 'system', id: 'd' });
  });
});
