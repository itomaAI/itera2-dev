import { describe, it, expect, beforeAll } from 'vitest';
import {
  applyReplacements,
  classifySpecifier,
  escapeForQuote,
  isForeignRef,
  scanCssRefs,
  scanScriptRefs,
  scanSrcset,
  scriptLexerReady,
} from './guestRefScan';

// JS の字句解析器（Wasm）は用意を待ってから使う
beforeAll(() => scriptLexerReady);

/**
 * src/shell/windowing/guestRefScan.test.ts
 * 「どこに参照が書いてあるか」を答える走査（T-0822）。範囲は値そのもの（引用符の内側）を指す。
 * 拾う形と、拾わない形（文字列・コメントの中、式で組んだもの）の両方を表で押さえる。
 */

const values = (refs: Array<{ value: string }> | null) => (refs ?? []).map((r) => r.value);
/** 範囲が本当に値を指しているか（走査の結果を使って書き戻せるか） */
const ranges = (text: string, refs: Array<{ start: number; end: number; value: string }>) =>
  refs.every((r) => text.slice(r.start, r.end) === r.value);

describe('isForeignRef / classifySpecifier', () => {
  it('スキームの付いた URL と //host は VFS の外', () => {
    for (const s of [
      'https://a/b.js',
      'http://a',
      'data:text/plain,x',
      'blob:null/1',
      'about:blank',
      'mailto:a@b',
      'javascript:void(0)',
      '//cdn.example.com/x.js',
      'node:fs',
    ]) {
      expect(isForeignRef(s), s).toBe(true);
      expect(classifySpecifier(s), s).toBe('foreign');
    }
    for (const s of [
      'a.js',
      './a.js',
      '../a.js',
      '/system/a.js',
      'js/a.js',
      '#frag',
      '',
      '日本語/a.js',
      '@scope/pkg',
    ]) {
      expect(isForeignRef(s), s).toBe(false);
    }
  });

  it('相対は ./ ../ / で始まるもの。それ以外でスキームの無いものは裸', () => {
    expect(['./a.js', '../a.js', '/a.js', '.', '..'].map(classifySpecifier)).toEqual(Array(5).fill('relative'));
    expect(['a.js', 'lib/a.js', '@scope/pkg', 'lodash', '@vfs/apps/a.js'].map(classifySpecifier)).toEqual(
      Array(5).fill('bare'),
    );
  });
});

describe('scanSrcset', () => {
  it('候補ごとの URL を拾い、記述子は拾わない', () => {
    const v = 'img/a.png 1x, img/b.png 2x';
    const refs = scanSrcset(v);
    expect(values(refs)).toEqual(['img/a.png', 'img/b.png']);
    expect(ranges(v, refs)).toBe(true);
  });

  it('記述子の無い候補・余分な空白とカンマ・幅の記述子', () => {
    expect(values(scanSrcset('a.png'))).toEqual(['a.png']);
    expect(values(scanSrcset(' a.png ,  b.png 480w ,c.png'))).toEqual(['a.png', 'b.png', 'c.png']);
    expect(values(scanSrcset('a.png,b.png'))).toEqual(['a.png,b.png']); // 空白が無ければ 1 つの URL（仕様どおり）
    expect(values(scanSrcset('a.png, b.png'))).toEqual(['a.png', 'b.png']);
    expect(values(scanSrcset(''))).toEqual([]);
  });

  it('URL の中のカンマ（data:）は区切りではない', () => {
    const v = 'data:image/png;base64,AAAA 1x, b.png 2x';
    expect(values(scanSrcset(v))).toEqual(['data:image/png;base64,AAAA', 'b.png']);
  });
});

describe('scanCssRefs', () => {
  it('url() —— 引用符あり・なし・空白あり・大文字', () => {
    const css = `a{background:url(a.png)} b{background:url("b.png")} c{background:url( 'c.png' )} d{background:URL(d.png)}`;
    const refs = scanCssRefs(css);
    expect(values(refs)).toEqual(['a.png', 'b.png', 'c.png', 'd.png']);
    expect(ranges(css, refs)).toBe(true);
  });

  it('@import —— 文字列の形と url() の形。media query が後ろに付いてもよい', () => {
    const css = `@import "a.css"; @import 'b.css' screen; @import url(c.css); @import url("d.css") print;`;
    expect(values(scanCssRefs(css))).toEqual(['a.css', 'b.css', 'c.css', 'd.css']);
  });

  it('image-set() の中の文字列と url()。type() の中の文字列は拾わない', () => {
    const css = `a{background-image:image-set("a.png" 1x, url(b.png) 2x)} b{background:-webkit-image-set('c.png' 1x)} c{background:image-set("d.avif" type("image/avif"))}`;
    expect(values(scanCssRefs(css))).toEqual(['a.png', 'b.png', 'c.png', 'd.avif']);
  });

  it('コメントの中・ほかの文字列の中は拾わない', () => {
    const css = `/* url(x.png) @import "y.css" */ a::before{content:"url(z.png)"} b{font-family:"q.woff"} c{background:url(ok.png)}`;
    expect(values(scanCssRefs(css))).toEqual(['ok.png']);
  });

  it('@import の待ちは ; で切れる（後ろの文字列を誤って拾わない）', () => {
    const css = `@import url(a.css); a::after{content:"not-a-ref"}`;
    expect(values(scanCssRefs(css))).toEqual(['a.css']);
  });

  it('エスケープを含む値は拾わない（書き戻しで壊さない）', () => {
    expect(values(scanCssRefs(`a{background:url("a\\"b.png")} b{background:url(ok.png)}`))).toEqual(['ok.png']);
  });

  it('閉じていない url( や文字列で止まらない', () => {
    expect(values(scanCssRefs('a{background:url(a.png'))).toEqual(['a.png']);
    expect(scanCssRefs('a{content:"abc')).toEqual([]);
  });
});

