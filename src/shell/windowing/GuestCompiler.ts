/**
 * src/shell/windowing/GuestCompiler.ts
 * Itera OS v2: Guest Process Compiler (VFS → 文書と資源の束)
 *
 * ゲストの入口 HTML を読み、静的参照（`<script src>` `<link href>` `<img src>` CSS の `url()` …）を VFS の中で
 * 再帰的に解決して、「入口の HTML（参照は目印に置き換え済み）」と「資源の一覧」の束 {@link CompiledGuest} を返す。
 *
 * ここでは URL を作らない。object URL はそれを作った文書（オリジン）だけが読めるので、ゲストが自分の窓で作る
 * （`guest_bootstrap.js`。二段起動。T-0770）。資源の実体は VFS が返す Blob（OPFS の File）をそのまま structured clone で
 * 渡す —— バイト列は複製されず handle が共有される（T-0770 E1: 50 MB × 10 枚で +0.1〜0.2 MB/枚）。
 * 寿命はゲストの文書と同じなので、ホスト側に URL の台帳も revoke も要らない。
 *
 * ブリッジ（`guest_bridge.js`）と撮影の助っ人（html-to-image）は本文にインラインで入れる。
 * `<script src>` で別の文書から読ませる形だと、opaque origin のゲストはそれを読めない（T-0760）。
 */

import type { VfsService } from '../../core/vfs/VfsService';
import { USER_PRINCIPAL } from '../../core/vfs/types';
import guestBridgeSource from '../../api/guest_bridge.js?raw';
import htmlToImageSource from 'html-to-image/dist/html-to-image.js?raw';
import { resolveRelativePath } from '../../utils/path';
import { buildGuestThemeCss, GUEST_THEME_STYLE_ID } from './guestThemeCss';
import { t, escapeHtml, i18n } from '../../i18n/i18n';

/**
 * ゲストへ渡す資源 1 つ。`id` は HTML／CSS の中に埋めた目印で、ゲストはこれを自分が作った object URL に置き換える。
 * - `blob`: VFS の実体（読まずに handle のまま渡す）。MIME は {@link typedBlob} で付け済み
 * - `text`: 中に他の資源の目印を含むテキスト（CSS・入れ子の HTML）。先に並ぶ資源の URL で置換してから Blob にする
 */
export type GuestAsset = { id: string; path: string; mime: string } & (
  { kind: 'blob'; blob: Blob } | { kind: 'text'; text: string }
);

export interface CompiledGuest {
  /** 入口の文書。資源への参照は目印になっている。ゲストが置換して `document.write` する */
  html: string;
  /** 入口に付いていた `#hash`（無ければ ''）。ゲストが書く前に `location.hash` に写す */
  hash: string;
  /** 依存の後順（子が先）。text の資源が参照する目印は、必ずそれより前に並ぶ */
  assets: GuestAsset[];
}

/**
 * 資源の参照に `?query` / `#hash` をどう載せるか（T-0542）。載せるのは `#hash` だけ。
 * ゲストが作る object URL に `?query` が付くと Firefox はそれを読まない
 * （Firefox 156 で実測: iframe は load が来ないまま止まり、fetch は NetworkError。`#hash` は読める）。
 * blob URL の照合は fragment だけを除いて行う仕様なので、query が付くと別の URL として引けなくなる。
 * ゲストへの引数は `__ITERA_ARGS__` で渡しており、ゲストは `location.search` を読まない。
 * `x.js?v=2` のような資源の query も、中身は同じファイルなので捨ててよい。
 */
export function withFragment(ref: string, _search: string, hash: string): string {
  return ref + hash;
}

/** MIME を付けた Blob。`slice` は範囲の参照を作るだけでバイト列を複製しない */
export function typedBlob(blob: Blob, mime: string): Blob {
  return blob.type === mime ? blob : blob.slice(0, blob.size, mime);
}

