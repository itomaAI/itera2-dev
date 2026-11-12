/**
 * src/shell/windowing/GuestCompiler.ts
 * Itera OS v2: Guest Process Compiler (VFS → 文書と資源の束)
 *
 * ゲストの入口 HTML を読み、静的参照（`<script src>` `<link href>` `<img src>` CSS の `url()` …）を VFS の中で
 * 再帰的に解決して、「入口の HTML（参照は目印に置き換え済み）」と「資源の一覧」の束 {@link CompiledGuest} を返す。
 *
 * 解決するのは、コンパイラが中身を読むものの静的な参照 —— HTML の属性・CSS・モジュールとして読まれる JS・
 * HTML に直書きしたスクリプト。どれも「書いたファイルの在るフォルダ」から VFS のパスに解決する（T-0822）。
 * モジュールの指定子には URL を埋めず、合成の指定子と import map で実体に結ぶ（`guestImportMap.ts`）。
 * クラシックな外部スクリプトの中身は読まない（実体のまま渡す）。
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
import {
  lookupImport,
  moduleSpecifier,
  parseAppImportMap,
  serializeImportMap,
  VFS_SPECIFIER_PREFIX,
  type AppImportMap,
} from './guestImportMap';

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

/**
 * VFS の外（スキームの付いた URL・`//host/…`）。そのまま文書に残す。
 * `https:` `data:` だけでなく `blob:` `about:` `mailto:` なども外（以前は VFS のパスとして読み、404 の資源に置き換えていた）
 */
function isForeign(path: string): boolean {
  return isForeignRef(path);
}

/** `<script>` の type。JS として実行されるもの（classic・module）と import map だけを区別する */
function scriptType(el: Element): 'classic' | 'module' | 'importmap' | 'other' {
  const type = (el.getAttribute('type') || '').trim().toLowerCase();
  if (type === 'module') return 'module';
  if (type === 'importmap') return 'importmap';
  if (type === '' || /^(?:text|application)\/(?:x-)?(?:java|ecma)script$/.test(type)) return 'classic';
  return 'other';
}

