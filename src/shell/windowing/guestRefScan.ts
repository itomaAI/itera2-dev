/**
 * src/shell/windowing/guestRefScan.ts
 * Itera OS v2: ゲストの文書の中の「静的な参照」を見つける字句の走査（T-0822）
 *
 * GuestCompiler は、自分が中身を読むもの（HTML・CSS・モジュールとして読まれる JS・HTML に直書きしたスクリプト）の
 * 静的な参照を、書いたファイルの在るフォルダから VFS のパスに解決する。ここはその手前 ——「どこに参照が書いてあるか」だけを
 * 答える純関数の集まりで、VFS も DOM も知らない。返すのは本文の中の範囲（`start`〜`end`）と値。
 * 書き換えは呼び手が後ろから行う（前の置換で位置がずれないように）。
 *
 * 見つけるのは「参照である」と文法から言い切れる所だけ。文字列やコメントの中にたまたま同じ形が在っても拾わない
 * （だから JS は正規表現ではなく字句解析器 es-module-lexer で読む）。
 */

import { init as lexerInit, parse as lexModule } from 'es-module-lexer';

let lexer: 'pending' | 'ready' | 'failed' = 'pending';

/**
 * 字句解析器（Wasm）の用意。{@link scanScriptRefs} を呼ぶ前に 1 度待つ（用意ができた後はすぐ返る）。
 *
 * 同期で使える asm.js 版（`es-module-lexer/js`）は使わない: 束ねた後の本文をブラウザが asm.js として検証できず、
 * OS を開くたびにコンソールへ「Invalid asm.js」の警告が出る（Chromium 149 で実測）。Wasm 版は警告が無く、小さい。
 * 用意に失敗したとき（WebAssembly を禁じた配信先など）は reject しない —— {@link scanScriptRefs} が null を返し、
 * JS の中の参照を解決しないだけの動き（T-0822 より前と同じ）に落ちる。
 */
export const scriptLexerReady: Promise<void> = lexerInit.then(
  () => {
    lexer = 'ready';
  },
  (e: unknown) => {
    lexer = 'failed';
    console.error(
      '[guestRefScan] The module lexer failed to start. References inside scripts will not be resolved.',
      e,
    );
  },
);

/** 本文の中の 1 つの参照。`start`〜`end` は値そのもの（引用符の内側）の範囲 */
export interface TextRef {
  start: number;
  end: number;
  value: string;
}

// ---------- 参照の種類 ----------

/**
 * VFS の外を指す参照（そのまま文書に残す）。
 * スキームの付いた URL（`https:` `data:` `blob:` `about:` `mailto:` `javascript:` …）と、`//host/…`（スキーム相対）。
 * Windows のドライブ名のような 1 文字のスキームは無い前提（VFS のパスに `x:` で始まるものを相対で書くなら `./x:…`）。
 */
export function isForeignRef(ref: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(ref) || ref.startsWith('//');
}

export type SpecifierKind = 'relative' | 'foreign' | 'bare';

/** モジュールの指定子の種類。`./` `../` `/` で始まるものが相対（VFS のパス）。スキーム付きは外。残りは裸（import map で引く） */
export function classifySpecifier(spec: string): SpecifierKind {
  if (isForeignRef(spec)) return 'foreign';
  if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/') || spec === '.' || spec === '..') {
    return 'relative';
  }
  return 'bare';
}

// ---------- srcset ----------

const SRCSET_SPACE = /[\t\n\f\r ]/;

/**
 * `srcset`（`img`・`source`）と `imagesrcset`（`link`）の中の URL。
 * HTML の仕様「parse a srcset attribute」と同じ切り方: 候補は「URL ＋ 記述子」で、区切りはカンマ。
 * URL は空白までの連なりで、カンマを含みうる（`data:` の URL）。URL の末尾のカンマは区切りとして落とす。
 */
