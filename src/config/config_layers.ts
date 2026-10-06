/**
 * src/config/config_layers.ts
 * 設定・登録簿・言語ファイルをどの順で重ねるか。
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
 * ■ 2 段目の層は配布物の設定で決まる（T-0614）
 * 以前はここが「配布物ごとに違う唯一の場所」で、itera2 は `['system/config', 'user/config']` をコードに持っていた。
 * いまは **`system/config/paths.json`**（`user.config` / `user.registry` / `user.locales`）が 2 段目を指し、
 * `GuestPaths.ts` の `configLayersOf` などが並びを組む。ここに残るのは OS が規定する 1 段目だけ。
 * ホストのコードに `user/` `個人/` のような名前を書かない（守りは `guestPathLiterals.test.ts`）。
 *
 * これらの定数は「`paths.json` を知らないときの並び」＝ 1 層。コンストラクタの既定として使う。
 */
import { SYSTEM_CONFIG_DIR, SYSTEM_LOCALES_DIR, SYSTEM_REGISTRY_DIR } from '../core/sys/GuestPaths';

export const CONFIG_LAYERS: readonly string[] = [SYSTEM_CONFIG_DIR];

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
export const REGISTRY_LAYERS: readonly string[] = [SYSTEM_REGISTRY_DIR];

/** 書き先＝最後の層。ここは配信で上書きしない（VfsInitializer が使う）。 */
export function writeLayerOf(layers: readonly string[]): string {
  return layers[layers.length - 1];
}

/**
 * 言語ファイル（`<dir>/<言語>.json`）を読む順。**後の層が勝つ**。その下に英語（ホストの TS）がある。
 * 2 段目（itera2-dev は `paths.json` の `user.locales` = `user/locales`）は設定で決まる。書き込みはしない（読むだけ）。
 */
export const LOCALE_LAYERS: readonly string[] = [SYSTEM_LOCALES_DIR];

/** 設定（appearance.locale）に言語が無いときの UI の言語。Itera は英語（ミャク楽は ja。T-0554 / T-0556）。 */
export const DEFAULT_LOCALE = 'en';

/**
 * 既定の言語の辞書。VFS が読めない時点（初めての起動の最初・起動失敗画面）でも既定の言語で出すために、ホストに同梱する。
 * Itera の既定は英語で、英語はホストの TS（`messages_en`）そのものなので、重ねる辞書は無い。
 * ミャク楽は配る ja.json を import して渡している（出典は 1 つのまま）。
 */
export const DEFAULT_LOCALE_MESSAGES: unknown = undefined;
