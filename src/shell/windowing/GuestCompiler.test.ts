// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { GuestCompiler, withFragment, typedBlob, stripSourceMapComment } from './GuestCompiler';
import type { GuestAsset } from './GuestCompiler';
import type { VfsService } from '../../core/vfs/VfsService';

/**
 * src/shell/windowing/GuestCompiler.test.ts
 *
 * コンパイラは URL を作らない。返すのは「目印を埋めた入口の HTML」と「資源の束（後順）」で、
 * object URL はゲストが自分の窓で作る（二段起動。T-0770 / T-0784）。ここで守るのは:
 *   1. 読めないパスを要求されたまま返さない（T-0196。SPA リライトの配信先で親 OS が iframe の中で起動する）
 *   2. 資源の参照に ?query を載せない（T-0542。Firefox は ?query 付きの blob URL を読まない）。#hash は残す
 *   3. 束の形: 子が先に並び、text の資源が参照する目印はそれより前にある。実体は読まずに Blob のまま
 *   4. 1 回の compile の状態が他の compile と混ざらない（コンパイラは全プロセスで共有・並行に呼ばれる）
 */

type Entry = { kind: 'file' | 'directory'; text?: string; mimeType?: string; delayMs?: number };

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 最小の VFS。text を持つものがファイル。readBlob は型の無い Blob を返す（OPFS の File と同じ） */
function vfsOf(entries: Record<string, Entry | string>): VfsService {
  const norm = (e: Entry | string): Entry => (typeof e === 'string' ? { kind: 'file', text: e } : e);
  const get = (path: string) => (path in entries ? norm(entries[path]) : undefined);
  return {
    exists: (_p: unknown, path: string) => get(path) !== undefined,
    stat: (_p: unknown, path: string) => ({ kind: get(path)!.kind, updatedAt: 1, mimeType: get(path)!.mimeType }),
    readFile: async (_p: unknown, path: string) => {
      const e = get(path)!;
      if (e.delayMs) await delay(e.delayMs);
      return e.text ?? '';
    },
    readBlob: async (_p: unknown, path: string) => {
      const e = get(path)!;
      if (e.delayMs) await delay(e.delayMs);
      return new Blob([e.text ?? '']);
    },
  } as unknown as VfsService;
}

const page = (body: string, head = '') => `<html><head>${head}</head><body>${body}</body></html>`;
const refsIn = (html: string, attr: string) =>
  [...html.matchAll(new RegExp(`${attr}="([^"]*)"`, 'g'))].map((m) => m[1]);
