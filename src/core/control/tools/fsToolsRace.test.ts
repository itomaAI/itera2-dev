/**
 * src/core/control/tools/fsToolsRace.test.ts
 * 同じファイルへの edit / write append が 1 ターンに並んでも、全部が入る（T-0714 → 版の照合に乗せ直した T-0715）
 *
 * Engine は道具を並行に開始する。読み→直す→書く の 3 手に錠が無いと、全部が最初の中身を読み、
 * SEARCH は全部一致して success を返したまま、最後の書き込みだけが残る。
 * ここでは読みを遅らせた VFS で 4 つを同時に出し、4 つとも残ることを見る。
 */

import { describe, it, expect } from 'vitest';
import { registerFSTools } from './fs_tools';
import { VfsService } from '../../vfs/VfsService';
import { VfsError } from '../../vfs/VfsError';

/* eslint-disable @typescript-eslint/no-explicit-any */
function tools() {
  const defs: Record<string, any> = {};
  const registry: any = { registerSystemTool: (_a: string, _b: string, def: any) => (defs[def.name] = def) };
  registerFSTools(registry);
  return defs;
}

/**
 * 読みが遅い VFS（IndexedDB の遅延の代わり）。版を持ち、writeFile は ifVersion を本物と同じに見る。
 * updateFile は本物（VfsService.prototype）を使う —— 道具が版の照合に乗っていることをここで確かめる（T-0715）。
 */
function slowVfs(initial: Record<string, string>, readDelayMs = 20) {
  const files = new Map<string, { content: string; version: number }>();
  for (const [k, v] of Object.entries(initial)) files.set(k, { content: v, version: 1 });
  const writes: string[] = [];
  const vfs: any = Object.create(VfsService.prototype);
  vfs.pathResolver = { normalizePath: (p: string) => p };
  vfs.exists = (_p: any, path: string) => files.has(path);
  vfs.readFileWithVersion = async (_p: any, path: string) => {
    // 読みに行った時点の中身と版を返す（返るまでの間に書かれても見えない）
    const f = files.get(path);
    if (!f) throw new VfsError('ENOENT', `File not found: ${path}`);
    const snapshot = { content: f.content, version: f.version };
    await new Promise((r) => setTimeout(r, readDelayMs));
    return snapshot;
  };
  vfs.readFile = async (_p: any, path: string) => (await vfs.readFileWithVersion(_p, path)).content;
  vfs.writeFile = async (_p: any, path: string, content: string, opts: any = {}) => {
    const f = files.get(path);
    const current = f ? f.version : 0;
    if (opts.ifVersion !== undefined && opts.ifVersion !== current) {
      throw new VfsError(
        'ESTALE',
        `Stale write to ${path}: expected version ${opts.ifVersion} but the file is at version ${current}.`,
      );
    }
    if (f && !opts.overwrite) throw new VfsError('EEXIST', `File already exists at ${path}.`);
    files.set(path, { content, version: current + 1 });
    writes.push(path);
    return `Wrote ${path}`;
  };
  const text = (path: string) => files.get(path)?.content;
  return { vfs, text, writes };
}

const block = (from: string, to: string) => `<<<<<SEARCH\n${from}\n=====\n${to}\n>>>>>`;

describe('同じパスへの書き換えは全部入る（T-0714 / T-0715 版の照合）', () => {
  it('edit × 4 を同時に出しても 4 つとも入る', async () => {
    const { vfs, text } = slowVfs({ 'a.md': 'one\ntwo\nthree\nfour' });
    const t = tools();
    const ctx = { vfs } as any;
    const results = await Promise.all([
      t.edit.impl({ path: 'a.md', content: block('one', 'ONE') }, ctx),
      t.edit.impl({ path: 'a.md', content: block('two', 'TWO') }, ctx),
      t.edit.impl({ path: 'a.md', content: block('three', 'THREE') }, ctx),
      t.edit.impl({ path: 'a.md', content: block('four', 'FOUR') }, ctx),
    ]);
    expect(results.every((r) => !r.error)).toBe(true);
    expect(text('a.md')).toBe('ONE\nTWO\nTHREE\nFOUR');
  });

  it('edit と write append が混ざっても順に入る', async () => {
    const { vfs, text } = slowVfs({ 'b.md': 'head' });
    const t = tools();
    const ctx = { vfs } as any;
    await Promise.all([
      t.edit.impl({ path: 'b.md', content: block('head', 'HEAD') }, ctx),
      t.write.impl({ path: 'b.md', append: 'true', content: 'tail' }, ctx),
    ]);
    expect(text('b.md')).toBe('HEAD\ntail');
  });

  it('1 つが失敗しても鎖は切れず、後の 1 つは入る', async () => {
    const { vfs, text } = slowVfs({ 'c.md': 'x' });
    const t = tools();
    const ctx = { vfs } as any;
    const [bad, good] = await Promise.allSettled([
      t.edit.impl({ path: 'c.md', content: block('missing', 'M') }, ctx),
      t.edit.impl({ path: 'c.md', content: block('x', 'X') }, ctx),
    ]);
    expect(bad.status).toBe('rejected');
    expect(good.status).toBe('fulfilled');
    expect(text('c.md')).toBe('X');
  });

  it('別のパスどうしは待たない', async () => {
    const { vfs, text } = slowVfs({ 'd.md': 'd', 'e.md': 'e' }, 30);
    const t = tools();
    const ctx = { vfs } as any;
    const t0 = Date.now();
    await Promise.all([
      t.edit.impl({ path: 'd.md', content: block('d', 'D') }, ctx),
      t.edit.impl({ path: 'e.md', content: block('e', 'E') }, ctx),
    ]);
    expect(text('d.md')).toBe('D');
    expect(text('e.md')).toBe('E');
    expect(Date.now() - t0).toBeLessThan(55); // 直列なら 60 ms 以上かかる
  });
});
