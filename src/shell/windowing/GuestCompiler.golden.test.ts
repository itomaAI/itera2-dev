// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { GuestCompiler, stripSourceMapComment } from './GuestCompiler';
import type { CompiledGuest } from './GuestCompiler';
import type { VfsService } from '../../core/vfs/VfsService';
import guestBridgeSource from '../../api/guest_bridge.js?raw';
import htmlToImageSource from 'html-to-image/dist/html-to-image.js?raw';

/**
 * src/shell/windowing/GuestCompiler.golden.test.ts
 *
 * 金型（T-0822）。コンパイラに手を入れる前の出力を写し、手を入れたあとも**既存の書き方のアプリの出力が
 * 1 バイトも変わらない**ことを見る（snapshot が動いたら、既存のアプリの起動の中身が変わっている）。
 *
 * ここに置くのは「前から解決していた形」と「前から触らなかった形」だけ。新しく拾う形（モジュール・srcset など）は
 * GuestCompiler.test.ts の側で、期待を言葉にして試験する。
 *
 * 伏せるもの（コンパイラの仕事ではない・毎回変わる）:
 *   - 目印の中の印（1 回の compile に固有の乱数）
 *   - ブリッジと撮影の助っ人の本文（別のファイルの中身）・テーマの CSS（ホストの :root の計算値）
 *   - 入口のパスを渡す行（T-0822 で足す。足す前は無いので何も起きない）
 */

type Entry = { kind: 'file' | 'directory'; text?: string; mimeType?: string };

function vfsOf(entries: Record<string, Entry | string>): VfsService {
  const norm = (e: Entry | string): Entry => (typeof e === 'string' ? { kind: 'file', text: e } : e);
  const get = (path: string) => (path in entries ? norm(entries[path]) : undefined);
  return {
    exists: (_p: unknown, path: string) => get(path) !== undefined,
    stat: (_p: unknown, path: string) => ({ kind: get(path)!.kind, updatedAt: 1, mimeType: get(path)!.mimeType }),
    readFile: async (_p: unknown, path: string) => get(path)!.text ?? '',
    readBlob: async (_p: unknown, path: string) => new Blob([get(path)!.text ?? '']),
  } as unknown as VfsService;
}

const BRIDGE = guestBridgeSource;
const HTML_TO_IMAGE = stripSourceMapComment(htmlToImageSource);

function normalizeText(s: string): string {
  return s
    .split(BRIDGE)
    .join('/*BRIDGE*/')
    .split(HTML_TO_IMAGE)
    .join('/*HTML_TO_IMAGE*/')
    .replace(/__ITERA_ASSET_[a-z0-9]+_(\d+)__/g, '__ITERA_ASSET_NONCE_$1__')
    .replace(/(<style id="itera-guest-theme">)[\s\S]*?(<\/style>)/, '$1/*THEME*/$2')
    .replace(/<script>window\.__ITERA_PATH__ = [^<]*;<\/script>\n/g, '');
}

async function dump(compiled: CompiledGuest) {
  const assets = [];
  for (const a of compiled.assets) {
    assets.push({
      id: normalizeText(a.id),
      path: a.path,
      mime: a.mime,
      kind: a.kind,
      body: a.kind === 'text' ? normalizeText(a.text) : `[blob type=${a.blob.type}] ` + (await a.blob.text()),
    });
  }
  return { html: normalizeText(compiled.html), hash: compiled.hash, assets };
}

/** 前から解決していた形と、前から触らなかった形を 1 つのアプリに並べる */
const APP: Record<string, Entry | string> = {
  'apps/demo/index.html': `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>demo</title>
    <script src="/system/core/ui.js"></script>
    <script src="js/app.js?v=3"></script>
    <script src="../shared/util.js"></script>
    <script src="https://cdn.example.com/lib.js"></script>
    <link rel="stylesheet" href="css/main.css" />
    <link rel="icon" href="data:image/png;base64,AAAA" />
    <style>
      .hero { background: url('img/hero.png'); }
      .mask { clip-path: url(#clip); }
    </style>
  </head>
  <body>
    <img src="img/logo.png#v2" alt="logo" />
    <img src="https://example.com/x.png" />
    <img src="img/missing.png" />
    <div style="background-image: url(img/hero.png)"></div>
    <iframe src="help/index.html"></iframe>
    <video src="media/clip.mp4"></video>
    <audio src="media/beep.mp3"></audio>
    <video><source src="media/clip.webm" /></video>
    <embed src="doc/sheet.pdf" />
    <object data="doc/sheet.pdf"></object>
    <a href="other.html">other</a>
    <a href="js/app.js">source</a>
    <script>
      const later = './js/app.js';
      fetch('data/items.json');
      const tpl = \`<img src="img/logo.png">\`;
    </script>
    <script type="text/template" id="row"><img src="img/logo.png"></script>
  </body>
</html>`,
  'system/core/ui.js': 'window.AppUI = {};',
  'apps/demo/js/app.js': "console.log('app');",
  'apps/shared/util.js': 'window.util = 1;',
  'apps/demo/css/main.css': `@import url(base.css);
@font-face { font-family: X; src: url("../fonts/x.woff2") format("woff2"); }
body { background: url(../img/hero.png) no-repeat; }
.ext { background: url(https://example.com/a.png); }
.inline { background: url(data:image/gif;base64,R0lGOD); }`,
  'apps/demo/css/base.css': 'html { color: black; } .logo { background: url("../img/logo.png"); }',
  'apps/demo/fonts/x.woff2': 'WOFF2',
  'apps/demo/img/hero.png': { kind: 'file', text: 'HERO', mimeType: 'image/png' },
  'apps/demo/img/logo.png': 'LOGO',
  'apps/demo/help/index.html': `<html><head><link rel="stylesheet" href="help.css"></head><body><img src="../img/logo.png"><script src="help.js"></script></body></html>`,
  'apps/demo/help/help.css': 'p { background: url(q.png); }',
  'apps/demo/help/q.png': 'Q',
  'apps/demo/help/help.js': 'window.help = 1;',
  'apps/demo/media/clip.mp4': 'MP4',
  'apps/demo/media/beep.mp3': 'MP3',
  'apps/demo/media/clip.webm': 'WEBM',
  'apps/demo/doc/sheet.pdf': 'PDF',
  'apps/demo/other.html': '<html><body>other</body></html>',
  'apps/demo/data/items.json': '[]',
};

describe('GuestCompiler: 金型 — 既存の書き方のアプリの出力は変えない（T-0822）', () => {
  it('静的な参照を並べたアプリ（引数あり）', async () => {
    const compiled = await new GuestCompiler().compile(vfsOf(APP), 'apps/demo/index.html?tab=1#top', 'demo', {
      tab: '1',
      note: '</script><b>',
    });
    expect(await dump(compiled)).toMatchSnapshot();
  });

  it('DOCTYPE も head の閉じも無い最小の文書（引数なし）', async () => {
    const vfs = vfsOf({ 'x.html': '<body><p>hi</p><script src="x.js"></script></body>', 'x.js': '1;' });
    expect(await dump(await new GuestCompiler().compile(vfs, 'x.html', 'x'))).toMatchSnapshot();
  });

  it('読めない入口（無い・ディレクトリ）', async () => {
    const vfs = vfsOf({ dir: { kind: 'directory' } });
    expect(await dump(await new GuestCompiler().compile(vfs, 'nowhere/app.html', 'p'))).toMatchSnapshot();
    expect(await dump(await new GuestCompiler().compile(vfs, 'dir', 'p'))).toMatchSnapshot();
  });
});
