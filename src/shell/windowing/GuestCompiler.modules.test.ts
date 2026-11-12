// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { GuestCompiler } from './GuestCompiler';
import { scanScriptRefs, scriptLexerReady } from './guestRefScan';
import { assetOf, importMapOf, markersPrecede, page, parse, textOf, vfsOf, MARKER } from './guestCompilerTestKit';

/**
 * src/shell/windowing/GuestCompiler.modules.test.ts
 *
 * モジュールの相対 import と、アプリが自分の場所を知る口（T-0822）。守るのは:
 *   1. モジュールの本文の指定子は、書いたファイルのフォルダから解決した合成の指定子（`@vfs/<VFS のパス>`）になる。
 *      本文に子の URL（目印）は入らない —— だから循環する import でも止まらない
 *   2. 文書ごとに import map が 1 枚、最初のモジュールより前に在り、その文書から届くモジュールを実体（目印）に結ぶ
 *   3. アプリが書いた import map は、その 1 枚に取り込まれる（裸の指定子はそれで引く）
 *   4. 拾わないもの（VFS の外・引けない裸の指定子・変数で組んだもの・文字列やコメントの中・字句として読めない本文）は
 *      1 文字も変わらない
 *   5. 入口の文書に、自分の VFS のパスが入る（`window.__ITERA_PATH__`）
 */

const compile = (entries: Parameters<typeof vfsOf>[0], entry: string) =>
  new GuestCompiler().compile(vfsOf(entries), entry, 'test');

const MODULE_MIME = 'application/javascript';

