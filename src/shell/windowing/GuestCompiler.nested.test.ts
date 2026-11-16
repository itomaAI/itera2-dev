// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { GuestCompiler } from './GuestCompiler';
import type { GuestDocument } from './GuestCompiler';
import { nestedBootstrapHtml } from './guestBoot';
import { assetOf, docOf, markersPrecede, page, parse, textOf, vfsOf, MARKER } from './guestCompilerTestKit';

/**
 * src/shell/windowing/GuestCompiler.nested.test.ts
 *
 * 入れ子の文書（アプリが枠に書いた VFS の HTML。T-0827）。守るのは:
 *   1. 枠（`<iframe src>`・`<embed src>`・`<object data>`）に書いた VFS の HTML は、親の束に混ざらず、自分の束
 *      （資源 kind: 'doc'）を持つ。子の束の中の目印は、すべて子の束の資源のもの —— 親が作る URL を子は読めないので、
 *      親の目印が 1 つでも子に入れば、その資源は読めない
 *   2. 枠に入るのは 1 段目の文書の目印（＋`#hash`）。1 段目は、その目印で親に束を頼む
 *   3. HTML でないもの・読めないもの・枠以外の書き方で指した HTML は、前と同じ（ふつうの資源）
 *   4. 自分や祖先を枠に入れた参照は辿らない
 */

const compile = (entries: Parameters<typeof vfsOf>[0], entry = 'apps/index.html') =>
  new GuestCompiler().compile(vfsOf(entries), entry, 'test');

