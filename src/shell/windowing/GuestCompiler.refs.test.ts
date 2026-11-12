// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { GuestCompiler } from './GuestCompiler';
import { assetOf, importMapOf, markersPrecede, page, parse, textOf, vfsOf } from './guestCompilerTestKit';

/**
 * src/shell/windowing/GuestCompiler.refs.test.ts
 *
 * HTML と CSS の静的な参照のうち、T-0822 で拾うようにした形:
 *   `poster`・`track`・`input[type=image]`・`srcset`／`imagesrcset`・SVG の `image`／`use`／`feImage`・`<template>` の中・
 *   CSS の `@import "…"`・`image-set("…")`。
 * あわせて、VFS の外を指す参照（スキーム付き・`//host`）は 1 文字も変えず、資源も作らないこと。
 * 前から解決していた形（`script`・`link`・`img` … と `url()`）は GuestCompiler.test.ts と金型（golden）が守る。
 */

const compile = (entries: Parameters<typeof vfsOf>[0], entry = 'apps/a.html') =>
  new GuestCompiler().compile(vfsOf(entries), entry, 'test');

describe('GuestCompiler: HTML の残りの属性', () => {
  it('video の poster・track・input[type=image] を解決する。type=image でない input の src は触らない', async () => {
    const { html, assets } = await compile({
      'apps/a.html': page(
        '<video src="v.mp4" poster="p.jpg"><track src="subs.vtt" kind="subtitles"></video>' +
          '<input type="image" src="btn.png"><input type="text" src="not-an-image.png">',
      ),
      'apps/v.mp4': 'V',
      'apps/p.jpg': 'P',
      'apps/subs.vtt': 'WEBVTT',
      'apps/btn.png': 'B',
    });
    // 前から在る形（video の src）が先。足した形はそのあとに並ぶ
    expect(assets.map((x) => x.path)).toEqual(['apps/v.mp4', 'apps/p.jpg', 'apps/subs.vtt', 'apps/btn.png']);
    const [v, p, subs, btn] = assets;
    const doc = parse(html);
    expect(doc.querySelector('video')!.getAttribute('src')).toBe(v.id);
    expect(doc.querySelector('video')!.getAttribute('poster')).toBe(p.id);
    expect(doc.querySelector('track')!.getAttribute('src')).toBe(subs.id);
    expect(doc.querySelector('input[type="image"]')!.getAttribute('src')).toBe(btn.id);
    expect(doc.querySelector('input[type="text"]')!.getAttribute('src')).toBe('not-an-image.png');
    expect(subs.mime).toBe('application/octet-stream'); // 拡張子の表に無いものは実体のまま（MIME は VFS の stat が持つ）
  });

  it('srcset・imagesrcset は URL だけが目印になり、記述子と区切りはそのまま。data: の候補は触らない', async () => {
    const { html, assets } = await compile({
      'apps/a.html': page(
        '<img src="a.png" srcset="a.png 1x, a@2x.png 2x">' +
          '<picture><source srcset="wide.webp 800w,\n narrow.webp"><img src="a.png"></picture>' +
          '<img srcset="data:image/png;base64,AAAA 1x, ../shared/b.png 2x">',
        '<link rel="preload" as="image" href="a.png" imagesrcset="a.png 1x, a@2x.png 2x">',
      ),
      'apps/a.png': 'A',
      'apps/a@2x.png': 'A2',
      'apps/wide.webp': 'W',
      'apps/narrow.webp': 'N',
      'shared/b.png': 'B',
    });
    const id = (path: string) => assetOf(assets, path).id;
    const doc = parse(html);
    const imgs = doc.querySelectorAll('img');
    expect(imgs[0].getAttribute('srcset')).toBe(`${id('apps/a.png')} 1x, ${id('apps/a@2x.png')} 2x`);
    expect(doc.querySelector('source')!.getAttribute('srcset')).toBe(
      `${id('apps/wide.webp')} 800w,\n ${id('apps/narrow.webp')}`,
    );
    expect(imgs[2].getAttribute('srcset')).toBe(`data:image/png;base64,AAAA 1x, ${id('shared/b.png')} 2x`);
    expect(doc.querySelector('link')!.getAttribute('imagesrcset')).toBe(
      `${id('apps/a.png')} 1x, ${id('apps/a@2x.png')} 2x`,
    );
    // 同じファイルは 1 つの資源（src・srcset・href・imagesrcset から 4 回指している）
    expect(assets).toHaveLength(5);
  });

  it('SVG の image・use・feImage（href と xlink:href）を解決する。#id だけの参照は文書の中を指すので触らない', async () => {
    const { html, assets } = await compile({
      'apps/a.html': page(
        '<svg><image href="pic.png"/><image xlink:href="old.png"/><use href="sprite.svg#icon"/>' +
          '<use href="#local"/><filter><feImage href="tex.png"/></filter></svg>',
      ),
      'apps/pic.png': 'P',
      'apps/old.png': 'O',
      'apps/sprite.svg': '<svg/>',
      'apps/tex.png': 'T',
    });
    const id = (path: string) => assetOf(assets, path).id;
    const doc = parse(html);
    const images = doc.querySelectorAll('image');
    expect(images[0].getAttribute('href')).toBe(id('apps/pic.png'));
    expect(images[1].getAttribute('xlink:href')).toBe(id('apps/old.png'));
    const uses = doc.querySelectorAll('use');
    expect(uses[0].getAttribute('href')).toBe(id('apps/sprite.svg') + '#icon');
    expect(uses[1].getAttribute('href')).toBe('#local');
    expect(doc.querySelector('feImage')!.getAttribute('href')).toBe(id('apps/tex.png'));
    expect(assets).toHaveLength(4);
  });

  it('<template> の中（入れ子も）を同じ規則で解決し、書き戻した文書に残る', async () => {
    const { html, assets } = await compile({
      'apps/a.html': page(
        '<template id="row"><img src="row.png"><div style="background:url(bg.png)"></div>' +
          '<template><img src="deep.png" srcset="deep.png 2x"></template></template>',
      ),
      'apps/row.png': 'R',
      'apps/bg.png': 'B',
      'apps/deep.png': 'D',
    });
    const id = (path: string) => assetOf(assets, path).id;
    expect(html).toContain(
      `<template id="row"><img src="${id('apps/row.png')}"><div style="background:url(${id('apps/bg.png')})"></div>` +
        `<template><img src="${id('apps/deep.png')}" srcset="${id('apps/deep.png')} 2x"></template></template>`,
    );
    expect(assets).toHaveLength(3);
  });
});