// 試験の中で scanScriptRefs を直に呼ぶ所が在る（compile は自分で待つ）
beforeAll(() => scriptLexerReady);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GuestCompiler: モジュールの相対 import', () => {
  it('指定子は書いたファイルのフォルダから解決され、合成の指定子になる。import map が実体に結ぶ', async () => {
    const { html, assets } = await compile(
      {
        'apps/app/index.html': page('', '<script type="module" src="./main.js"></script>'),
        'apps/app/main.js':
          "import { a } from './lib/a.js';\nimport '../shared/b.js';\nexport * from '/apps/app/lib/a.js';\nconsole.log(a);\n",
        'apps/app/lib/a.js': 'export const a = 1;\n',
        'apps/shared/b.js': 'export const b = 2;\n',
      },
      'apps/app/index.html',
    );

    // 子が先。どれも text（本文を書き換えるので）で、モジュールの MIME が付く
    expect(assets.map((x) => [x.path, x.kind, x.mime])).toEqual([
      ['apps/app/lib/a.js', 'text', MODULE_MIME],
      ['apps/shared/b.js', 'text', MODULE_MIME],
      ['apps/app/main.js', 'text', MODULE_MIME],
    ]);
    const [a, b, main] = assets;

    const body = textOf(main);
    expect(body).toContain("import { a } from '@vfs/apps/app/lib/a.js';");
    expect(body).toContain("import '@vfs/apps/shared/b.js';");
    expect(body).toContain("export * from '@vfs/apps/app/lib/a.js';");
    expect(body).toContain('console.log(a);');
    // 本文に子の URL（目印）は入らない
    expect(body.match(MARKER)).toBeNull();
    // 末尾に VFS のパスの名前（スタックトレースに blob: ではなくパスが出る）
    expect(body.endsWith('\n//# sourceURL=vfs:///apps/app/main.js\n')).toBe(true);
    // 指定子を持たないモジュールは、本文はそのまま・名前だけ付く
    expect(textOf(a)).toBe('export const a = 1;\n\n//# sourceURL=vfs:///apps/app/lib/a.js\n');

    const doc = parse(html);
    expect(doc.querySelector('script[type="module"]')!.getAttribute('src')).toBe(main.id);
    expect(importMapOf(html)).toEqual({
      imports: {
        '@vfs/apps/app/main.js': main.id,
        '@vfs/apps/app/lib/a.js': a.id,
        '@vfs/apps/shared/b.js': b.id,
      },
    });
  });

  it('import map は head に在り、最初のモジュール・modulepreload より前に来る', async () => {
    const { html, assets } = await compile(
      {
        'apps/a.html': page(
          '<script type="module" src="main.js"></script>',
          '<link rel="modulepreload" href="main.js"><script type="module">import "./main.js";</script>',
        ),
        'apps/main.js': 'export {};',
      },
      'apps/a.html',
    );
    const doc = parse(html);
    // modulepreload もモジュールとして読む: <script type="module" src> と同じ 1 つの資源を指す
    expect(assets.map((x) => [x.path, x.kind, x.mime])).toEqual([['apps/main.js', 'text', MODULE_MIME]]);
    expect(doc.querySelector('link[rel="modulepreload"]')!.getAttribute('href')).toBe(assets[0].id);
    expect(doc.querySelector('script[type="module"][src]')!.getAttribute('src')).toBe(assets[0].id);
    const map = doc.querySelector('script[type="importmap"]')!;
    expect(map.parentElement).toBe(doc.head);
    for (const el of Array.from(doc.querySelectorAll('script[type="module"], link[rel="modulepreload"]'))) {
      expect(map.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('循環する import（a → b → a・自分自身）でも止まらず、両方が資源になって結ばれる', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { html, assets } = await compile(
      {
        'apps/a.html': page('', '<script type="module" src="a.js"></script>'),
        'apps/a.js': "import { b } from './b.js';\nimport './a.js';\nexport const a = 1;\n",
        'apps/b.js': "import { a } from './a.js';\nexport const b = 2;\n",
      },
      'apps/a.html',
    );
    expect(assets.map((x) => x.path)).toEqual(['apps/b.js', 'apps/a.js']);
    const [b, a] = assets;
    expect(textOf(a)).toContain("from '@vfs/apps/b.js'");
    expect(textOf(a)).toContain("import '@vfs/apps/a.js'");
    expect(textOf(b)).toContain("from '@vfs/apps/a.js'");
    expect(importMapOf(html)!.imports).toEqual({ '@vfs/apps/a.js': a.id, '@vfs/apps/b.js': b.id });
    expect(markersPrecede(assets)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('?query と #hash は指定子から落ちる（同じファイルは 1 つのモジュール）', async () => {
    const { html, assets } = await compile(
      {
        'apps/a.html': page('', '<script type="module" src="main.js?v=3#top"></script>'),
        'apps/main.js': "import './dep.js?v=1';\nimport './dep.js#x';\nimport './dep.js';\n",
        'apps/dep.js': 'export {};',
      },
      'apps/a.html',
    );
    expect(assets.map((x) => x.path)).toEqual(['apps/dep.js', 'apps/main.js']);
    expect(textOf(assets[1]).match(/'@vfs\/apps\/dep\.js'/g)).toHaveLength(3);
    // 入口の URL には #hash だけが残る（?query 付きの blob: を Firefox は読まない。T-0542）
    expect(parse(html).querySelector('script[type="module"]')!.getAttribute('src')).toBe(assets[1].id + '#top');
  });

  it('引用符や日本語・空白を含むパスでも、書き換えた本文は同じ指定子を持つ JS のまま', async () => {
    const { html, assets } = await compile(
      {
        'apps/a.html': page('', '<script type="module" src="main.js"></script>'),
        'apps/main.js':
          "import './it\\'s.js';\nimport \"./日本 語/モジュール.js\";\nconst m = import('./q\"uote.js');\n",
        "apps/it's.js": 'export {};',
        'apps/日本 語/モジュール.js': 'export {};',
        'apps/q"uote.js': 'export {};',
      },
      'apps/a.html',
    );
    const main = assetOf(assets, 'apps/main.js');
    const body = textOf(main);
    expect(body).toContain("import '@vfs/apps/it\\'s.js';");
    expect(body).toContain('import "@vfs/apps/日本 語/モジュール.js";');
    expect(body).toContain("import('@vfs/apps/q\"uote.js')");
    // 書き換えた本文を読み直すと、指定子は import map の鍵と一致する
    const specifiers = scanScriptRefs(body)!.map((r) => r.value);
    expect(specifiers).toEqual(["@vfs/apps/it's.js", '@vfs/apps/日本 語/モジュール.js', '@vfs/apps/q"uote.js']);
    const imports = importMapOf(html)!.imports;
    for (const s of specifiers) expect(imports[s]).toBe(assetOf(assets, s.slice('@vfs/'.length)).id);
    expect(textOf(assetOf(assets, 'apps/日本 語/モジュール.js'))).toContain(
      `//# sourceURL=vfs:///${encodeURI('apps/日本 語/モジュール.js')}`,
    );
  });

  it('JS でないモジュール（JSON）は実体のまま資源になり、同じ形で結ばれる', async () => {
    const { html, assets } = await compile(
      {
        'apps/a.html': page('', '<script type="module" src="main.js"></script>'),
        'apps/main.js': "import data from './data.json' with { type: 'json' };\nconsole.log(data);\n",
        'apps/data.json': '{"n":1}',
      },
      'apps/a.html',
    );
    const data = assetOf(assets, 'apps/data.json');
    expect(data.kind).toBe('blob');
    expect(data.mime).toBe('application/json');
    expect(textOf(assetOf(assets, 'apps/main.js'))).toContain("from '@vfs/apps/data.json' with { type: 'json' };");
    expect(importMapOf(html)!.imports['@vfs/apps/data.json']).toBe(data.id);
  });

  it('読めないモジュール（無い・フォルダ）は、何が読めないかを言って落ちるモジュールになる', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { html, assets } = await compile(
      {
        'apps/a.html': page(
          '',
          '<script type="module" src="main.js"></script><script type="module" src="gone.js"></script>',
        ),
        'apps/main.js': "import './nope.js';\nimport './lib';\n",
        'apps/lib': { kind: 'directory' },
      },
      'apps/a.html',
    );
    const nope = assetOf(assets, 'apps/nope.js');
    expect(nope).toMatchObject({ kind: 'text', mime: MODULE_MIME });
    expect(textOf(nope)).toMatch(
      /^throw new Error\("Cannot load module \\"apps\/nope\.js\\": .+ \(imported from apps\/main\.js\)"\);\n$/,
    );
    expect(textOf(assetOf(assets, 'apps/lib'))).toMatch(/^throw new Error\("Cannot load module \\"apps\/lib\\": /);
    // 入口のモジュールが無いときは、import 元は付かない
    const gone = assetOf(assets, 'apps/gone.js');
    expect(textOf(gone)).toMatch(/^throw new Error\("Cannot load module \\"apps\/gone\.js\\": [^(]+"\);\n$/);
    // 落ちるモジュールも import map に載る（解決の失敗ではなく、この文が出る）
    const imports = importMapOf(html)!.imports;
    expect(imports['@vfs/apps/nope.js']).toBe(nope.id);
    expect(imports['@vfs/apps/gone.js']).toBe(gone.id);
  });

  it('同じファイルをクラシックとモジュールの両方で読むと、資源は別々（クラシックは実体のまま）', async () => {
    const { html, assets } = await compile(
      {
        'apps/a.html': page('', '<script src="x.js"></script><script type="module" src="x.js"></script>'),
        'apps/x.js': "import './y.js';",
        'apps/y.js': 'export {};',
      },
      'apps/a.html',
    );
    const classic = assetOf(assets, 'apps/x.js', 'blob');
    const module = assetOf(assets, 'apps/x.js', 'text');
    const srcs = Array.from(parse(html).querySelectorAll('script[src]')).map((s) => s.getAttribute('src'));
    expect(srcs).toEqual([classic.id, module.id]);
    expect(importMapOf(html)!.imports['@vfs/apps/x.js']).toBe(module.id);
  });
});

describe('GuestCompiler: HTML に直書きしたスクリプト', () => {
  it('モジュールの import と、クラシックなスクリプトの動的 import を解決する。JS でない type は読まない', async () => {
    const { html, assets } = await compile(
      {
        'apps/dir/a.html': page(
          "<script type=\"module\">import { x } from './m.js';\nconsole.log(x, new URL('./pic.png', import.meta.url).href);</script>" +
            '<script>btn.onclick = () => import("../lazy.js");</script>' +
            '<script type="text/plain">import \'./not-js.js\';</script>' +
            '<script type="application/json">{"import":"./x.js"}</script>',
        ),
        'apps/dir/m.js': 'export const x = 1;',
        'apps/dir/pic.png': 'PNG',
        'apps/lazy.js': 'export {};',
      },
      'apps/dir/a.html',
    );
    const pic = assetOf(assets, 'apps/dir/pic.png');
    expect(html).toContain("import { x } from '@vfs/apps/dir/m.js';");
    expect(html).toContain(`new URL('${pic.id}', import.meta.url).href`);
    expect(html).toContain('btn.onclick = () => import("@vfs/apps/lazy.js");');
    expect(html).toContain('<script type="text/plain">import \'./not-js.js\';</script>');
    expect(html).toContain('<script type="application/json">{"import":"./x.js"}</script>');
    expect(assets.map((x) => x.path).sort()).toEqual(['apps/dir/m.js', 'apps/dir/pic.png', 'apps/lazy.js']);
    expect(importMapOf(html)!.imports).toEqual({
      '@vfs/apps/dir/m.js': assetOf(assets, 'apps/dir/m.js').id,
      '@vfs/apps/lazy.js': assetOf(assets, 'apps/lazy.js').id,
    });
  });

  it('<script type="module"> が 1 つも無く、クラシックから import() するだけの文書にも import map が付く', async () => {
    const { html } = await compile(
      {
        'apps/a.html': page("<script>import('./lazy.js').then((m) => m.run());</script>"),
        'apps/lazy.js': 'export const run = () => {};',
      },
      'apps/a.html',
    );
    const doc = parse(html);
    const map = doc.querySelector('script[type="importmap"]')!;
    const user = Array.from(doc.querySelectorAll('script')).find((s) =>
      (s.textContent || '').includes('.then((m) => m.run())'),
    )!;
    expect(user.textContent).toBe("import('@vfs/apps/lazy.js').then((m) => m.run());");
    expect(map.compareDocumentPosition(user) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(Object.keys(importMapOf(html)!.imports)).toEqual(['@vfs/apps/lazy.js']);
  });

  it('文字列・コメントの中の import、変数で組んだ import() には触らない（import map も足さない）', async () => {
    const script =
      "const s = \"import('./x.js')\"; /* import './y.js' */ // import('./z.js')\nconst t = `import './w.js'`;\nimport(name);\nimport('./' + name);";
    const { html, assets } = await compile({ 'apps/a.html': page(`<script>${script}</script>`) }, 'apps/a.html');
    expect(html).toContain(`<script>${script}</script>`);
    expect(assets).toEqual([]);
    expect(importMapOf(html)).toBeNull();
  });

  it('字句として読めない本文には触らない（誤りはブラウザがそのまま報告する）', async () => {
    const script = "import('./a.js'); const s = 'unterminated;\n}";
    expect(scanScriptRefs(script)).toBeNull(); // 前提: この本文は読めない
    const { html, assets } = await compile(
      { 'apps/a.html': page(`<script>${script}</script>`), 'apps/a.js': 'export {};' },
      'apps/a.html',
    );
    expect(html).toContain(`<script>${script}</script>`);
    expect(assets).toEqual([]);
    expect(importMapOf(html)).toBeNull();
  });
});

describe('GuestCompiler: アプリの import map', () => {
  const importMap = {
    imports: {
      lib: './vendor/lib.js',
      cdn: 'https://cdn.example/x.js',
      'ui/': './ui/',
      extra: './extra.js',
      './rel.js': './other.js',
      '@vfs/apps/x.js': './extra.js',
    },
    scopes: { '/a/': { lib: './v2.js' } },
  };
  const files = {
    'apps/a.html': page(
      '',
      `<script type="importmap">${JSON.stringify(importMap)}</script><script type="module" src="main.js"></script>`,
    ),
    'apps/main.js':
      "import 'lib';\nimport 'cdn';\nimport { B } from 'ui/button.js';\nimport 'unknown';\nimport 'https://esm.example/y.js';\n",
    'apps/vendor/lib.js': 'export {};',
    // 文書とは別のフォルダに在るモジュールが裸の指定子を使う（行き先は文書のフォルダから: apps/vendor/lib.js）
    'apps/ui/button.js': "import 'lib';\nexport const B = 1;",
    'apps/extra.js': 'export {};',
  };

  it('裸の指定子はアプリの import map で引き、行き先は文書のフォルダから解決する。引けないもの・外のものはそのまま', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { assets } = await compile(files, 'apps/a.html');
    const body = textOf(assetOf(assets, 'apps/main.js'));
    expect(body).toContain("import '@vfs/apps/vendor/lib.js';");
    expect(body).toContain("import { B } from '@vfs/apps/ui/button.js';");
    expect(body).toContain("import 'cdn';");
    expect(body).toContain("import 'unknown';");
    expect(body).toContain("import 'https://esm.example/y.js';");
    expect(textOf(assetOf(assets, 'apps/ui/button.js'))).toContain("import '@vfs/apps/vendor/lib.js';");
    expect(assets.some((x) => x.path.startsWith('apps/ui/vendor'))).toBe(false);
  });

  it('文書の import map は 1 枚にまとまる: アプリの項目（VFS のものは実体へ・外のものはそのまま）＋届くモジュール', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { html, assets } = await compile(files, 'apps/a.html');
    const id = (path: string) => assetOf(assets, path).id;
    expect(importMapOf(html)).toEqual({
      imports: {
        lib: id('apps/vendor/lib.js'),
        cdn: 'https://cdn.example/x.js',
        // 本文のどこからも import されていなくても、アプリが名前を付けたモジュールは結ぶ（変数で組んだ import() が引ける）
        extra: id('apps/extra.js'),
        '@vfs/apps/main.js': id('apps/main.js'),
        '@vfs/apps/vendor/lib.js': id('apps/vendor/lib.js'),
        '@vfs/apps/ui/button.js': id('apps/ui/button.js'),
        '@vfs/apps/extra.js': id('apps/extra.js'),
      },
      scopes: importMap.scopes,
    });
    // 効かないものは言う: scopes・パスの形の鍵・予約の頭・フォルダの対応
    const said = warn.mock.calls.map((c) => String(c[0]));
    expect(said.some((m) => m.includes('"scopes"'))).toBe(true);
    expect(said.some((m) => m.includes('"./rel.js"'))).toBe(true);
    expect(said.some((m) => m.includes('"@vfs/apps/x.js"'))).toBe(true);
    expect(said.some((m) => m.includes('"ui/"'))).toBe(true);
    expect(said).toHaveLength(4);
  });

  it('モジュールを使わない文書の import map（外を指すものだけ）は、書かれたまま残る', async () => {
    const original = '{ "imports": { "cdn": "https://cdn.example/x.js" } }';
    const { html, assets } = await compile(
      { 'apps/a.html': page('<script>console.log(1)</script>', `<script type="importmap">${original}</script>`) },
      'apps/a.html',
    );
    expect(html).toContain(`<script type="importmap">${original}</script>`);
    expect(assets).toEqual([]);
  });

  it('JSON として読めない import map は無視して言う（文書はそのまま・モジュールの解決は続ける）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { html, assets } = await compile(
      {
        'apps/a.html': page(
          '',
          '<script type="importmap">{ imports: </script><script type="module" src="m.js"></script>',
        ),
        'apps/m.js': "import 'lib';",
      },
      'apps/a.html',
    );
    expect(warn.mock.calls.some((c) => String(c[0]).includes('Ignoring the import map in apps/a.html'))).toBe(true);
    expect(textOf(assetOf(assets, 'apps/m.js'))).toContain("import 'lib';");
    expect(importMapOf(html)!.imports).toEqual({ '@vfs/apps/m.js': assetOf(assets, 'apps/m.js').id });
  });
});

describe('GuestCompiler: new URL(…, import.meta.url)', () => {
  it('在るファイルを指すものだけが資源の目印になる。フォルダ・無いもの・外・変数はそのまま', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const source = [
      "const img = new URL('./img/a.png', import.meta.url);",
      "const dir = new URL('./img/', import.meta.url);",
      "const here = new URL('.', import.meta.url);",
      "const gone = new URL('./gone.png', import.meta.url);",
      "const ext = new URL('https://example.com/x.png', import.meta.url);",
      "const w = new Worker(new URL('./worker.js', import.meta.url));",
      'const dyn = new URL(name, import.meta.url);',
      'const hashed = new URL("./sprite.svg#icon", import.meta.url);',
      '',
    ].join('\n');
    const { assets } = await compile(
      {
        apps: { kind: 'directory' },
        'apps/img': { kind: 'directory' },
        'apps/a.html': page('', '<script type="module" src="main.js"></script>'),
        'apps/main.js': source,
        'apps/img/a.png': 'PNG',
        'apps/worker.js': "importScripts('./dep.js');",
        'apps/sprite.svg': '<svg/>',
      },
      'apps/a.html',
    );
    expect(assets.map((x) => [x.path, x.kind])).toEqual([
      ['apps/img/a.png', 'blob'],
      // Worker のファイルは実体のまま（中の参照は解決しない）
      ['apps/worker.js', 'blob'],
      ['apps/sprite.svg', 'blob'],
      ['apps/main.js', 'text'],
    ]);
    const [img, worker, sprite, main] = assets;
    const body = textOf(main);
    expect(body).toContain(`const img = new URL('${img.id}', import.meta.url);`);
    expect(body).toContain("const dir = new URL('./img/', import.meta.url);");
    expect(body).toContain("const here = new URL('.', import.meta.url);");
    expect(body).toContain("const gone = new URL('./gone.png', import.meta.url);");
    expect(body).toContain("const ext = new URL('https://example.com/x.png', import.meta.url);");
    expect(body).toContain(`new Worker(new URL('${worker.id}', import.meta.url));`);
    expect(body).toContain('const dyn = new URL(name, import.meta.url);');
    expect(body).toContain(`const hashed = new URL("${sprite.id}#icon", import.meta.url);`);
    expect(markersPrecede(assets)).toBe(true);
    // 言うのは「無いファイル」の 1 件だけ（外の URL・フォルダ・変数では何も言わない）
    const said = warn.mock.calls.map((c) => String(c[0]));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('apps/gone.png');
  });
});

describe('GuestCompiler: 入れ子の文書（iframe）とモジュール', () => {
  it('import map は文書ごとに 1 枚。その文書から届くモジュールだけが載る', async () => {
    const { html, assets } = await compile(
      {
        'apps/index.html': page('<iframe src="sub/page.html"></iframe>', '<script type="module" src="p.js"></script>'),
        'apps/p.js': "import './shared.js';",
        'apps/shared.js': 'export const s = 1;',
        'apps/sub/page.html': page('', '<script type="module" src="c.js"></script>'),
        'apps/sub/c.js': "import '../shared.js';\nimport './only-child.js';",
        'apps/sub/only-child.js': 'export {};',
      },
      'apps/index.html',
    );
    expect(assets.map((x) => x.path)).toEqual([
      'apps/shared.js',
      'apps/p.js',
      'apps/sub/only-child.js',
      'apps/sub/c.js',
      'apps/sub/page.html',
    ]);
    const id = (path: string) => assetOf(assets, path).id;
    expect(importMapOf(html)!.imports).toEqual({
      '@vfs/apps/p.js': id('apps/p.js'),
      '@vfs/apps/shared.js': id('apps/shared.js'),
    });

    const child = textOf(assetOf(assets, 'apps/sub/page.html'));
    expect(importMapOf(child)!.imports).toEqual({
      '@vfs/apps/sub/c.js': id('apps/sub/c.js'),
      '@vfs/apps/shared.js': id('apps/shared.js'),
      '@vfs/apps/sub/only-child.js': id('apps/sub/only-child.js'),
    });
    const childDoc = parse(child);
    expect(childDoc.head.firstElementChild!.getAttribute('type')).toBe('importmap');
    expect(childDoc.querySelector('script[type="module"]')!.getAttribute('src')).toBe(id('apps/sub/c.js'));
    // 入れ子の文書（text の資源）が指す目印は、すべて先に並んでいる
    expect(markersPrecede(assets)).toBe(true);
  });
});

describe('GuestCompiler: 入口の文書は自分のパスを知る', () => {
  it('window.__ITERA_PATH__ に入口の VFS のパスが入る（?query・#hash・先頭の / は付かない）', async () => {
    const files = { 'apps/dir/a.html': page('<p>a</p>') };
    for (const entry of ['apps/dir/a.html', '/apps/dir/a.html', 'apps/dir/a.html?x=1#h', 'apps/dir/../dir/a.html']) {
      const { html } = await compile(files, entry);
      expect(html).toContain('<script>window.__ITERA_PATH__ = "apps/dir/a.html";</script>');
    }
  });

  it('パスは閉じタグで壊れない JSON として入る。404 の画面には入らない', async () => {
    const { html } = await compile({ 'apps/<x>.html': page('') }, 'apps/<x>.html');
    expect(html).toContain('window.__ITERA_PATH__ = "apps/\\u003cx\\u003e.html";');
    const missing = await compile({}, 'apps/none.html');
    expect(missing.html).not.toContain('__ITERA_PATH__');
  });
});