/** CSS の中に参照が在りうるか（在りうるときだけ走査する） */
function hasCssRefs(css: string): boolean {
  return /url\(|@import|image-set\(/i.test(css);
}

/** モジュールとして読む JS のファイル。ほかの拡張子（.json・.css …）は、ふつうの資源として import map に載せる */
const JS_MODULE_FILE = /\.m?js$/i;
/** モジュールの資源の MIME（ブラウザはモジュールの MIME を厳密に見る） */
const MODULE_MIME = 'application/javascript';

/** 読めないモジュールの代わり。読み込まれた時点で、何が読めないかを言って落ちる */
function missingModuleSource(absPath: string, importer: string | null, reason: string): string {
  const from = importer ? ` (imported from ${importer})` : '';
  return `throw new Error(${JSON.stringify(`Cannot load module "${absPath}": ${reason}${from}`)});\n`;
}

/** モジュールの本文の末尾に足す名前。スタックトレースと開発者ツールに、blob: の URL ではなく VFS のパスが出る */
function sourceUrlComment(absPath: string): string {
  return `\n//# sourceURL=vfs:///${encodeURI(absPath)}\n`;
}

/** 1 つの文書（HTML）の中で共有するもの。import map は文書ごとに 1 枚 */
interface DocScope {
  /** 文書の在るフォルダ。import map の行き先はここから解決する */
  dir: string;
  /** アプリが書いた import map（無ければ空） */
  app: AppImportMap;
  /** この文書が直に読むモジュール（`<script type="module" src>`・modulepreload・直書きのスクリプトの import・import map の項目） */
  roots: Set<string>;
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
  /**
   * モジュールとして読んだファイル: VFS のパス → 資源の参照（読んでいる途中は null）。import map はここから作る。
   * 裸の指定子は、最初にそのモジュールを読んだ文書の import map で引く（入れ子の文書が別の import map を持ち、
   * 同じモジュールを共有する形は区別しない）。
   */
  readonly modules = new Map<string, string | null>();
  /** モジュール → それが import するモジュール。文書ごとの import map は、文書の根からここを辿って作る */
  readonly moduleDeps = new Map<string, Set<string>>();

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

  /** モジュール `from` が `to` を import する、と覚える */
  addDep(from: string, to: string): void {
    let deps = this.moduleDeps.get(from);
    if (!deps) this.moduleDeps.set(from, (deps = new Set()));
    deps.add(to);
  }

  /** 根から import を辿って届くモジュール全部（根を含む） */
  reachable(roots: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const queue = [...roots];
    while (queue.length > 0) {
      const path = queue.pop()!;
      if (seen.has(path)) continue;
      seen.add(path);
      for (const dep of this.moduleDeps.get(path) ?? []) queue.push(dep);
    }
    return seen;
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
    await scriptLexerReady;
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
    return this._injectHtmlScripts(body, ctx.pid, ctx.args, absPath);
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
    // それ以外は実体を読まない。VFS が返す Blob（OPFS の File）をそのまま渡す。
    // handle はこのプロセスが持ち続けるので保持者として名乗る —— そのファイルが書き直されても、
    // プロセスが kill されるまで古い実体は残る（T-0791）
    return ctx.addBlob(absPath, mime, await ctx.vfs.readBlob(USER_PRINCIPAL, absPath, { holder: ctx.pid }));
  }

  /**
   * HTML を読み、静的参照を目印に置き換えた文書を返す。ブリッジ等の注入は入口だけ（呼び手が行う）。
   * モジュールを使う文書には、指定子を実体に結ぶ import map を 1 枚置く（{@link _writeImportMap}）。
   */
  private async _compileHtml(ctx: Compilation, absPath: string): Promise<string> {
    const html = await ctx.vfs.readFile(USER_PRINCIPAL, absPath);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const scope: DocScope = { dir: dirOf(absPath), app: { imports: {}, rest: {} }, roots: new Set() };

    // アプリが自分で書いた import map（文書に 1 枚。最初のもの）。裸の指定子はこれで引く
    const mapEl = Array.from(doc.querySelectorAll('script')).find((s) => scriptType(s) === 'importmap') ?? null;
    if (mapEl) {
      const parsed = parseAppImportMap(mapEl.textContent || '');
      if (parsed.map) scope.app = parsed.map;
      else console.warn(`[GuestCompiler] Ignoring the import map in ${absPath}: ${parsed.problem}`);
    }

    await this._rewriteTree(ctx, doc, scope);
    await this._writeImportMap(ctx, doc, scope, mapEl);
    return doc.documentElement.outerHTML;
  }

  /**
   * 文書（または `<template>` の中身）の静的参照を解決する。
   * 🔴 前から解決していた形（1.）の並びは変えない —— 資源は見つけた順に並び、目印の番号もその順に付く。
   */
  private async _rewriteTree(ctx: Compilation, root: ParentNode, scope: DocScope): Promise<void> {
    const dir = scope.dir;
    const each = async (selector: string, fn: (el: Element) => Promise<void>) => {
      for (const el of Array.from(root.querySelectorAll(selector))) await fn(el);
    };
    const rewrite = (selector: string, attr: string) =>
      each(selector, async (el) => {
        const val = el.getAttribute(attr);
        if (!val) return;
        const ref = await this._resolveRef(ctx, val, dir);
        if (ref !== val) el.setAttribute(attr, ref);
      });

    // 1. 前から解決していた形。<a href> は OS のナビゲーションを運ぶので触らない
    await each('script[src]', async (el) => {
      const val = el.getAttribute('src');
      if (!val) return;
      // モジュールは中身を読んで指定子を解決する。クラシックなスクリプトは実体のまま渡す（中身は読まない）
      const ref =
        scriptType(el) === 'module'
          ? await this._resolveModuleUrl(ctx, val, dir, scope)
          : await this._resolveRef(ctx, val, dir);
      if (ref !== val) el.setAttribute('src', ref);
    });
    await each('link[href]', async (el) => {
      const val = el.getAttribute('href');
      if (!val) return;
      const rel = (el.getAttribute('rel') || '').toLowerCase().split(/\s+/);
      const ref = rel.includes('modulepreload')
        ? await this._resolveModuleUrl(ctx, val, dir, scope)
        : await this._resolveRef(ctx, val, dir);
      if (ref !== val) el.setAttribute('href', ref);
    });
    await rewrite('img[src]', 'src');
    await rewrite('iframe[src]', 'src');
    await rewrite('video[src]', 'src');
    await rewrite('audio[src]', 'src');
    await rewrite('source[src]', 'src');
    await rewrite('embed[src]', 'src');
    await rewrite('object[data]', 'data');

    await each('[style]', async (el) => {
      const style = el.getAttribute('style');
      if (style && hasCssRefs(style)) el.setAttribute('style', await this._resolveCssRefs(ctx, style, dir));
    });
    await each('style', async (el) => {
      if (el.textContent && hasCssRefs(el.textContent)) {
        el.textContent = await this._resolveCssRefs(ctx, el.textContent, dir);
      }
    });

    // 2. T-0822 で足した形
    await rewrite('video[poster]', 'poster');
    await rewrite('track[src]', 'src');
    await each('input[src]', async (el) => {
      if ((el.getAttribute('type') || '').trim().toLowerCase() !== 'image') return;
      const val = el.getAttribute('src');
      if (!val) return;
      const ref = await this._resolveRef(ctx, val, dir);
      if (ref !== val) el.setAttribute('src', ref);
    });
    const srcset = (selector: string, attr: string) =>
      each(selector, async (el) => {
        const val = el.getAttribute(attr);
        if (!val) return;
        const out = await this._rewriteSrcset(ctx, val, dir);
        if (out !== val) el.setAttribute(attr, out);
      });
    await srcset('img[srcset]', 'srcset');
    await srcset('source[srcset]', 'srcset');
    await srcset('link[imagesrcset]', 'imagesrcset');
    // SVG（`sprite.svg#icon` の #icon は目印の後ろに残る。`#icon` だけの参照は文書の中を指すので触らない）
    await each('image, use, feImage', async (el) => {
      for (const attr of ['href', 'xlink:href']) {
        const val = el.getAttribute(attr);
        if (!val) continue;
        const ref = await this._resolveRef(ctx, val, dir);
        if (ref !== val) el.setAttribute(attr, ref);
      }
    });

    // 3. HTML に直書きしたスクリプト（モジュール・クラシックとも。JS でない type は読まない）
    await each('script:not([src])', async (el) => {
      const type = scriptType(el);
      if (type !== 'module' && type !== 'classic') return;
      const text = el.textContent || '';
      if (!text.includes('import')) return; // 指定子も import.meta も無い。字句解析に掛けるまでもない
      const out = await this._rewriteScript(ctx, text, dir, scope, null);
      if (out !== text) el.textContent = out;
    });

    // 4. <template> の中。複製されて文書に入るので、同じ規則で解決しておく
    for (const tpl of Array.from(root.querySelectorAll('template'))) {
      const content = (tpl as HTMLTemplateElement).content;
      if (content) await this._rewriteTree(ctx, content, scope);
    }
  }

  /** `srcset` / `imagesrcset` の中の URL を目印に置き換える（記述子はそのまま） */
  private async _rewriteSrcset(ctx: Compilation, value: string, currentDir: string): Promise<string> {
    const replacements: Array<{ start: number; end: number; text: string }> = [];
    for (const r of scanSrcset(value)) {
      const ref = await this._resolveRef(ctx, r.value, currentDir);
      if (ref !== r.value) replacements.push({ start: r.start, end: r.end, text: ref });
    }
    return applyReplacements(value, replacements);
  }

  /** CSS（またはインラインの style）の参照（`url()`・`@import "…"`・`image-set("…")`）を目印に置き換える */
  private async _resolveCssRefs(ctx: Compilation, css: string, currentDir: string): Promise<string> {
    const replacements: Array<{ start: number; end: number; text: string }> = [];
    // 🔴 後ろから解決する（前からこの順だった。資源の並びを変えない）
    for (const r of scanCssRefs(css).reverse()) {
      const ref = await this._resolveRef(ctx, r.value, currentDir);
      if (ref !== r.value) replacements.push({ start: r.start, end: r.end, text: ref });
    }
    return applyReplacements(css, replacements);
  }

  // ---------- モジュール（T-0822） ----------

  /**
   * モジュールの入口（`<script type="module" src>`・`<link rel="modulepreload" href>`）を解決して、その資源の参照を返す。
   * ここに書くのは URL なので、裸の値も相対パスとして読む。
   */
  private async _resolveModuleUrl(
    ctx: Compilation,
    requestPath: string,
    currentDir: string,
    scope: DocScope,
  ): Promise<string> {
    const { basePath, hash } = parsePath(requestPath);
    if (!basePath || isForeign(basePath)) return requestPath;
    const absPath = resolveRelativePath(currentDir, basePath);
    scope.roots.add(absPath);
    await this._ensureModule(ctx, absPath, scope, null);
    const ref = ctx.modules.get(absPath);
    if (!ref) {
      console.warn(`[GuestCompiler] Circular reference to a module entry: ${absPath}`);
      return requestPath;
    }
    return ref + hash;
  }

  /**
   * ファイルをモジュールとして読み、資源にする（1 回の compile で 1 度だけ）。
   * 本文の中の指定子は合成の指定子に書き換わるだけで、子の URL は入らない —— だから循環する import でも止まらない
   * （解決中のモジュールへの import は、指定子を書き換えるだけで先へ進む）。
   */
  private async _ensureModule(
    ctx: Compilation,
    absPath: string,
    scope: DocScope,
    importer: string | null,
  ): Promise<void> {
    if (ctx.modules.has(absPath)) return;
    ctx.modules.set(absPath, null);
    let ref: string;
    const problem = this._checkFile(ctx, absPath);
    if (problem) {
      // 読めないモジュールは「読めない」と言って落ちるモジュールにする（ブラウザの解決の失敗より、何が無いかが分かる）
      ref = ctx.addText(absPath, MODULE_MIME, missingModuleSource(absPath, importer, problem));
    } else if (!JS_MODULE_FILE.test(absPath)) {
      // JSON・CSS などのモジュール（import … with { type }）。ふつうの資源として渡す
      ref = await this._resolveRef(ctx, '/' + absPath, '');
    } else {
      const source = await ctx.vfs.readFile(USER_PRINCIPAL, absPath);
      const body = await this._rewriteScript(ctx, source, dirOf(absPath), scope, absPath);
      ref = ctx.addText(absPath, MODULE_MIME, stripSourceMapComment(body) + sourceUrlComment(absPath));
    }
    ctx.modules.set(absPath, ref);
  }

  /**
   * JS の本文（モジュールのファイル・HTML に直書きしたスクリプト）の中の参照を解決する。
   *   - モジュールの指定子（import / export … from / 文字列の import()）→ 合成の指定子（import map が実体に結ぶ）
   *   - `new URL('…', import.meta.url)` → その資源の目印（中身には触らない）
   * 字句として読めない本文には触らない。
   */
  private async _rewriteScript(
    ctx: Compilation,
    source: string,
    currentDir: string,
    scope: DocScope,
    selfPath: string | null,
  ): Promise<string> {
    const refs = scanScriptRefs(source);
    if (!refs || refs.length === 0) return source;
    const replacements: Array<{ start: number; end: number; text: string }> = [];
    for (const r of refs) {
      if (r.kind === 'url') {
        const { basePath } = parsePath(r.value);
        if (!basePath || isForeign(basePath)) continue;
        // 在るファイルだけを置き換える。フォルダ（`new URL('.', import.meta.url)`）や無いものは、書かれたまま残す
        const target = resolveRelativePath(currentDir, basePath);
        if (!ctx.vfs.exists(USER_PRINCIPAL, target)) {
          console.warn(`[GuestCompiler] new URL(…, import.meta.url) points to a missing file: ${target}`);
          continue;
        }
        if (ctx.vfs.stat(USER_PRINCIPAL, target).kind !== 'file') continue;
        const ref = await this._resolveRef(ctx, r.value, currentDir);
        if (ref !== r.value) replacements.push({ start: r.start, end: r.end, text: escapeForQuote(ref, r.quote) });
        continue;
      }
      const target = this._moduleTarget(r.value, currentDir, scope);
      if (target === null) continue;
      if (selfPath === null) scope.roots.add(target);
      else ctx.addDep(selfPath, target);
      await this._ensureModule(ctx, target, scope, selfPath ?? '(inline script)');
      replacements.push({ start: r.start, end: r.end, text: escapeForQuote(moduleSpecifier(target), r.quote) });
    }
    return applyReplacements(source, replacements);
  }

  /**
   * モジュールの指定子が指す VFS のパス。VFS の外を指すもの・引けない裸の指定子は null（本文に残す）。
   * 相対（`./` `../` `/`）は書いたファイルのフォルダから。裸の指定子はアプリの import map で引き、
   * その行き先は文書のフォルダから解決する（import map の基準は文書）。
   */
  private _moduleTarget(specifier: string, currentDir: string, scope: DocScope): string | null {
    const kind = classifySpecifier(specifier);
    if (kind === 'foreign') return null;
    let ref = specifier;
    let base = currentDir;
    if (kind === 'bare') {
      const mapped = lookupImport(specifier, scope.app.imports);
      if (mapped === null || isForeign(mapped)) return null;
      ref = mapped;
      base = scope.dir;
    }
    const { basePath } = parsePath(ref);
    if (!basePath) return null;
    return resolveRelativePath(base, basePath);
  }

  /**
   * 文書に import map を 1 枚置く。中身は アプリの項目（VFS の外を指すものはそのまま・VFS のファイルを指すものは実体へ）と、
   * この文書から import を辿って届くモジュール（合成の指定子 → 目印）。モジュールを 1 つも使わない文書には何も足さない。
   * 置き場所は head の先頭 —— import map は最初のモジュールより前に在る必要がある。アプリの元の要素は外す。
   *
   * アプリの import map のうち効かないもの（言って、項目は落とすかそのまま残す）:
   *   - `scopes`・`integrity`: 鍵が URL で、ゲストのモジュールの URL（blob:）とは一致しない。そのまま書き戻すが効かない
   *   - URL の形の鍵（`./a.js`・`/a.js`）: 本文の相対の指定子はコンパイル時に解決済みなので、この対応は引かれない
   *   - フォルダの対応（`"lib/": "./lib/"`）: 文字列で書かれた import には効いている（コンパイル時に引く）。変数で組んだ import() には効かない
   */
  private async _writeImportMap(
    ctx: Compilation,
    doc: Document,
    scope: DocScope,
    mapEl: Element | null,
  ): Promise<void> {
    const entries: Array<[string, string]> = [];
    for (const name of ['scopes', 'integrity']) {
      if (name in scope.app.rest) {
        console.warn(`[GuestCompiler] Import map "${name}" has no effect in a guest app (module URLs are blob: URLs).`);
      }
    }
    for (const [key, target] of Object.entries(scope.app.imports)) {
      if (classifySpecifier(key) === 'relative') {
        console.warn(`[GuestCompiler] Import map key "${key}" is a path, not a bare name. Ignored.`);
        continue;
      }
      if (isForeign(target)) {
        entries.push([key, target]);
        continue;
      }
      if (key.startsWith(VFS_SPECIFIER_PREFIX)) {
        console.warn(`[GuestCompiler] Import map key "${key}" is reserved (${VFS_SPECIFIER_PREFIX}…). Ignored.`);
        continue;
      }
      if (key.endsWith('/')) {
        // フォルダの対応（"lib/": "./lib/"）は 1 つの URL では表せない。コンパイル時に読めた import には効いている
        console.warn(
          `[GuestCompiler] Import map prefix "${key}" → "${target}" applies only to imports written as string literals.`,
        );
        continue;
      }
      const { basePath } = parsePath(target);
      if (!basePath) continue;
      const absPath = resolveRelativePath(scope.dir, basePath);
      scope.roots.add(absPath);
      await this._ensureModule(ctx, absPath, scope, '(import map)');
      const ref = ctx.modules.get(absPath);
      if (ref) entries.push([key, ref]);
    }
    if (scope.roots.size === 0) return; // モジュールを使っていない。アプリの import map が在ってもそのまま

    // 並びは読んだ順（ctx.modules の順）。届くものだけを載せる —— 入れ子の文書に、親の文書のモジュールは載らない
    const reachable = ctx.reachable(scope.roots);
    for (const [absPath, ref] of ctx.modules) {
      if (!reachable.has(absPath)) continue;
      if (ref) entries.push([moduleSpecifier(absPath), ref]);
      else {
        // まだ読んでいる途中のモジュール（モジュール → new URL('page.html', import.meta.url) → その文書が同じモジュールを import）。
        // 資源は子が先に並ぶので、この文書からは結べない
        console.warn(
          `[GuestCompiler] Module "${absPath}" is still being compiled and cannot be linked from ${scope.dir}/`,
        );
      }
    }
    const el = doc.createElement('script');
    el.setAttribute('type', 'importmap');
    el.textContent = serializeImportMap(entries, scope.app.rest);
    if (mapEl) mapEl.remove();
    const head = doc.head ?? doc.documentElement;
    head.insertBefore(el, head.firstChild);
  }

  /** 入口の文書に、PID・自分のパス・引数・ブリッジ・テーマ・撮影の助っ人を差し込む */
  private _injectHtmlScripts(
    htmlContent: string,
    pid: string,
    args: Record<string, string> | undefined,
    path: string,
  ): string {
    let html = htmlContent;
    if (!/<!DOCTYPE\s+html>/i.test(html)) html = '<!DOCTYPE html>\n' + html;

    const hostLang = document.documentElement.lang || 'en';
    html = html.replace(/<html[^>]*>/i, (match) =>
      match.includes('lang=')
        ? match.replace(/lang=(['"]).*?\1/i, `lang="${hostLang}"`)
        : match.replace('<html', `<html lang="${hostLang}"`),
    );

    let headInjections = `\n<script>window.__ITERA_PID__ = ${jsLiteral(pid)};</script>\n`;
    // 入口の文書の VFS のパス。ブリッジが MetaOS.app（path・dir・resolve）として返す（T-0822）
    headInjections += `<script>window.__ITERA_PATH__ = ${jsLiteral(path)};</script>\n`;
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
