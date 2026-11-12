/**
 * src/shell/windowing/guestImportMap.ts
 * Itera OS v2: ゲストのモジュールを結ぶ import map（T-0822）
 *
 * ゲストの資源は起動のたびに blob: の URL になり、その URL は階層を持たない。だからモジュールの中の
 * `import './b.js'` は、そのままでは解決できない。
 *
 * ここでの決め: **モジュールの指定子に URL を埋めない。** コンパイラは指定子を VFS のパスから作る合成の裸の指定子
 * （{@link moduleSpecifier}。`@vfs/<VFS のパス>`）に書き換え、文書に 1 枚の import map を置いて実体（blob:）に結ぶ。
 * モジュールの本文が子の URL を含まないので、資源を並べる順の制約が無く、循環する import もそのまま動く。
 * import map の値は資源の目印で、ゲストのブートストラップがほかの目印と同じ置換で blob: の URL にする。
 *
 * アプリが自分で書いた `<script type="importmap">` は、この 1 枚に取り込む（{@link parseAppImportMap}）。
 */

/** 合成の指定子の頭。アプリの import map でこの頭の鍵は使えない（コンパイラの項目が勝つ） */
export const VFS_SPECIFIER_PREFIX = '@vfs/';

/** VFS のパスから合成の指定子を作る。裸の指定子なので、ブラウザは文字列の一致だけで import map を引く */
export function moduleSpecifier(absPath: string): string {
  return VFS_SPECIFIER_PREFIX + absPath;
}

export interface AppImportMap {
  /** アプリが書いた `imports`（文字列の値だけ） */
  imports: Record<string, string>;
  /** `imports` 以外の鍵（`scopes`・`integrity` …）。中身には触らず、そのまま書き戻す */
  rest: Record<string, unknown>;
}

/** アプリの `<script type="importmap">` の中身を読む。JSON として読めない・形が違うときは理由を返す */
export function parseAppImportMap(text: string): { map: AppImportMap | null; problem?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { map: null, problem: `not valid JSON (${(e as { message?: string } | null)?.message || String(e)})` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { map: null, problem: 'not an object' };
  const { imports: rawImports, ...rest } = raw as Record<string, unknown>;
  const imports: Record<string, string> = {};
  if (rawImports && typeof rawImports === 'object' && !Array.isArray(rawImports)) {
    for (const [k, v] of Object.entries(rawImports as Record<string, unknown>)) {
      if (typeof v === 'string') imports[k] = v;
    }
  }
  return { map: { imports, rest } };
}

/**
 * 裸の指定子を、アプリの import map の `imports` で引く（仕様と同じ: 完全一致、無ければ `/` で終わる鍵のうち最長の前方一致）。
 * 返すのは行き先の文字列（相対パスか URL。解決はしない）。無ければ null。
 */
export function lookupImport(specifier: string, imports: Record<string, string>): string | null {
  if (Object.prototype.hasOwnProperty.call(imports, specifier)) return imports[specifier];
  let best: string | null = null;
  for (const key of Object.keys(imports)) {
    if (!key.endsWith('/') || !specifier.startsWith(key)) continue;
    if (best === null || key.length > best.length) best = key;
  }
  if (best === null) return null;
  const target = imports[best];
  // 前方一致の行き先も `/` で終わっていなければならない（仕様）。違えば解決できない
  if (!target.endsWith('/')) return null;
  return target + specifier.slice(best.length);
}

/**
 * 文書に置く import map の JSON。`<script>` の中に置いても閉じタグにならない形にする。
 * `imports` の並びは 渡された順（アプリの項目 → コンパイラの項目）。同じ鍵は後が勝つ。
 */
export function serializeImportMap(
  imports: ReadonlyArray<readonly [string, string]>,
  rest: Record<string, unknown>,
): string {
  const merged: Record<string, string> = {};
  for (const [k, v] of imports) merged[k] = v;
  return JSON.stringify({ imports: merged, ...rest })
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');
}
