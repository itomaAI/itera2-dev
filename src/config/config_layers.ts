/**
 * src/config/config_layers.ts
 * 設定をどの順で重ねるか。**配布物ごとに違う唯一の場所。**
 *
 * ここに並べたディレクトリを順に読み、**後の層が勝つ**。
 * `ConfigManager.update()` の書き先は**最後の層**である。
 *
 * ■ なぜ層にするのか
 * 配信の既定と利用者の上書きが同じファイルに同居していると、
 *   - 配信で上書きする  → 利用者の設定が消える
 *   - 配信で上書きしない → 新しい既定が既存の環境へ永久に届かない
 * のどちらかしか選べない。層に分ければどちらも起きない。
 *
 * ■ この配布物（itera2-dev）では 1 層
 * 利用者の領域を持たないので `system/config` だけ。**挙動はこれまでと変わらない。**
 * クラウド版（itera2）は `['system/config', 'user/config']` を渡す。
 * 形は `src/config/wake_policy.ts` と同じ —— コードは共通、並びだけが配布物ごとの定数。
 */
export const CONFIG_LAYERS: readonly string[] = ['system/config'];

/**
 * 登録簿（apps.json / services.json）を読む順。**後の層が勝つ。**
 *
 * 同じ `id` が両方にあれば、後の層の項目で置き換える。
 *
 * 🔴 **アダプタ（adapters.json）にはこの層を使わない。**
 * アダプタはホストの window へ `import()` される＝ホストの任意コード実行と等価であり、
 * かつ利用者の層は同期される。層を認めると、アカウントが奪われたときに
 * **すべての端末でホストのコードが走る**。アダプタは配信物だけから読む。
 */
export const REGISTRY_LAYERS: readonly string[] = ['system/registry'];

/** 書き先＝最後の層。ここは配信で上書きしない（VfsInitializer が使う）。 */
export function writeLayerOf(layers: readonly string[]): string {
  return layers[layers.length - 1];
}

/**
 * 言語ファイル（`<dir>/<言語>.json`）を読む順。**後の層が勝つ**。その下に英語（ホストの TS）がある。
 * 設定の層とは独立に固定する（P-0046 2026-09-25 山内さん）。itera2-dev は既定で `user/` を持たないが、
 * `user/locales` を作ればそこが効く。書き込みはしない（読むだけ）。
 */
export const LOCALE_LAYERS: readonly string[] = ['system/locales', 'user/locales'];

/** 設定（appearance.locale）に言語が無いときの UI の言語。Itera は英語（ミャク楽は ja。T-0554 / T-0556）。 */
export const DEFAULT_LOCALE = 'en';

/**
 * 既定の言語の辞書。VFS が読めない時点（初めての起動の最初・起動失敗画面）でも既定の言語で出すために、ホストに同梱する。
 * Itera の既定は英語で、英語はホストの TS（`messages_en`）そのものなので、重ねる辞書は無い。
 * ミャク楽は配る ja.json を import して渡している（出典は 1 つのまま）。
 */
export const DEFAULT_LOCALE_MESSAGES: unknown = undefined;
