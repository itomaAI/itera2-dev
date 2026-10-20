/**
 * src/core/control/tools/fsToolsRename.test.ts
 * 中身の三つ組 {read, edit, write} と attach_file、旧名の別名（T-0683）
 *
 * 守りたいこと:
 *   - read はテキスト専用。バイナリ（拡張子・NUL）は断り、attach_file（PDF なら pdf_tool も）へ誘導する
 *   - attach_file は丸ごと。start/end/pages が付いていたら断る（「範囲を指定したつもり」を作らない）
 *   - write は create / overwrite / append。append は改行をはさむ。両方の旗は断る
 *   - edit は append を受けない（write へ）
 *   - 旧名は旧挙動のまま動き、結果の先頭で新名を教える（read_file はバイナリを添付し、edit_file は append を受ける）
 */

import { describe, it, expect } from 'vitest';
import { registerFSTools } from './fs_tools';
import { ToolError } from '../ToolError';

/* eslint-disable @typescript-eslint/no-explicit-any */
function tools() {
  const defs: Record<string, any> = {};
  const registry: any = { registerSystemTool: (_a: string, _b: string, def: any) => (defs[def.name] = def) };
  registerFSTools(registry);
  return defs;
}

/** 文字列のファイルだけを持つ偽の VFS */
function fakeVfs(files: Record<string, string>) {
  const store = { ...files };
  return {
    store,
    ctx: {
      vfs: {
        exists: (_p: unknown, path: string) => path in store,
        stat: (_p: unknown, path: string) => ({
          name: path.split('/').pop(),
          path,
          kind: 'file',
          size: store[path].length,
        }),
        readFile: async (_p: unknown, path: string) => store[path],
        writeFile: async (_p: unknown, path: string, content: string, opts: { overwrite?: boolean } = {}) => {
          if (path in store && !opts.overwrite) throw new ToolError(`File already exists: ${path}`);
          store[path] = content;
          return `Wrote ${path}`;
        },
      },
    } as any,
  };
}

const TEXT = ['line 1', 'line 2', 'line 3'].join('\n');

describe('read', () => {
  it('テキストは行の範囲で読む', async () => {
    const { ctx } = fakeVfs({ 'a.md': TEXT });
    const r = await tools().read.impl({ path: 'a.md', start: '2', end: '3' }, ctx);
    expect(r.log).toBe('Lines 2-3 of 3:\nline 2\nline 3');
  });
  it('バイナリの拡張子は断って attach_file へ', async () => {
    const { ctx } = fakeVfs({ 'x.png': 'PNG' });
    await expect(tools().read.impl({ path: 'x.png', start: '1' }, ctx)).rejects.toThrow(
      /not a text file.*<attach_file/,
    );
  });
  it('PDF は断って pdf_tool と attach_file へ', async () => {
    const { ctx } = fakeVfs({ 'd.pdf': '%PDF' });
    await expect(tools().read.impl({ path: 'd.pdf' }, ctx)).rejects.toThrow(/pdf_tool.*pdf_pages.*<attach_file>/);
  });
  it('拡張子がテキストでも NUL を含めば断る', async () => {
    const { ctx } = fakeVfs({ 'odd.txt': 'ab\0cd' });
    await expect(tools().read.impl({ path: 'odd.txt' }, ctx)).rejects.toThrow(/binary content/);
  });
  it('切れたときの続きの注記は <read start=...>', async () => {
    const many = Array.from({ length: 801 }, (_, i) => `l${i + 1}`).join('\n');
    const { ctx } = fakeVfs({ 'big.txt': many });
    const r = await tools().read.impl({ path: 'big.txt' }, ctx);
    expect(r.log).toContain('Use <read start="801"> to read more');
  });
});

describe('attach_file', () => {
  it('丸ごと media で返す。MIME はパスから', async () => {
    const { ctx } = fakeVfs({ 'x.png': 'PNG', 'd.pdf': '%PDF', 'n.md': '# hi' });
    const t = tools();
    const png = await t.attach_file.impl({ path: 'x.png' }, ctx);
    expect(png.media).toEqual({ path: 'x.png', mimeType: 'image/png', metadata: {} });
    const pdf = await t.attach_file.impl({ path: 'd.pdf' }, ctx);
    expect(pdf.media.mimeType).toBe('application/pdf');
    expect(pdf.log).toMatch(/Every page of the PDF was sent.*pdf_tool/);
    const md = await t.attach_file.impl({ path: 'n.md' }, ctx);
    expect(md.media.mimeType).toBe('text/plain');
  });
  it('範囲の属性が付いていたら断る（黙って無視しない）', async () => {
    const { ctx } = fakeVfs({ 'd.pdf': '%PDF' });
    for (const params of [{ start: '1' }, { end: '3' }, { pages: '1-2' }]) {
      await expect(tools().attach_file.impl({ path: 'd.pdf', ...params }, ctx)).rejects.toThrow(/no range/);
    }
  });
  it('無いファイルは断る', async () => {
    const { ctx } = fakeVfs({});
    await expect(tools().attach_file.impl({ path: 'nope.png' }, ctx)).rejects.toThrow(/not found/i);
  });
});