/** 読み込めない資源の代わりに見せる静的な画面（スクリプトを含めない） */
export function missingDocumentHtml(absPath: string, reason: string): string {
  const lang = escapeHtml(i18n.locale);
  return (
    `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${escapeHtml(reason)}</title></head>` +
    `<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;` +
    `background:#1e1e2e;color:#cdd6f4;font-family:system-ui,sans-serif;">` +
    `<div style="text-align:center;padding:2rem;"><div style="font-size:2rem;">404</div>` +
    `<p style="margin:.5rem 0 0;">${escapeHtml(reason)}</p>` +
    `<p style="margin:.25rem 0 0;opacity:.7;font-size:.85rem;word-break:break-all;">${escapeHtml(absPath)}</p>` +
    `</div></body></html>`
  );
}

interface ParsedPath {
  basePath: string;
  search: string;
  hash: string;
}

function parsePath(path: string): ParsedPath {
  if (!path) return { basePath: '', search: '', hash: '' };
  let basePath = path;
  let search = '';
  let hash = '';
  const hashIdx = basePath.indexOf('#');
  if (hashIdx !== -1) {
    hash = basePath.substring(hashIdx);
    basePath = basePath.substring(0, hashIdx);
  }
  const queryIdx = basePath.indexOf('?');
  if (queryIdx !== -1) {
    search = basePath.substring(queryIdx);
    basePath = basePath.substring(0, queryIdx);
  }
  return { basePath, search, hash };
}

/** VFS の外（外部 URL・data URI）。そのまま文書に残す */
function isForeign(path: string): boolean {
  return /^https?:\/\//.test(path) || path.startsWith('data:');
}

function dirOf(filePath: string): string {
  return filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/')) : '';
}

/** 解決の途中（循環参照の検出に使う） */
const IN_PROGRESS = Symbol('in-progress');

/**
 * 1 回の compile の状態。資源の一覧・目印の採番・訪問表はここに閉じる。
 * コンパイラは全プロセスで 1 つを共有し compile は非同期なので、インスタンスに持つと並行する起動どうしで混ざる。
 */
class Compilation {
  readonly assets: GuestAsset[] = [];
  /** 目印に混ぜる印。アプリの本文がたまたま同じ文字列を含んでいても置換が当たらないように */
  private readonly nonce = Math.random().toString(36).slice(2, 10);
  /** absPath + hash → 目印（解決済み）／IN_PROGRESS（解決中） */
  private readonly refs = new Map<string, string | typeof IN_PROGRESS>();

  readonly vfs: VfsService;
  readonly pid: string;
  readonly args: Record<string, string> | undefined;

  constructor(vfs: VfsService, pid: string, args: Record<string, string> | undefined) {
    this.vfs = vfs;
    this.pid = pid;
    this.args = args;
  }

  lookup(key: string): string | typeof IN_PROGRESS | undefined {
    return this.refs.get(key);
  }

  begin(key: string): void {
    this.refs.set(key, IN_PROGRESS);
  }

  finish(key: string, ref: string): void {
    this.refs.set(key, ref);
  }

  addText(path: string, mime: string, text: string): string {
    const id = this.nextMarker();
    this.assets.push({ id, path, mime, kind: 'text', text });
    return id;
  }

  addBlob(path: string, mime: string, blob: Blob): string {
    const id = this.nextMarker();
    this.assets.push({ id, path, mime, kind: 'blob', blob: typedBlob(blob, mime) });
    return id;
  }

  private nextMarker(): string {
    return `__ITERA_ASSET_${this.nonce}_${this.assets.length}__`;
  }
}