export function scanSrcset(value: string): TextRef[] {
  const refs: TextRef[] = [];
  const n = value.length;
  let i = 0;
  while (i < n) {
    while (i < n && (SRCSET_SPACE.test(value[i]) || value[i] === ',')) i++;
    if (i >= n) break;
    const start = i;
    while (i < n && !SRCSET_SPACE.test(value[i])) i++;
    let end = i;
    let endedByComma = false;
    while (end > start && value[end - 1] === ',') {
      end--;
      endedByComma = true;
    }
    if (end > start) refs.push({ start, end, value: value.slice(start, end) });
    if (endedByComma) continue;
    // 記述子（`2x` `480w` …）。括弧の中のカンマは区切りではない
    let depth = 0;
    while (i < n) {
      const c = value[i];
      if (c === '(') depth++;
      else if (c === ')' && depth > 0) depth--;
      else if (c === ',' && depth === 0) {
        i++;
        break;
      }
      i++;
    }
  }
  return refs;
}

// ---------- CSS ----------

const CSS_IDENT_START = /[a-zA-Z_\-\u0080-\uffff]/;
const CSS_IDENT_PART = /[a-zA-Z0-9_\-\u0080-\uffff]/;
const CSS_SPACE = /[\t\n\f\r ]/;
const IMAGE_SET = new Set(['image-set', '-webkit-image-set']);

/**
 * CSS（スタイルシート・`<style>`・`style` 属性）の中の参照:
 *   - `url(…)`（引用符あり・なし）
 *   - `@import "…"`（`url()` を使わない形）
 *   - `image-set("…" 1x, …)` の中の文字列
 * コメントと、それ以外の文字列（`content: "url(x)"` など）の中は拾わない。
 * エスケープ（`\`）を含む値は拾わない（書き戻しで壊さないため。そのまま残る）。
 */
export function scanCssRefs(css: string): TextRef[] {
  const refs: TextRef[] = [];
  const n = css.length;
  /** 開いている関数の名前（小文字）。`image-set(` の直下の文字列だけを拾うために持つ */
  const funcs: string[] = [];
  /** `@import` のあと、最初の参照（文字列か url()）を待っている */
  let importPending = false;
  let i = 0;

  /** i が引用符を指しているとき、文字列を読み飛ばして中身の範囲を返す。閉じていなければ行末・末尾まで */
  const readString = (): { start: number; end: number; clean: boolean } => {
    const quote = css[i];
    const start = ++i;
    let clean = true;
    while (i < n && css[i] !== quote && css[i] !== '\n') {
      if (css[i] === '\\') {
        clean = false;
        i++;
      }
      i++;
    }
    const end = Math.min(i, n);
    if (i < n && css[i] === quote) i++;
    else clean = false;
    return { start, end, clean };
  };

  const push = (start: number, end: number) => {
    if (end > start) refs.push({ start, end, value: css.slice(start, end) });
  };

  while (i < n) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      i = close === -1 ? n : close + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const s = readString();
      const wanted = importPending || IMAGE_SET.has(funcs[funcs.length - 1] ?? '');
      if (wanted && s.clean) push(s.start, s.end);
      if (importPending) importPending = false;
      continue;
    }
    if (c === '@' || CSS_IDENT_START.test(c)) {
      const identStart = i;
      i++;
      while (i < n && CSS_IDENT_PART.test(css[i])) i++;
      const ident = css.slice(identStart, i).toLowerCase();
      if (ident === '@import') {
        importPending = true;
        continue;
      }
      if (css[i] !== '(') continue;
      i++; // '('
      if (ident !== 'url') {
        funcs.push(ident);
        continue;
      }
      // url( … )
      while (i < n && CSS_SPACE.test(css[i])) i++;
      if (css[i] === '"' || css[i] === "'") {
        const s = readString();
        if (s.clean) push(s.start, s.end);
      } else {
        const start = i;
        let clean = true;
        while (i < n && css[i] !== ')' && !CSS_SPACE.test(css[i])) {
          if (css[i] === '\\') clean = false;
          i++;
        }
        if (clean) push(start, i);
      }
      const close = css.indexOf(')', i);
      i = close === -1 ? n : close + 1;
      importPending = false;
      continue;
    }
    if (c === ')') funcs.pop();
    else if (c === ';' || c === '{' || c === '}') importPending = false;
    i++;
  }
  return refs;
}

// ---------- JS（モジュール・HTML に直書きしたスクリプト） ----------

