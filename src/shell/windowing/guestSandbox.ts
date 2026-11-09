/**
 * src/shell/windowing/guestSandbox.ts
 * Itera OS v2: ゲストの iframe に与える権限（T-0785）
 *
 * 原理: **ゲストはホストと同一オリジンではない。** sandbox に `allow-same-origin` を付けないので、ゲストの文書は
 * opaque origin（`self.origin === "null"`）になり、ホストの `localStorage` / IndexedDB / OPFS / DOM、ホストが作った
 * blob URL には届かない。ゲストがホストから受け取れるものは `MetaOS`（postMessage）だけである。
 * 二段起動（T-0784）はこの前提で組んである: 資源はゲストが自分のオリジンで object URL にする。
 *
 * 2026-08-04 の評価では「`allow-same-origin` は誰も決定していない」（blob URL のコンパイラの実装上の選択が、
 * 信頼境界を後から確定させていた）。T-0758〜T-0770 で測ったうえで外した。
 */

/**
 * sandbox の旗。
 * - allow-scripts / allow-forms / allow-modals: アプリとして動くのに要る
 * - allow-popups: `target=_blank`・`window.open`
 * - allow-popups-to-escape-sandbox: 開いた先（外のサイト）に sandbox を継がせない。無いと外のサイトが opaque origin で開いて壊れる
 * - allow-downloads: `a[download]` で保存できるように（T-0345）
 * `allow-same-origin` は付けない（上）。
 */
export const GUEST_SANDBOX =
  'allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads';

/**
 * Permissions Policy（`allow` 属性）で iframe に委ねる機能。
 * - clipboard-write: 「コピー」ボタンの `navigator.clipboard.writeText`。既定の allowlist は `self` で、opaque origin は
 *   決して `self` に当たらないので、委ねないと Chromium では利用者の操作があっても拒まれる（Firefox は委ねなくても通る。
 *   2026-11-09 に Chromium 149 / Firefox 151 で実測）。読み（clipboard-read）は渡さない —— アプリがクリップボードを
 *   読む必要は無く、貼り付けは利用者の操作（paste イベント）で届く。
 */
export const GUEST_ALLOW_FEATURES = ['clipboard-write'] as const;

/**
 * `allow` 属性の値。ブラウザが名前を知っている機能だけを並べる（知らない名前を書くと Firefox は iframe ごとに警告を出す）。
 * 何を知っているかは `document.featurePolicy.features()` が答える。答えが無いブラウザでは空（何も委ねない）。
 */
export function guestAllow(doc: Document = document): string {
  const policy = (doc as any).featurePolicy ?? (doc as any).permissionsPolicy;
  const known: string[] = typeof policy?.features === 'function' ? policy.features() : [];
  return GUEST_ALLOW_FEATURES.filter((f) => known.includes(f))
    .map((f) => `${f} *`)
    .join('; ');
}
