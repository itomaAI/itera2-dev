/**
 * src/core/control/tools/fsToolsRace.test.ts
 * 同じファイルへの edit / write append が 1 ターンに並んでも、全部が入る（T-0714）
 *
 * Engine は道具を並行に開始する。読み→直す→書く の 3 手に錠が無いと、全部が最初の中身を読み、
 * SEARCH は全部一致して success を返したまま、最後の書き込みだけが残る。
 * ここでは読みを遅らせた VFS で 4 つを同時に出し、4 つとも残ることを見る。
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

/** 読みが遅い VFS（IndexedDB の遅延の代わり）。書きは即時 */
function slowVfs(initial: Record<string, string>, readDelayMs = 20) {
  const files = { ...initial };
  const writes: string[] = [];
  const vfs: any = {
    exists: (_p: any, path: string) => path in files,
    readFile: async (_p: any, path: string) => {
      // 読みに行った時点の中身を返す（IndexedDB と同じ。返るまでの間に書かれても見えない）
      if (!(path in files)) throw new Error(`not found: ${path}`);
      const snapshot = files[path];
      await new Promise((r) => setTimeout(r, readDelayMs));
      return snapshot;
    },
    writeFile: async (_p: any, path: string, content: string) => {
      files[path] = content;
      writes.push(path);
      return `Wrote ${path}`;
    },
  };
  return { vfs, files, writes };
}

const block = (from: string, to: string) => `<<<<<SEARCH\n${from}\n=====\n${to}\n>>>>>`;

describe('同じパスへの書き換えは直列になる（T-0714）', () => {
  it('edit × 4 を同時に出しても 4 つとも入る', async () => {
    const { vfs, files } = slowVfs({ 'a.md': 'one\ntwo\nthree\nfour' });
    const t = tools();
    const ctx = { vfs } as any;
    const results = await Promise.all([
      t.edit.impl({ path: 'a.md', content: block('one', 'ONE') }, ctx),
      t.edit.impl({ path: 'a.md', content: block('two', 'TWO') }, ctx),
      t.edit.impl({ path: 'a.md', content: block('three', 'THREE') }, ctx),
      t.edit.impl({ path: 'a.md', content: block('four', 'FOUR') }, ctx),
    ]);
    expect(results.every((r) => !r.error)).toBe(true);
    expect(files['a.md']).toBe('ONE\nTWO\nTHREE\nFOUR');
  });

  it('edit と write append が混ざっても順に入る', async () => {
    const { vfs, files } = slowVfs({ 'b.md': 'head' });
    const t = tools();
    const ctx = { vfs } as any;
    await Promise.all([
      t.edit.impl({ path: 'b.md', content: block('head', 'HEAD') }, ctx),
      t.write.impl({ path: 'b.md', append: 'true', content: 'tail' }, ctx),
    ]);
    expect(files['b.md']).toBe('HEAD\ntail');
  });

  it('1 つが失敗しても鎖は切れず、後の 1 つは入る', async () => {
    const { vfs, files } = slowVfs({ 'c.md': 'x' });
    const t = tools();
    const ctx = { vfs } as any;
    const [bad, good] = await Promise.allSettled([
      t.edit.impl({ path: 'c.md', content: block('missing', 'M') }, ctx),
      t.edit.impl({ path: 'c.md', content: block('x', 'X') }, ctx),
    ]);
    expect(bad.status).toBe('rejected');
    expect(good.status).toBe('fulfilled');
    expect(files['c.md']).toBe('X');
  });

  it('別のパスどうしは待たない（直列化は同じパスの中だけ）', async () => {
    const { vfs, files } = slowVfs({ 'd.md': 'd', 'e.md': 'e' }, 30);
    const t = tools();
    const ctx = { vfs } as any;
    const t0 = Date.now();
    await Promise.all([
      t.edit.impl({ path: 'd.md', content: block('d', 'D') }, ctx),
      t.edit.impl({ path: 'e.md', content: block('e', 'E') }, ctx),
    ]);
    expect(files['d.md']).toBe('D');
    expect(files['e.md']).toBe('E');
    expect(Date.now() - t0).toBeLessThan(55); // 直列なら 60 ms 以上かかる
  });
});