const MARKER = /^__ITERA_ASSET_[a-z0-9]+_\d+__(#.*)?$/;
const textOf = (a: GuestAsset) => (a.kind === 'text' ? a.text : '');

describe('GuestCompiler: 読めないパス（T-0196）', () => {
  it('存在しない入口は 404 の画面になる。要求されたパスは文書の中にしか現れず、資源は無い', async () => {
    const { html, assets } = await new GuestCompiler().compile(vfsOf({}), 'apps/missing.html', 'test');
    expect(html).toContain('404');
    expect(html).toContain('apps/missing.html');
    expect(html).not.toContain('<script');
    expect(assets).toEqual([]);
  });

  it('ディレクトリ・外部 URL・空のパスを入口にしても同じ（ゲストの入口は VFS の文書だけ）', async () => {
    const compiler = new GuestCompiler();
    for (const entry of ['apps', 'https://example.com/x.html', '']) {
      const { html, assets } = await compiler.compile(vfsOf({ apps: { kind: 'directory' } }), entry, 'test');
      expect(html).toContain('404');
      expect(html).not.toContain('<script');
      expect(assets).toEqual([]);
    }
  });

  it('依存が無いときは、その参照だけが 404 の文書（text の資源）になり、入口は起動する', async () => {
    const vfs = vfsOf({ 'apps/a.html': page('<img src="nope.png">') });
    const { html, assets } = await new GuestCompiler().compile(vfs, 'apps/a.html', 'test');
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({ kind: 'text', path: 'apps/nope.png', mime: 'text/html' });
    expect(textOf(assets[0])).toContain('404');
    expect(refsIn(html, 'src').filter((s) => MARKER.test(s))).toEqual([assets[0].id]);
    expect(html).toContain('__ITERA_PID__');
  });
});

describe('GuestCompiler: 資源の束（T-0770）', () => {
  const vfs = vfsOf({
    'apps/a.html': page(
      '<img src="../img/logo.png#v">',
      '<script src="lib.js?v=2"></script><link rel="stylesheet" href="s.css">',
    ),
    'apps/lib.js': 'window.x = 1;',
    'apps/s.css': 'body { background: url("bg.png"); } .x { background: url(bg.png) }',
    'apps/bg.png': 'PNG',
    'img/logo.png': { kind: 'file', text: 'LOGO', mimeType: 'image/png' },
  });

  it('子が先に並び、text の資源の目印はそれより前にある。実体は Blob、入口と CSS は text', async () => {
    const { assets } = await new GuestCompiler().compile(vfs, 'apps/a.html', 'test');
    expect(assets.map((a) => [a.path, a.kind])).toEqual([
      ['apps/lib.js', 'blob'],
      ['apps/bg.png', 'blob'],
      ['apps/s.css', 'text'],
      ['img/logo.png', 'blob'],
    ]);
    const [lib, bg, css] = assets;
    expect(textOf(css)).toContain(bg.id);
    expect(textOf(css)).not.toContain('bg.png');
    // 同じ資源への 2 つ目の参照は同じ目印
    expect(textOf(css).split(bg.id)).toHaveLength(3);
    for (const a of assets) expect(a.id).toMatch(MARKER);
    expect(new Set(assets.map((a) => a.id)).size).toBe(assets.length);
    expect(lib.kind === 'blob' && lib.blob.type).toBe('application/javascript');
  });

  it('MIME は stat のものを優先し、無ければ拡張子から。Blob にその型が付く', async () => {
    const { assets } = await new GuestCompiler().compile(vfs, 'apps/a.html', 'test');
    const logo = assets.find((a) => a.path === 'img/logo.png')!;
    expect(logo.mime).toBe('image/png');
    expect(logo.kind === 'blob' && logo.blob.type).toBe('image/png');
    expect(new GuestCompiler().getMimeType('x.unknownext')).toBe('application/octet-stream');
    expect(new GuestCompiler().getMimeType('f.woff2')).toBe('font/woff2');
  });

  it('入口の参照は目印に置き換わり、元のパスは残らない。?query は捨て、#hash は目印の後ろに残る（T-0542）', async () => {
    const { html, assets } = await new GuestCompiler().compile(vfs, 'apps/a.html', 'test');
    expect(html).not.toContain('lib.js');
    expect(html).not.toContain('s.css');
    expect(html).not.toContain('logo.png');
    const refs = [...refsIn(html, 'src'), ...refsIn(html, 'href')].filter((r) => r.startsWith('__ITERA_ASSET_'));
    expect(refs).toHaveLength(3);
    for (const r of refs) expect(r).not.toContain('?');
    const logo = assets.find((a) => a.path === 'img/logo.png')!;
    expect(refs).toContain(logo.id + '#v');
  });

  it('入口の ?query は捨て、#hash は束に乗る（ゲストが location.hash に写す）', async () => {
    const compiler = new GuestCompiler();
    const a = await compiler.compile(vfs, 'apps/a.html?skill=%E8%A6%8B&view=history', 'test');
    expect(a.hash).toBe('');
    expect(a.html).not.toContain('view=history');
    const b = await compiler.compile(vfs, 'apps/a.html?x=1#sec', 'test');
    expect(b.hash).toBe('#sec');
  });

  it('循環参照（a.css → b.css → a.css）で止まらない', async () => {
    const cyc = vfsOf({
      'apps/a.html': page('', '<link rel="stylesheet" href="a.css">'),
      'apps/a.css': '@import url(b.css);',
      'apps/b.css': '@import url(a.css);',
    });
    const { assets } = await new GuestCompiler().compile(cyc, 'apps/a.html', 'test');
    expect(assets.map((a) => a.path)).toEqual(['apps/b.css', 'apps/a.css']);
  });

  it('withFragment は hash だけを載せる', () => {
    expect(withFragment('m', '?a=1', '#h')).toBe('m#h');
    expect(withFragment('m', '?a=1', '')).toBe('m');
  });

  it('typedBlob は型が同じなら同じ Blob を返し、違えば型だけ付け替える', () => {
    const b = new Blob(['x'], { type: 'image/png' });
    expect(typedBlob(b, 'image/png')).toBe(b);
    const c = typedBlob(new Blob(['x']), 'text/css');
    expect(c.type).toBe('text/css');
    expect(c.size).toBe(1);
  });
});

describe('GuestCompiler: 入口への注入', () => {
  it('PID・引数・ブリッジ・テーマ・撮影の助っ人が入る。引数は閉じタグで壊れない JSON', async () => {
    const vfs = vfsOf({ 'apps/a.html': page('<p>a</p>') });
    const { html } = await new GuestCompiler().compile(vfs, 'apps/a.html', 'p1', { q: '</script><b>' });
    expect(html).toContain('window.__ITERA_PID__ = "p1"');
    expect(html).toContain('window.__ITERA_ARGS__ = {"q":"\\u003c/script\\u003e\\u003cb\\u003e"}');
    expect(html).toContain('MetaOS Bridge v2');
    expect(html).toContain('id="itera-guest-theme"');
    expect(html).toContain("e.data.action === 'CAPTURE'");
    expect(html).toMatch(/^<!DOCTYPE html>/);
    // ブリッジは <script src> ではなく本文に入っている（opaque origin のゲストは別の文書を読めない）
    expect(html).not.toMatch(/<script src="blob:/);
  });
});

describe('GuestCompiler: 並行する compile は混ざらない', () => {
  it('2 つの起動が同時に走っても、それぞれの束は自分の資源だけを持つ', async () => {
    const compiler = new GuestCompiler();
    const vfsA = vfsOf({
      'a/a.html': page('', '<link rel="stylesheet" href="a.css"><script src="a.js"></script>'),
      'a/a.css': { kind: 'file', text: 'body{background:url(a.png)}', delayMs: 15 },
      'a/a.png': { kind: 'file', text: 'A', delayMs: 10 },
      'a/a.js': { kind: 'file', text: 'a', delayMs: 5 },
    });
    const vfsB = vfsOf({
      'b/b.html': page('', '<link rel="stylesheet" href="b.css"><script src="b.js"></script>'),
      'b/b.css': { kind: 'file', text: 'body{background:url(b.png)}', delayMs: 5 },
      'b/b.png': { kind: 'file', text: 'B', delayMs: 15 },
      'b/b.js': { kind: 'file', text: 'b', delayMs: 10 },
    });
    const [a, b] = await Promise.all([
      compiler.compile(vfsA, 'a/a.html', 'pa'),
      compiler.compile(vfsB, 'b/b.html', 'pb'),
    ]);
    // 文書の中の順（script → link）に解決し、CSS はその中の url() を先に積む
    expect(a.assets.map((x) => x.path)).toEqual(['a/a.js', 'a/a.png', 'a/a.css']);
    expect(b.assets.map((x) => x.path)).toEqual(['b/b.js', 'b/b.png', 'b/b.css']);
    const cssA = textOf(a.assets.find((x) => x.path === 'a/a.css')!);
    for (const x of a.assets) expect(a.html.includes(x.id) || cssA.includes(x.id)).toBe(true);
    for (const x of b.assets) expect(a.html).not.toContain(x.id);
    expect(a.html).toContain('__ITERA_PID__ = "pa"');
    expect(b.html).toContain('__ITERA_PID__ = "pb"');
  });
});

describe('インラインで埋めるライブラリの sourceMappingURL（T-0787）', () => {
  it('末尾の //# sourceMappingURL の行だけを剥がす。本体と、文字列の中の同じ語は触らない', () => {
    const src = "var a = 1;\nvar s = '//# sourceMappingURL=in-a-string.map';\n//# sourceMappingURL=lib.js.map\n";
    const out = stripSourceMapComment(src);
    expect(out).toContain('var a = 1;');
    expect(out).toContain("'//# sourceMappingURL=in-a-string.map'");
    expect(out).not.toMatch(/^\/\/# sourceMappingURL=/m);
    expect(stripSourceMapComment('//@ sourceMappingURL=old.map')).toBe('');
    expect(stripSourceMapComment('  //# sourceMappingURL=x.map\r\n')).toBe('\r\n');
  });

  it('起動する文書に sourceMappingURL のコメントが残らない（html-to-image を埋めている）', async () => {
    const vfs = vfsOf({ 'apps/a.html': '<html><body>hi</body></html>' });
    const { html } = await new GuestCompiler().compile(vfs, 'apps/a.html', 'test');
    expect(html).toContain('htmlToImage');
    expect(html).not.toMatch(/^\s*\/\/[#@]\s*sourceMappingURL=/m);
  });
});