describe('scanScriptRefs', () => {
  it('静的な import / export … from と、文字列の動的 import', () => {
    const src = [
      `import a from './a.js';`,
      `import { b } from "../b.js";`,
      `import './side.js';`,
      `export { c } from './c.js';`,
      `export * from './d.js';`,
      `const m = await import('./e.js');`,
      `import data from './f.json' with { type: 'json' };`,
    ].join('\n');
    const refs = scanScriptRefs(src)!;
    expect(refs.map((r) => [r.kind, r.value])).toEqual([
      ['import', './a.js'],
      ['import', '../b.js'],
      ['import', './side.js'],
      ['import', './c.js'],
      ['import', './d.js'],
      ['dynamic', './e.js'],
      ['import', './f.json'],
    ]);
    expect(ranges(src, refs)).toBe(true);
    expect(refs.map((r) => r.quote)).toEqual(["'", '"', "'", "'", "'", "'", "'"]);
  });

  it('式で組んだ動的 import は拾わない', () => {
    expect(values(scanScriptRefs(`import('./a' + x); import(name); import(\`./\${x}.js\`);`))).toEqual([]);
  });

  it('文字列・テンプレート・コメント・正規表現の中の import は拾わない', () => {
    const src = [
      `const s = "import x from './no1.js'";`,
      `const t = \`import('./no2.js')\`;`,
      `// import './no3.js';`,
      `/* import('./no4.js') */`,
      `const r = /import '\\.\\/no5\\.js'/;`,
      `import ok from './yes.js';`,
    ].join('\n');
    expect(values(scanScriptRefs(src))).toEqual(['./yes.js']);
  });

  it("new URL('…', import.meta.url) —— 1 つ目の引数が文字列そのもののときだけ", () => {
    const src = [
      `const a = new URL('./img/a.png', import.meta.url);`,
      `const b = new URL("b.wasm",import.meta.url).href;`,
      `const c = new URL(\`c.txt\`, import . meta . url);`,
      `const d = new URL(name, import.meta.url);`,
      `const e = new URL(\`./\${x}.png\`, import.meta.url);`,
      `const f = new URL('./f.png', location.href);`,
      `const g = import.meta.url;`,
      `const h = new URL('./h\\'x.png', import.meta.url);`,
      // 2 つ目の引数が import.meta.url そのものでない
      `const i = new URL('./i.png', import.meta.env.BASE_URL);`,
      `const j = new URL('./j.png', import.meta);`,
      `const k = new URL('./k.png', import.meta.url + '/');`,
      `const l = new URL('./l.png', import.meta.urls);`,
    ].join('\n');
    const refs = scanScriptRefs(src)!;
    expect(refs.map((r) => [r.kind, r.value, r.quote])).toEqual([
      ['url', './img/a.png', "'"],
      ['url', 'b.wasm', '"'],
      ['url', 'c.txt', '`'],
    ]);
    expect(ranges(src, refs)).toBe(true);
  });

  it('クラシックなスクリプト（import 文の無い本文）でも動的 import を拾う', () => {
    expect(
      scanScriptRefs(`document.addEventListener('click', function () { import('./lazy.js'); });`)!.map((r) => r.value),
    ).toEqual(['./lazy.js']);
  });

  it('字句として読めない本文は null（呼び手は触らない）', () => {
    expect(scanScriptRefs(`import { a from './a.js'; const s = 'unterminated`)).toBeNull();
  });
});

describe('escapeForQuote / applyReplacements', () => {
  it('囲んでいる引用符と \\ を逃がす。バッククォートでは ${ も', () => {
    expect(escapeForQuote(`a'b"c\\d`, "'")).toBe(`a\\'b"c\\\\d`);
    expect(escapeForQuote(`a'b"c`, '"')).toBe(`a'b\\"c`);
    expect(escapeForQuote('a`b${c}', '`')).toBe('a\\`b\\${c}');
  });

  it('書き戻した本文が、同じ値として読み直せる（日本語・空白・引用符を含むパス）', () => {
    const path = `@vfs/ストア/wb x/it's "a".js`;
    for (const q of ["'", '"', '`'] as const) {
      const src = `import x from ${q}./a.js${q};`.replace(/`/g, q === '`' ? "'" : q); // 静的 import にバッククォートは使えない
      const refs = scanScriptRefs(q === '`' ? `import(\`./a.js\`)` : src)!;
      const text = q === '`' ? `import(\`./a.js\`)` : src;
      const out = applyReplacements(text, [
        { start: refs[0].start, end: refs[0].end, text: escapeForQuote(path, refs[0].quote) },
      ]);
      expect(scanScriptRefs(out)![0].value, out).toBe(path);
    }
  });

  it('applyReplacements は渡した順に依らず、後ろから当てる', () => {
    expect(
      applyReplacements('0123456789', [
        { start: 1, end: 3, text: 'AAAA' },
        { start: 7, end: 8, text: '' },
      ]),
    ).toBe('0AAAA345689');
  });
});
