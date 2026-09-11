/**
 * src/shell/panels/nodeOrder.ts
 * 一覧の並び順 — 既定は「ディレクトリが先、あとは名前順」。重みで上書きできる。
 *
 * ── なぜ «重み» なのか ──────────────────────────────
 * 依頼は「`system` `agent` `trash` などを後回しに」から始まり、
 * 「もう少し一般に、並び順を上書きする仕組み」へ広がった（2026-09-11 / T-0429）。広いほうを採る。
 *
 * 特別扱いする名前を実装に埋めると、領域の名前が変わるたびにコードを直すことになる
 * （実際 `ai/` → `agent/` がこの直後に控えている）。**並びは «設定» であって «判定» ではない。**
 * 重みなら、後ろへ送るだけでなく「自分のフォルダを先頭に固定する」も同じ仕組みで書ける。
 *
 * ── 規則 ────────────────────────────────────
 *  1. 重みの小さいほうが先（既定 0）
 *  2. 同じ重みなら、ディレクトリが先
 *  3. それも同じなら名前順（`localeCompare`）
 *
 * 重みの出どころは `appearance.json` の `sortWeight`。設定は層になっているので
 * （配信の既定 → `user/config/` の上書き）、利用者の上書きは OS 更新で消えない。
 */

/** 名前 → 重み。小さいほど先に出る。 */
export type SortWeights = Record<string, number>;

/** 最上位の名前 → 記号。ディレクトリの既定（📁 / 📂）より優先する。 */
export type RootIcons = Record<string, string>;

/**
 * 配信の既定。利用者が普段触るもの（`user/` `agent/`）より後ろへ送る。
 *
 * ここに並ぶのは「その端末の仕組みであって、作業の対象ではない」もの:
 *   system … OS の配信物とこの端末の状態   local … 他の機械のマウント   trash … 削除済み
 */
export const DEFAULT_SORT_WEIGHTS: SortWeights = {
  system: 100,
  local: 100,
  trash: 200,
};

/**
 * 配信の既定の記号。**最上位の名前だけ**に効く。
 *
 * 開閉の分かるディレクトリ（📁 / 📂）をわざわざ潰すのは、
 * この 3 つが「入れ物」ではなく「その端末の仕組み」だからである。
 * 並びの重み（上の DEFAULT_SORT_WEIGHTS）と組み合わせて、
 * **下に沈み、かつ一目で別物と分かる**状態にする。
 *
 * `agent` は AI の領域（この配布物に無ければ、単に使われないだけ）。
 */
export const DEFAULT_ROOT_ICONS: RootIcons = {
  system: '⚙️',
  trash: '🗑️',
  agent: '✨',
};

/**
 * 最上位の記号を引く。無ければ null（＝呼び出し側が従来どおりの記号を出す）。
 *
 * 🔴 **最上位にだけ効かせる。** 深いところで名前だけを見ると、
 * `user/docs/system` のような普通のフォルダまで歯車になる。
 */
export function rootIconOf(path: string, icons?: RootIcons | null): string | null {
  if (!path || path.includes('/')) return null;
  const table = icons && typeof icons === 'object' ? icons : DEFAULT_ROOT_ICONS;
  const raw = (table as Record<string, unknown>)[path];
  return typeof raw === 'string' && raw ? raw : null;
}

/**
 * 重みを引く。設定が壊れていても落ちない（読めない値は既定の 0 として扱う）。
 *
 * 並びは «見た目» であり、ここで例外を投げると一覧そのものが出なくなる。
 * 設定の不備で画面が消えるより、既定の並びで出るほうがよい。
 */
export function weightOf(name: string, weights?: SortWeights | null): number {
  if (!weights || typeof weights !== 'object') return 0;
  const raw = (weights as Record<string, unknown>)[name];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

/** 並べ替えに渡す最小の形。ホストの木もゲストの一覧もこれに合わせられる。 */
export interface OrderableNode {
  name: string;
  kind: string;
}

/**
 * 比較関数。`Array.prototype.sort` にそのまま渡せる。
 *
 * 🔴 **同じ規則を 2 か所に書かない。** 2026-09-11 の時点で
 * 「ディレクトリが先、あとは名前順」は 3 か所（`PathResolver` の木・`TreeView` の DOM・
 * ゲストの `explorer.html`）に別々に書かれていた。重みを足す前にここへ寄せる。
 */
export function compareNodes(a: OrderableNode, b: OrderableNode, weights?: SortWeights | null): number {
  const wa = weightOf(a.name, weights);
  const wb = weightOf(b.name, weights);
  if (wa !== wb) return wa - wb;

  if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;

  return a.name.localeCompare(b.name);
}