export class GuestCompiler {
  getMimeType(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    const map: Record<string, string> = {
      js: 'application/javascript',
      mjs: 'application/javascript',
      ts: 'application/javascript',
      css: 'text/css',
      html: 'text/html',
      json: 'application/json',
      xml: 'application/xml',
      txt: 'text/plain',
      md: 'text/markdown',
      csv: 'text/csv',
      svg: 'image/svg+xml',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      ico: 'image/x-icon',
      woff: 'font/woff',
      woff2: 'font/woff2',
      ttf: 'font/ttf',
      otf: 'font/otf',
      wasm: 'application/wasm',
      pdf: 'application/pdf',
      mp3: 'audio/mpeg',
      mp4: 'video/mp4',
      webm: 'video/webm',
      glb: 'model/gltf-binary',
      gltf: 'model/gltf+json',
    };
    return map[ext] || 'application/octet-stream';
  }

  /**
   * 入口の HTML と、そこから辿れる資源の束を作る。
   * 入口が VFS の文書でないとき（無い・ディレクトリ・外部 URL）は 404 の画面を返す。
   * 要求されたパスをそのまま返してはならない —— 配信先が SPA リライト（未知の URL に index.html を 200 で返す）だと、
   * iframe の中で**親 OS の HTML** が起動する（ミャク楽 Agent で実際に起きた / T-0196）。
   */
  async compile(
    vfs: VfsService,
    entryPath: string,
    pid: string = 'main',
    args?: Record<string, string>,
  ): Promise<CompiledGuest> {
    const ctx = new Compilation(vfs, pid, args);
    const { basePath, hash } = parsePath(entryPath);
    const html = await this._compileEntry(ctx, basePath, entryPath);
    return { html, hash, assets: ctx.assets };
  }

  private async _compileEntry(ctx: Compilation, basePath: string, requested: string): Promise<string> {
    if (!basePath || isForeign(basePath)) {
      console.warn(`[GuestCompiler] Entry is not a VFS document: ${requested}`);
      return missingDocumentHtml(requested, t('guest.notAFile'));
    }
    const absPath = resolveRelativePath('', basePath);
    const problem = this._checkFile(ctx, absPath);
    if (problem) return missingDocumentHtml(absPath, problem);

    ctx.begin(absPath);
    const body = await this._compileHtml(ctx, absPath);
    ctx.finish(absPath, '');
    return this._injectHtmlScripts(body, ctx.pid, ctx.args);
  }

  /** 読めない理由（無い・ファイルでない）。読めるなら null */
  private _checkFile(ctx: Compilation, absPath: string): string | null {
    if (!ctx.vfs.exists(USER_PRINCIPAL, absPath)) {
      console.warn(`[GuestCompiler] File not found: ${absPath}`);
      return t('guest.fileNotFound');
    }
    if (ctx.vfs.stat(USER_PRINCIPAL, absPath).kind !== 'file') {
      console.warn(`[GuestCompiler] Not a file: ${absPath}`);
      return t('guest.notAFile');
    }
    return null;
  }

  /**
   * 文書の中から参照された 1 つの資源を解決して、文書に書き込む参照（目印＋`#hash`）を返す。
   * VFS の外のものはそのまま。読めないものは 404 の画面（text の資源）。
   */
  private async _resolveRef(ctx: Compilation, requestPath: string, currentDir: string): Promise<string> {
    const { basePath, search, hash } = parsePath(requestPath);
    if (!basePath || isForeign(basePath)) return requestPath;

    const absPath = resolveRelativePath(currentDir, basePath);
    const key = absPath + hash;
    const known = ctx.lookup(key);
    if (known === IN_PROGRESS) {
      // 循環参照。目印はまだ無いので参照はそのまま残す（辿らなければ止まる）
      console.warn(`[GuestCompiler] Circular reference: ${absPath}`);
      return requestPath;
    }
    if (known !== undefined) return known;

    ctx.begin(key);
    const problem = this._checkFile(ctx, absPath);
    const marker = problem
      ? ctx.addText(absPath, 'text/html', missingDocumentHtml(absPath, problem))
      : await this._compileAsset(ctx, absPath);
    const ref = withFragment(marker, search, hash);
    ctx.finish(key, ref);
    return ref;
  }