describe('write', () => {
  it('新規は作り、既存は旗が無ければ断る', async () => {
    const { ctx, store } = fakeVfs({ 'a.md': 'old' });
    const t = tools();
    await t.write.impl({ path: 'b.md', content: '\nnew\n' }, ctx);
    expect(store['b.md']).toBe('new');
    await expect(t.write.impl({ path: 'a.md', content: 'x' }, ctx)).rejects.toThrow(
      /overwrite="true".*append="true".*<edit>/,
    );
    await t.write.impl({ path: 'a.md', content: 'x', overwrite: 'true' }, ctx);
    expect(store['a.md']).toBe('x');
  });
  it('append は改行をはさんで末尾に足す。無ければ作る', async () => {
    const { ctx, store } = fakeVfs({ 'log.txt': 'first' });
    const t = tools();
    const r = await t.write.impl({ path: 'log.txt', content: 'second', append: 'true' }, ctx);
    expect(r.log).toBe('Appended to end of log.txt');
    expect(store['log.txt']).toBe('first\nsecond');
    await t.write.impl({ path: 'log.txt', content: 'third', append: 'true' }, ctx);
    expect(store['log.txt']).toBe('first\nsecond\nthird');
    await t.write.impl({ path: 'new.txt', content: 'x', append: 'true' }, ctx);
    expect(store['new.txt']).toBe('x');
  });
  it('overwrite と append の両方は断る', async () => {
    const { ctx } = fakeVfs({});
    await expect(
      tools().write.impl({ path: 'a', content: 'x', overwrite: 'true', append: 'true' }, ctx),
    ).rejects.toThrow(/Choose one/);
  });
});

describe('edit', () => {
  it('SEARCH と行指定は動き、append は write へ', async () => {
    const { ctx, store } = fakeVfs({ 'a.md': TEXT });
    const t = tools();
    await t.edit.impl({ path: 'a.md', content: '\n<<<<<SEARCH\nline 2\n=====\nLINE 2\n>>>>>\n' }, ctx);
    expect(store['a.md']).toBe('line 1\nLINE 2\nline 3');
    await t.edit.impl({ path: 'a.md', mode: 'delete', start: '3', end: '3' }, ctx);
    expect(store['a.md']).toBe('line 1\nLINE 2');
    await expect(t.edit.impl({ path: 'a.md', mode: 'append', content: 'x' }, ctx)).rejects.toThrow(
      /<write path="..." append="true">/,
    );
    await expect(t.edit.impl({ path: 'a.md', content: 'no markers' }, ctx)).rejects.toThrow(/Invalid <edit> content/);
  });
});

describe('旧名（別名）', () => {
  it('read_file はテキストを読み、バイナリは添付する（旧挙動）。先頭に新名の注記', async () => {
    const { ctx } = fakeVfs({ 'a.md': TEXT, 'x.png': 'PNG' });
    const t = tools();
    const txt = await t.read_file.impl({ path: 'a.md', start: '1', end: '1' }, ctx);
    expect(txt.log).toMatch(/^\[read_file is a legacy name.*<read>.*<attach_file>.*\]\nLines 1-1 of 3:\nline 1/s);
    expect(txt.log).toContain('Use <read_file start="2"> to read more');
    const png = await t.read_file.impl({ path: 'x.png', start: '1' }, ctx);
    expect(png.media.mimeType).toBe('image/png');
    expect(png.log).toMatch(/^\[read_file is a legacy name/);
  });
  it('create_file は write（append は無い）', async () => {
    const { ctx, store } = fakeVfs({ 'a.md': 'old' });
    const t = tools();
    const r = await t.create_file.impl({ path: 'b.md', content: 'new' }, ctx);
    expect(r.log).toMatch(/^\[create_file is a legacy name.*<write>/);
    expect(store['b.md']).toBe('new');
    await expect(t.create_file.impl({ path: 'a.md', content: 'x' }, ctx)).rejects.toThrow(/already exists/);
    // 旧名には append は無い（渡しても見ない）
    await t.create_file.impl({ path: 'a.md', content: 'x', append: 'true', overwrite: 'true' }, ctx);
    expect(store['a.md']).toBe('x');
  });
  it('edit_file は append も受ける（旧挙動）', async () => {
    const { ctx, store } = fakeVfs({ 'a.md': TEXT });
    const r = await tools().edit_file.impl({ path: 'a.md', mode: 'append', content: 'line 4' }, ctx);
    expect(r.log).toMatch(/^\[edit_file is a legacy name.*<write append="true">.*\]\nAppended to end of file$/s);
    expect(store['a.md']).toBe('line 1\nline 2\nline 3\nline 4');
  });
});
