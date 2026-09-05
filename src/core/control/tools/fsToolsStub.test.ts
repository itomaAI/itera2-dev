/**
 * src/core/control/tools/fsToolsStub.test.ts
 * スタブが道具から見えること（T-0351）と、実体の有無と管轄が直交すること（T-0352）
 *
 * これが無いと袋小路になる: `search` は「スタブは飛ばした。file_info で見よ」と言うのに、
 * その file_info に印が出ていなかった。中身が手元にあるのか無いのかは、
 * 読む前に判断を変える情報なので、AI から見えていなければならない。
 *
 * 軸は 2 つある。混ぜると「取りに行ける stub」と「取りに行けない stub（孤児）」を区別できない。
 *   実体があるか（syncState） … ファイル自身の性質。node.meta に保存される
 *   誰の管轄か（syncProvider） … 保存しない。stat が毎回マウント表から導く
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

const PROVIDER = { mountPath: 'local/yachiyo/ws_itera', pid: 'local_bridge', alive: true };
/** 登録は在るが、その担当プロセスが落ちている（T-0353。マウントは死んでも消えない） */
const DEAD_PROVIDER = { ...PROVIDER, alive: false };

describe('file_info: 実体の有無と管轄を分けて出す', () => {
  it('管轄下のスタブ … 実体が無いことと、取りに行ける相手が出る', async () => {
    const res = await tools().file_info.impl(
      { path: 'x' },
      ctxWithStat(statOf({ syncState: 'stub', syncProvider: PROVIDER })),
    );
    expect(res.log).toContain('Sync: stub (metadata only; the content is not in the VFS yet)');
    expect(res.log).toContain('provider=local_bridge (mount=/local/yachiyo/ws_itera)');
    expect(res.log).not.toContain('orphaned');
  });

  it('管轄下で実体もある … local copy と管轄が出る（直交の証明）', async () => {
    const res = await tools().file_info.impl({ path: 'x' }, ctxWithStat(statOf({ syncProvider: PROVIDER })));
    expect(res.log).toContain('Sync: local copy / provider=local_bridge');
    expect(res.log).not.toContain('stub');
  });

  it('孤児のスタブ … 取りに行けないことを言う（黙って stub とだけ言わない）', async () => {
    const res = await tools().file_info.impl({ path: 'x' }, ctxWithStat(statOf({ syncState: 'stub' })));
    expect(res.log).toContain('Sync: stub');
    expect(res.log).toContain('orphaned stub');
    expect(res.log).toContain('can never be fetched');
  });

  it('管轄外の素のファイルには余計な行を足さない', async () => {
    const res = await tools().file_info.impl({ path: 'x' }, ctxWithStat(statOf()));
    expect(res.log).not.toContain('Sync:');
    expect(res.log).not.toContain('Mount point:');
  });

  it("死んだ値 'synced' を印字しない（本番コードでファイルに付くことは無い）", async () => {
    const res = await tools().file_info.impl({ path: 'x' }, ctxWithStat(statOf({ syncState: 'synced' })));
    expect(res.log).not.toContain('Sync: synced');
  });

  it('マウント地点そのものには、その旨を足す', async () => {
    const res = await tools().file_info.impl(
      { path: 'x' },
      ctxWithStat(statOf({ syncProvider: PROVIDER, isMountPoint: true })),
    );
    expect(res.log).toContain('Mount point: yes');
  });

  it('スタブでも大きさと日付はそのまま出る（0 バイト扱いにしない）', async () => {
    const res = await tools().file_info.impl(
      { path: 'x' },
      ctxWithStat(statOf({ syncState: 'stub', syncProvider: PROVIDER })),
    );
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

describe('file_info: 担当が居ても応じられないとき（T-0353）', () => {
  it('落ちている担当は「動いていない」と明示する', async () => {
    const res = await tools().file_info.impl(
      { path: 'x' },
      ctxWithStat(statOf({ syncState: 'stub', syncProvider: DEAD_PROVIDER })),
    );
    expect(res.log).toContain('provider=local_bridge');
    expect(res.log).toContain('NOT RUNNING');
    // 孤児（そもそも担当が居ない）とは別の状態である
    expect(res.log).not.toContain('orphaned stub');
  });

  it('生きている担当には余計な警告を出さない', async () => {
    const res = await tools().file_info.impl(
      { path: 'x' },
      ctxWithStat(statOf({ syncState: 'stub', syncProvider: PROVIDER })),
    );
    expect(res.log).not.toContain('NOT RUNNING');
  });
});
