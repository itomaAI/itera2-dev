/**
 * src/core/control/tools/fsToolsStub.test.ts
 * スタブ（中身がまだ手元に無いファイル）が道具から見えること（T-0351）
 *
 * これが無いと袋小路になる: `search` は「スタブは飛ばした。file_info で見よ」と言うのに、
 * その file_info に印が出ていなかった。中身が手元にあるのか無いのかは、
 * 読む前に判断を変える情報なので、AI から見えていなければならない。
 */

import { describe, it, expect } from 'vitest';
import { registerFSTools } from './fs_tools';

/* eslint-disable @typescript-eslint/no-explicit-any */
function tools() {
  const defs: Record<string, any> = {};
  const registry: any = { registerSystemTool: (_a: string, _b: string, def: any) => (defs[def.name] = def) };
  registerFSTools(registry);
  return defs;
}

const AUG = new Date('2026-08-21T13:40:09Z').getTime();

function statOf(over: Record<string, unknown> = {}) {
  return {
    id: 'n1',
    path: 'local/host/root/a.md',
    name: 'a.md',
    kind: 'file',
    size: 721,
    createdAt: AUG,
    updatedAt: AUG,
    version: 4,
    flags: { isSystem: false, isTrashed: false },
    ...over,
  };
}

function ctxWithStat(stat: any) {
  return { vfs: { stat: () => stat, getAcl: () => undefined } } as any;
}

function ctxWithList(files: any[]) {
  return { vfs: { listFiles: () => files } } as any;
}

describe('file_info: スタブかどうかが出る', () => {
  it('スタブなら stub と、意味（中身はまだ手元に無い）が出る', async () => {
    const res = await tools().file_info.impl({ path: 'x' }, ctxWithStat(statOf({ syncState: 'stub' })));
    expect(res.log).toContain('Sync: stub');
    expect(res.log).toContain('not in the VFS yet');
  });

  it('実体があるなら synced', async () => {
    const res = await tools().file_info.impl({ path: 'x' }, ctxWithStat(statOf({ syncState: 'synced' })));
    expect(res.log).toContain('Sync: synced');
  });

  it('同期の対象でないファイルには余計な行を足さない', async () => {
    const res = await tools().file_info.impl({ path: 'x' }, ctxWithStat(statOf()));
    expect(res.log).not.toContain('Sync:');
  });

  it('スタブでも大きさと日付はそのまま出る（0 バイト扱いにしない）', async () => {
    const res = await tools().file_info.impl({ path: 'x' }, ctxWithStat(statOf({ syncState: 'stub' })));
    expect(res.log).toContain('Size: 721 bytes');
    expect(res.log).toContain('2026-08-21T13:40:09');
  });
});

describe('list_files detail: スタブの印', () => {
  it('スタブの行にだけ stub が付く', async () => {
    const files = [
      statOf({ path: 'x/stub.md', syncState: 'stub' }),
      statOf({ path: 'x/real.md', syncState: 'synced' }),
    ];
    const res = await tools().list_files.impl({ path: 'x', detail: 'true' }, ctxWithList(files));
    const lines = res.log.split('\n');
    expect(lines[0]).toContain('stub.md');
    expect(lines[0]).toContain('| stub');
    expect(lines[1]).toContain('real.md');
    expect(lines[1]).not.toContain('| stub');
  });

  it('大きさと日付は従来どおりの並び（列を壊さない）', async () => {
    const res = await tools().list_files.impl(
      { path: 'x', detail: 'true' },
      ctxWithList([statOf({ path: 'x/a.md', syncState: 'stub' })]),
    );
    expect(res.log).toContain('721 B'); // 1024 未満は B 表記のまま
    expect(res.log).toContain('2026-08-21 13:40:09');
  });

  it('detail を付けなければ従来どおりパスだけ', async () => {
    const res = await tools().list_files.impl({ path: 'x' }, ctxWithList(['x/a.md', 'x/b.md']));
    expect(res.log).toBe('x/a.md\nx/b.md');
  });
});
