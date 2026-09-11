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
