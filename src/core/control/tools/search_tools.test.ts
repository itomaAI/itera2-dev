/**
 * src/core/control/tools/search_tools.test.ts
 * Itera OS v2: search 道具の limit・打ち切り・path（T-0596）
 *
 * 背景:
 *   limit はファイルとファイルの間でしか見ておらず、1 ファイルの中では固定の 5 件だけが効いていた。
 *   そのため 1 ファイルを limit="1" で探すと 5 件が返った。
 *   ほかに、注記も limit の 1 件と数える／当たりがちょうど limit 件でも「truncated」と出る／
 *   path が素の前方一致（loom が loom_old にも当たる）／stub を飛ばすと「No matches」が出ない、があった。
 */

import { describe, it, expect } from 'vitest';
import { registerSearchTools } from './search_tools';

function run(files: Record<string, string>, params: Record<string, string>, stubs: string[] = []) {
  const defs: Record<string, any> = {};
  registerSearchTools({ registerSystemTool: (_a: string, _b: string, def: any) => (defs[def.name] = def) } as any);
  const vfs: any = {
    listFiles: () => Object.keys(files),
    stat: (_p: unknown, path: string) => ({ syncState: stubs.includes(path) ? 'stub' : 'local' }),
    readFile: async (_p: unknown, path: string) => files[path],
  };
  return defs.search.impl({ query: 'hit', ...params }, { vfs }) as Promise<{ log: string; ui: string }>;
}

const many = (n: number) => Array.from({ length: n }, (_, i) => `hit ${i + 1}`).join('\n');
const lineHits = (log: string) => (log.match(/^File: /gm) || []).length;
const TRUNCATED = 'Search truncated';

describe('search: limit', () => {
  it('limit applies inside a single file (limit="1" returns one match, not five)', async () => {
    const res = await run({ 'a.md': many(8) }, { limit: '1' });
    expect(lineHits(res.log)).toBe(1);
    expect(res.log).toContain(TRUNCATED);
    expect(res.log).not.toContain('and more matches');
    expect(res.ui).toContain('(1+ hits)');
  });

  it('shows at most 5 matches per file and says the file has more (no truncation when the limit is not reached)', async () => {
    const res = await run({ 'a.md': many(8), 'b.md': 'hit' }, {});
    expect(lineHits(res.log)).toBe(6);
    expect(res.log).toContain('  ... and more matches in a.md');
    expect(res.log).not.toContain(TRUNCATED);
    expect(res.ui).toContain('(6 hits)');
  });

  it('a limit below 5 is reached before the per-file cap', async () => {
    const res = await run({ 'a.md': many(8), 'b.md': many(8) }, { limit: '3' });
    expect(lineHits(res.log)).toBe(3);
    expect(res.log).toContain(TRUNCATED);
    expect(res.log).not.toContain('and more matches');
  });

  it('counts matches across files', async () => {
    const res = await run({ 'a.md': many(2), 'b.md': many(2), 'c.md': many(2) }, { limit: '4' });
    expect(lineHits(res.log)).toBe(4);
    expect(res.log).toContain('File: b.md');
    expect(res.log).not.toContain('File: c.md');
    expect(res.log).toContain(TRUNCATED);
  });

  it('does not claim truncation when the matches are exactly the limit', async () => {
    const res = await run({ 'a.md': many(2), 'b.md': 'nothing' }, { limit: '2' });
    expect(lineHits(res.log)).toBe(2);
    expect(res.log).not.toContain(TRUNCATED);
    expect(res.ui).toContain('(2 hits)');
  });

  it('a path match counts as one match', async () => {
    const res = await run({ 'hit.md': 'nothing', 'x.md': 'hit' }, { limit: '1' });
    expect(res.log).toContain('[Path Match] hit.md');
    expect(lineHits(res.log)).toBe(0);
    expect(res.log).toContain(TRUNCATED);
  });
});

describe('search: path', () => {
  const files = {
    'data/apps/loom/a.md': 'hit',
    'data/apps/loom_old/b.md': 'hit',
    'data/apps/loomx.md': 'hit',
  };

  it.each(['data/apps/loom', 'data/apps/loom/'])('%j covers the directory and nothing beside it', async (path) => {
    const res = await run(files, { path });
    expect(res.log).toContain('File: data/apps/loom/a.md');
    expect(res.log).not.toContain('loom_old');
    expect(res.log).not.toContain('loomx');
  });

  it('a file path covers that file', async () => {
    const res = await run(files, { path: 'data/apps/loom/a.md' });
    expect(lineHits(res.log)).toBe(1);
  });

  it('system/logs is excluded unless the path points there', async () => {
    const logs = { 'system/logs/x.jsonl': 'hit', 'a.md': 'hit' };
    expect((await run(logs, {})).log).not.toContain('system/logs');
    expect((await run(logs, { path: 'system/logs' })).log).toContain('File: system/logs/x.jsonl');
  });
});

describe('search: no matches', () => {
  it('says "No matches found" even when stub files were skipped', async () => {
    const res = await run({ 'a.md': 'nothing', 's.md': '' }, {}, ['s.md']);
    expect(res.log.startsWith('No matches found.')).toBe(true);
    expect(res.log).toContain('1 stub files were skipped');
  });
});