/** 束の中（文書と text の資源）に書かれている目印 */
const markersIn = (doc: GuestDocument) => [doc.html, ...doc.assets.map(textOf)].flatMap((s) => s.match(MARKER) ?? []);
const idsOf = (doc: GuestDocument) => new Set(doc.assets.map((a) => a.id));
const shape = (doc: GuestDocument) => doc.assets.map((a) => [a.path, a.kind]);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GuestCompiler: 入れ子の文書は自分の束を持つ', () => {
  it('枠に書いた VFS の HTML は親の束に混ざらない。親と子が同じファイルを使えば、両方の束に載る', async () => {
    const compiled = await compile({
      'apps/index.html': page(
        '<img src="img/logo.png"><iframe src="sub/page.html"></iframe>',
        '<link rel="stylesheet" href="main.css">',
      ),
      'apps/main.css': 'body { background: url(img/logo.png); }',
      'apps/img/logo.png': 'LOGO',
      'apps/sub/page.html': page(
        '<img id="logo" src="../img/logo.png"><img id="pic" src="pic.png"><script src="sub.js"></script>',
        '<link rel="stylesheet" href="../main.css">',
      ),
      'apps/sub/pic.png': 'PIC',
      'apps/sub/sub.js': 'window.sub = 1;',
    });

    expect(shape(compiled)).toEqual([
      ['apps/img/logo.png', 'blob'],
      ['apps/main.css', 'text'],
      ['apps/sub/page.html', 'doc'],
    ]);
    const frame = assetOf(compiled.assets, 'apps/sub/page.html');
    const child = docOf(frame);
    expect(shape(child)).toEqual([
      ['apps/sub/sub.js', 'blob'],
      ['apps/img/logo.png', 'blob'],
      ['apps/main.css', 'text'],
      ['apps/sub/pic.png', 'blob'],
    ]);

    // 枠に入るのは 1 段目の文書の目印。1 段目はその目印で親に束を頼む
    expect(frame.mime).toBe('text/html');
    expect(parse(compiled.html).querySelector('iframe')!.getAttribute('src')).toBe(frame.id);
    expect(frame.kind === 'doc' && frame.boot).toBe(nestedBootstrapHtml(frame.id));
    expect(frame.kind === 'doc' && frame.boot).toContain(`window.__ITERA_DOC__ = "${frame.id}";`);

    // 子の文書の参照は、子の束の資源を指す
    const cid = (path: string) => assetOf(child.assets, path).id;
    const childDoc = parse(child.html);
    expect(childDoc.querySelector('#logo')!.getAttribute('src')).toBe(cid('apps/img/logo.png'));
    expect(childDoc.querySelector('#pic')!.getAttribute('src')).toBe(cid('apps/sub/pic.png'));
    expect(childDoc.querySelector('script')!.getAttribute('src')).toBe(cid('apps/sub/sub.js'));
    expect(childDoc.querySelector('link')!.getAttribute('href')).toBe(cid('apps/main.css'));
    expect(textOf(assetOf(child.assets, 'apps/main.css'))).toBe(
      `body { background: url(${cid('apps/img/logo.png')}); }`,
    );

    // 束は閉じている: 子の中の目印は全部子の資源のもの。親の中の目印は全部親の資源のもの。同じファイルでも目印は別
    expect(markersIn(child).length).toBeGreaterThan(0);
    for (const m of markersIn(child)) expect(idsOf(child).has(m)).toBe(true);
    for (const m of markersIn(compiled)) expect(idsOf(compiled).has(m)).toBe(true);
    expect(cid('apps/img/logo.png')).not.toBe(assetOf(compiled.assets, 'apps/img/logo.png').id);
    expect(markersPrecede(compiled.assets)).toBe(true);
    expect(markersPrecede(child.assets)).toBe(true);

    // ブリッジ・PID を入れるのは入口だけ（入れ子の文書に MetaOS は無い）
    expect(compiled.html).toContain('window.__ITERA_PID__ = "test";');
    expect(child.html).not.toContain('__ITERA_PID__');
    expect(child.html).not.toContain('__ITERA_PATH__');
  });

  it('`#hash` は枠の参照に残り、`?query` は落ちる。同じ文書を枠に何度書いても束は 1 つ', async () => {
    const { html, assets } = await compile({
      'apps/index.html': page(
        '<iframe id="a" src="sub/page.html#one"></iframe>' +
          '<iframe id="b" src="./sub/page.html?x=1#two"></iframe>' +
          '<iframe id="c" src="/apps/sub/page.html"></iframe>',
      ),
      'apps/sub/page.html': page('<p>sub</p>'),
    });
    expect(shape({ html, assets })).toEqual([['apps/sub/page.html', 'doc']]);
    const id = assets[0].id;
    const doc = parse(html);
    expect(doc.querySelector('#a')!.getAttribute('src')).toBe(`${id}#one`);
    expect(doc.querySelector('#b')!.getAttribute('src')).toBe(`${id}#two`);
    expect(doc.querySelector('#c')!.getAttribute('src')).toBe(id);
  });

  it('<embed src>・<object data> の HTML も入れ子の文書。HTML でないもの（PDF・SVG）は枠に書いても実体のまま', async () => {
    const { html, assets } = await compile({
      'apps/index.html': page(
        '<embed src="e.html"><object data="o.html"></object>' +
          '<iframe src="doc.pdf"></iframe><embed src="pic.svg"><object data="doc.pdf"></object>',
      ),
      'apps/e.html': page('<p>e</p>'),
      'apps/o.html': page('<p>o</p>'),
      'apps/doc.pdf': 'PDF',
      'apps/pic.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    });
    expect(shape({ html, assets })).toEqual([
      ['apps/doc.pdf', 'blob'],
      ['apps/e.html', 'doc'],
      ['apps/pic.svg', 'blob'],
      ['apps/o.html', 'doc'],
    ]);
    const id = (path: string) => assetOf(assets, path).id;
    const doc = parse(html);
    expect(doc.querySelector('embed[src]')!.getAttribute('src')).toBe(id('apps/e.html'));
    expect(doc.querySelector('object')!.getAttribute('data')).toBe(id('apps/o.html'));
    expect(doc.querySelector('iframe')!.getAttribute('src')).toBe(id('apps/doc.pdf'));
  });

  it('入れ子の入れ子も、文書ごとの束になる', async () => {
    const compiled = await compile({
      'apps/index.html': page('<iframe src="a.html"></iframe>'),
      'apps/a.html': page('<img src="x.png"><iframe src="deep/b.html#top"></iframe>'),
      'apps/deep/b.html': page('<img src="../x.png">'),
      'apps/x.png': 'X',
    });
    expect(shape(compiled)).toEqual([['apps/a.html', 'doc']]);
    const a = docOf(compiled.assets[0]);
    expect(shape(a)).toEqual([
      ['apps/x.png', 'blob'],
      ['apps/deep/b.html', 'doc'],
    ]);
    const b = docOf(a.assets[1]);
    expect(shape(b)).toEqual([['apps/x.png', 'blob']]);
    expect(parse(a.html).querySelector('iframe')!.getAttribute('src')).toBe(`${a.assets[1].id}#top`);
    expect(parse(b.html).querySelector('img')!.getAttribute('src')).toBe(b.assets[0].id);
    // 3 つの束の目印は互いに重ならない
    const all = [compiled, a, b].flatMap((d) => d.assets.map((x) => x.id));
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('GuestCompiler: 入れ子の文書にしないもの', () => {
  it('読めない HTML（無い・フォルダ）を指す枠は、前と同じ 404 の画面（スクリプトの無い text の資源）', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { assets } = await compile({
      'apps/index.html': page('<iframe src="gone.html"></iframe><iframe src="dir.html"></iframe>'),
      'apps/dir.html': { kind: 'directory' },
    });
    expect(assets.map((a) => [a.path, a.kind, a.mime])).toEqual([
      ['apps/gone.html', 'text', 'text/html'],
      ['apps/dir.html', 'text', 'text/html'],
    ]);
    expect(textOf(assets[0])).toContain('404');
    expect(textOf(assets[0])).not.toContain('<script');
  });

  it('自分や祖先の文書を枠に入れた参照は、言って、書かれたまま残す（終わらない入れ子を作らない）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const compiled = await compile({
      'apps/index.html': page('<iframe id="self" src="index.html"></iframe><iframe id="a" src="a.html"></iframe>'),
      'apps/a.html': page('<iframe id="up" src="index.html"></iframe><iframe id="me" src="./a.html"></iframe>'),
    });
    expect(shape(compiled)).toEqual([['apps/a.html', 'doc']]);
    expect(parse(compiled.html).querySelector('#self')!.getAttribute('src')).toBe('index.html');
    const a = docOf(compiled.assets[0]);
    expect(a.assets).toEqual([]);
    expect(parse(a.html).querySelector('#up')!.getAttribute('src')).toBe('index.html');
    expect(parse(a.html).querySelector('#me')!.getAttribute('src')).toBe('./a.html');
    const said = warn.mock.calls.map((c) => String(c[0]));
    expect(said).toHaveLength(3);
    for (const line of said) expect(line).toContain('Circular reference');
  });

  it('枠以外の書き方で指した HTML（new URL(…, import.meta.url)）は、前と同じ「参照を解決した文字」の資源。枠にも書けば両方できる', async () => {
    const { assets } = await compile({
      'apps/index.html': page('<iframe src="part.html"></iframe>', '<script type="module" src="main.js"></script>'),
      'apps/main.js': "const u = new URL('./part.html', import.meta.url);\nfetch(u);\n",
      'apps/part.html': page('<img src="x.png">'),
      'apps/x.png': 'X',
    });
    expect(shape({ html: '', assets })).toEqual([
      ['apps/x.png', 'blob'],
      ['apps/part.html', 'text'],
      ['apps/main.js', 'text'],
      ['apps/part.html', 'doc'],
    ]);
    // データとしての HTML は親の束の目印を持つ（親の文書が fetch して自分の DOM に入れれば読める）
    const data = assetOf(assets, 'apps/part.html', 'text');
    expect(parse(textOf(data)).querySelector('img')!.getAttribute('src')).toBe(assetOf(assets, 'apps/x.png').id);
    expect(textOf(assetOf(assets, 'apps/main.js'))).toContain(`new URL('${data.id}', import.meta.url)`);
    // 文書としての HTML は自分の束を持つ
    const child = docOf(assetOf(assets, 'apps/part.html', 'doc'));
    expect(shape(child)).toEqual([['apps/x.png', 'blob']]);
    expect(parse(child.html).querySelector('img')!.getAttribute('src')).toBe(child.assets[0].id);
  });
});