  private async _compileAsset(ctx: Compilation, absPath: string): Promise<string> {
    const mime = ctx.vfs.stat(USER_PRINCIPAL, absPath).mimeType || this.getMimeType(absPath);
    if (absPath.endsWith('.html')) {
      return ctx.addText(absPath, 'text/html', await this._compileHtml(ctx, absPath));
    }
    if (absPath.endsWith('.css')) {
      const css = await ctx.vfs.readFile(USER_PRINCIPAL, absPath);
      return ctx.addText(absPath, 'text/css', await this._resolveCssRefs(ctx, css, dirOf(absPath)));
    }
    // それ以外は実体を読まない。VFS が返す Blob（OPFS の File）をそのまま渡す
    return ctx.addBlob(absPath, mime, await ctx.vfs.readBlob(USER_PRINCIPAL, absPath));
  }

  /** HTML を読み、静的参照（属性・style）を目印に置き換えた文書を返す。ブリッジ等の注入は入口だけ（呼び手が行う） */
  private async _compileHtml(ctx: Compilation, absPath: string): Promise<string> {
    const html = await ctx.vfs.readFile(USER_PRINCIPAL, absPath);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const currentDir = dirOf(absPath);

    const rewrite = async (selector: string, attr: string) => {
      for (const el of Array.from(doc.querySelectorAll(selector))) {
        const val = el.getAttribute(attr);
        if (!val) continue;
        const ref = await this._resolveRef(ctx, val, currentDir);
        if (ref !== val) el.setAttribute(attr, ref);
      }
    };
    // <a href> は OS のナビゲーションを運ぶので触らない
    await rewrite('script[src]', 'src');
    await rewrite('link[href]', 'href');
    await rewrite('img[src]', 'src');
    await rewrite('iframe[src]', 'src');
    await rewrite('video[src]', 'src');
    await rewrite('audio[src]', 'src');
    await rewrite('source[src]', 'src');
    await rewrite('embed[src]', 'src');
    await rewrite('object[data]', 'data');

    for (const el of Array.from(doc.querySelectorAll('[style]'))) {
      const style = el.getAttribute('style');
      if (style && style.includes('url(')) {
        el.setAttribute('style', await this._resolveCssRefs(ctx, style, currentDir));
      }
    }
    for (const style of Array.from(doc.querySelectorAll('style'))) {
      if (style.textContent && style.textContent.includes('url(')) {
        style.textContent = await this._resolveCssRefs(ctx, style.textContent, currentDir);
      }
    }
    return doc.documentElement.outerHTML;
  }