export type ScriptRefKind =
  /** `import … from '…'`・`import '…'`・`export … from '…'` —— モジュールの指定子 */
  | 'import'
  /** `import('…')`（引数が文字列そのもののときだけ）—— モジュールの指定子 */
  | 'dynamic'
  /** `new URL('…', import.meta.url)` —— URL（裸の値も相対パス） */
  | 'url';

export interface ScriptRef extends TextRef {
  kind: ScriptRefKind;
  /** 値を囲んでいる引用符。書き戻すとき、この引用符の中で安全な形に直す */
  quote: '"' | "'" | '`';
}

const QUOTES = new Set(['"', "'", '`']);
/** `new URL(` の探索で import.meta から遡る長さ。これより長い文字列の引数は参照として扱わない */
const NEW_URL_LOOKBEHIND = 2048;
const NEW_URL_BEFORE = /new\s+URL\s*\(\s*(["'`])((?:(?!\1)[^\\\n])*)\1\s*,\s*$/;
const NEW_URL_AFTER = /^\s*\.\s*url\s*\)/;

/**
 * JS の本文の中の参照。字句として読めなかった（構文の誤りなど）ときは `null` —— 呼び手は本文に触らない
 * （誤りはブラウザがそのまま報告する）。先に {@link scriptLexerReady} を待つこと。
 *
 * - 静的な import / export … from と、引数が文字列そのものの動的 import を拾う。
 * - `new URL('…', import.meta.url)` は、1 つ目の引数が文字列そのもの（エスケープも `${}` も無い）ときだけ拾う。
 * - 変数や式で組んだ指定子は拾えない（`import(x)`・`new URL(name, import.meta.url)`）。
 */
export function scanScriptRefs(source: string): ScriptRef[] | null {
  if (lexer === 'pending') throw new Error('scanScriptRefs: await scriptLexerReady before the first call');
  if (lexer === 'failed') return null;
  let imports;
  try {
    [imports] = lexModule(source);
  } catch {
    return null;
  }
  const refs: ScriptRef[] = [];
  for (const imp of imports) {
    // import.meta —— `new URL('…', import.meta.url)` の形かどうかを前後の文字で確かめる
    if (imp.d === -2) {
      if (!NEW_URL_AFTER.test(source.slice(imp.e, imp.e + 32))) continue;
      const from = Math.max(0, imp.s - NEW_URL_LOOKBEHIND);
      const m = NEW_URL_BEFORE.exec(source.slice(from, imp.s));
      if (!m) continue;
      const quote = m[1] as ScriptRef['quote'];
      const value = m[2];
      if (quote === '`' && value.includes('${')) continue;
      // 値の位置: 一致の先頭から、開きの引用符の次まで
      const matchStart = from + m.index;
      const start = matchStart + m[0].indexOf(quote) + 1;
      refs.push({ kind: 'url', quote, start, end: start + value.length, value });
      continue;
    }
    if (imp.n === undefined) continue; // 式で組んだ動的 import
    const dynamic = imp.d >= 0;
    let start = imp.s;
    let end = imp.e;
    // 動的 import は引用符ごと、静的 import は中身だけを指す。どちらでも「引用符の内側」に揃える
    if (QUOTES.has(source[start]) && source[end - 1] === source[start] && end - start >= 2) {
      start++;
      end--;
    }
    const quote = source[start - 1];
    if (!QUOTES.has(quote) || source[end] !== quote) continue; // 想定しない形。触らない
    refs.push({ kind: dynamic ? 'dynamic' : 'import', quote: quote as ScriptRef['quote'], start, end, value: imp.n });
  }
  return refs.sort((a, b) => a.start - b.start);
}

/** 値を、その引用符で囲まれた JS の文字列の中身として安全な形にする */
export function escapeForQuote(value: string, quote: ScriptRef['quote']): string {
  let out = value
    .replace(/\\/g, '\\\\')
    .split(quote)
    .join('\\' + quote);
  if (quote === '`') out = out.replace(/\$\{/g, '\\${');
  return out.replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

/** 範囲ごとの置換を、後ろから当てる。`replacements` は重ならない範囲 */
export function applyReplacements(
  text: string,
  replacements: ReadonlyArray<{ start: number; end: number; text: string }>,
) {
  let out = text;
  for (const r of [...replacements].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, r.start) + r.text + out.slice(r.end);
  }
  return out;
}