describe('GuestCompiler: CSS の残りの形', () => {
  it('スタイルシートの @import "…"（url() 無し）と image-set("…") を解決する。ほかの文字列・外の URL はそのまま', async () => {
    const css = [
      '@import "base.css";',
      '@import url(theme.css) screen;',
      "@import 'https://fonts.example/x.css';",
      '.a { background: image-set("a.png" 1x, "a2.png" 2x); }',
      '.b { background: -webkit-image-set(url(b.png) 1x); content: "url(not.png)"; }',
      '/* @import "comment.css"; */',
    ].join('\n');
    const { html, assets } = await compile({
      'apps/a.html': page('', '<link rel="stylesheet" href="css/s.css">'),
      'apps/css/s.css': css,
      'apps/css/base.css': 'body { margin: 0 }',
      'apps/css/theme.css': '.t { background: url(../img/t.png) }',
      'apps/img/t.png': 'T',
      'apps/css/a.png': 'A',
      'apps/css/a2.png': 'A2',
      'apps/css/b.png': 'B',
    });
    const id = (path: string) => assetOf(assets, path).id;
    const out = textOf(assetOf(assets, 'apps/css/s.css'));
    expect(out).toBe(
      [
        `@import "${id('apps/css/base.css')}";`,
        `@import url(${id('apps/css/theme.css')}) screen;`,
        "@import 'https://fonts.example/x.css';",
        `.a { background: image-set("${id('apps/css/a.png')}" 1x, "${id('apps/css/a2.png')}" 2x); }`,
        `.b { background: -webkit-image-set(url(${id('apps/css/b.png')}) 1x); content: "url(not.png)"; }`,
        '/* @import "comment.css"; */',
      ].join('\n'),
    );
    // @import された CSS の中の url() は、その CSS のフォルダから
    expect(textOf(assetOf(assets, 'apps/css/theme.css'))).toBe(`.t { background: url(${id('apps/img/t.png')}) }`);
    expect(parse(html).querySelector('link')!.getAttribute('href')).toBe(id('apps/css/s.css'));
    expect(assets).toHaveLength(7);
    expect(markersPrecede(assets)).toBe(true);
  });

  it('<style> と style 属性の中でも同じ', async () => {
    const { html, assets } = await compile({
      'apps/a.html': page(
        '<div style="background-image: image-set(\'x.png\' 1x)"></div>',
        '<style>@import "inline.css";\n.c { color: red }</style>',
      ),
      'apps/inline.css': '.i { color: blue }',
      'apps/x.png': 'X',
    });
    const id = (path: string) => assetOf(assets, path).id;
    const doc = parse(html);
    const style = Array.from(doc.querySelectorAll('style')).find((s) =>
      (s.textContent || '').includes('.c { color: red }'),
    )!;
    expect(style.textContent).toBe(`@import "${id('apps/inline.css')}";\n.c { color: red }`);
    expect(doc.querySelector('div')!.getAttribute('style')).toBe(
      `background-image: image-set('${id('apps/x.png')}' 1x)`,
    );
  });
});

describe('GuestCompiler: VFS の外を指す参照', () => {
  it('スキーム付きの URL（blob:・about:・data:・mailto:・https:）と //host は 1 文字も変えず、資源も作らない', async () => {
    const body =
      '<img src="blob:null/0d6c1f0e-1111-2222-3333-444455556666">' +
      '<iframe src="about:blank"></iframe>' +
      '<img src="data:image/png;base64,AA" srcset="https://cdn.example/a.png 2x">' +
      '<embed src="mailto:someone@example.com">' +
      '<video poster="//cdn.example/p.jpg"></video>' +
      '<svg><image href="https://cdn.example/i.png"></image></svg>' +
      '<a href="other.html">link</a>';
    const head =
      '<link rel="stylesheet" href="//cdn.example/x.css">' +
      '<script src="https://cdn.example/x.js"></script>' +
      '<script type="module" src="https://esm.example/m.js"></script>' +
      '<link rel="modulepreload" href="https://esm.example/m.js">' +
      '<style>@import "https://fonts.example/f.css"; .a { background: image-set("//cdn.example/a.png" 1x) }</style>';
    const { html, assets } = await compile({ 'apps/a.html': page(body, head) });
    expect(assets).toEqual([]);
    expect(html).toContain(`<body>${body}`);
    for (const piece of head.split(/(?<=>)(?=<)/)) expect(html).toContain(piece);
    // 外のモジュールだけの文書に import map は足さない
    expect(importMapOf(html)).toBeNull();
  });
});