  /** CSS（またはインラインの style）の `url()` を目印に置き換える */
  private async _resolveCssRefs(ctx: Compilation, css: string, currentDir: string): Promise<string> {
    const urlRegex = /url\(\s*(['"]?)(.*?)\1\s*\)/g;
    const matches = Array.from(css.matchAll(urlRegex));
    let result = css;
    // 後ろから置換して、前の置換で位置がずれないようにする
    for (let i = matches.length - 1; i >= 0; i--) {
      const match = matches[i];
      const quote = match[1];
      const relPath = match[2];
      if (!relPath || isForeign(relPath)) continue;
      const ref = await this._resolveRef(ctx, relPath, currentDir);
      if (ref === relPath) continue;
      const start = match.index!;
      result = result.substring(0, start) + `url(${quote}${ref}${quote})` + result.substring(start + match[0].length);
    }
    return result;
  }

  /** 入口の文書に、PID・引数・ブリッジ・テーマ・撮影の助っ人を差し込む */
  private _injectHtmlScripts(htmlContent: string, pid: string, args?: Record<string, string>): string {
    let html = htmlContent;
    if (!/<!DOCTYPE\s+html>/i.test(html)) html = '<!DOCTYPE html>\n' + html;

    const hostLang = document.documentElement.lang || 'en';
    html = html.replace(/<html[^>]*>/i, (match) =>
      match.includes('lang=')
        ? match.replace(/lang=(['"]).*?\1/i, `lang="${hostLang}"`)
        : match.replace('<html', `<html lang="${hostLang}"`),
    );

    let headInjections = `\n<script>window.__ITERA_PID__ = ${jsLiteral(pid)};</script>\n`;
    if (args) headInjections += `<script>window.__ITERA_ARGS__ = ${jsLiteral(args)};</script>\n`;
    headInjections += `<script>${guestBridgeSource}</script>\n`;

    if (html.includes('<head>')) html = html.replace('<head>', '<head>' + headInjections);
    else html = html.replace(/(<!DOCTYPE\s+html>)/i, `$1${headInjections}`);

    const themeStyleTag = `<style id="${GUEST_THEME_STYLE_ID}">${buildGuestThemeCss()}</style>`;
    if (html.includes('</head>')) html = html.replace('</head>', themeStyleTag + '\n</head>');
    else html = html.replace(/(<!DOCTYPE\s+html>)/i, `$1\n${themeStyleTag}`);

    // 最初の </body> の直前に差す。JS のテンプレート文字列に </body> を直書きしたアプリはここで壊れる（T-0562）
    html = html.replace('</body>', screenshotHelperCode(pid) + '\n</body>');
    return html;
  }
}

/** `<script>` の中に埋めても閉じタグにならない JSON リテラル */
function jsLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

/**
 * 配布物のライブラリを `<script>` にインラインで埋めるとき、`//# sourceMappingURL=…` の行を剥がす（T-0787）。
 *
 * この参照は「隣に .map がある」前提の相対 URL で、ゲストの文書（opaque な srcdoc）に埋めた瞬間に意味を失う。
 * Firefox の開発者ツールはそれでも解決を試み、源に URL が無いので空の base で `new URL()` を呼んで
 * 「ソースマップエラー: URL constructor:  is not a valid URL」をゲストの起動ごとに出す。
 * 剥がすのはこのコメント行だけ。本体には触れない。
 */
export function stripSourceMapComment(source: string): string {
  return source.replace(/^[ \t]*\/\/[#@][ \t]*sourceMappingURL=.*$/gm, '');
}

const inlinedHtmlToImage = stripSourceMapComment(htmlToImageSource);

function screenshotHelperCode(pid: string): string {
  const pidLiteral = jsLiteral(pid);
  return `
<script>${inlinedHtmlToImage}</script>
<script>
window.addEventListener('message', async (e) => {
    if (e.data.action === 'CAPTURE') {
        // 撮影のあいだだけ requestAnimationFrame を setTimeout に差し替える（T-0350）。
        //
        // html-to-image は画像を読み込んだあと requestAnimationFrame を待つ。
        // ところがブラウザの窓が実際に描かれていないとき（利用者が別の窓・別のタブを見ている、
        // 窓が他のウィンドウに完全に隠れている）rAF は発火しない。document.visibilityState は
        // 'visible' のままなので、外からは「見えている」ようにしか見えないが、撮影は永久に返らない。
        // 自律で動いている時間帯は、まさに利用者が見ていない時間帯なので、ここが効く。
        const rafOriginal = window.requestAnimationFrame;
        window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(performance.now()), 0);
        try {
            if (typeof window.htmlToImage === 'undefined') throw new Error('html-to-image failed to load');
            const data = await window.htmlToImage.toPng(document.body, {
                backgroundColor: null,
                skipOnError: true,
                preferredFontFormat: 'woff2',
                filter: (node) => {
                    if (node.tagName === 'IMG' && (!node.src || node.src === '' || node.src === window.location.href)) return false;
                    return true;
                }
            });
            parent.postMessage({ type: 'SCREENSHOT_RESULT', pid: ${pidLiteral}, data }, '*');
        } catch (err) {
            parent.postMessage({ type: 'SCREENSHOT_ERROR', pid: ${pidLiteral}, message: String(err) }, '*');
        } finally {
            window.requestAnimationFrame = rafOriginal;
        }
    }
});
</script>
`;
}
