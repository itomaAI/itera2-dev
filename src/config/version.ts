/**
 * src/config/version.ts
 * OS の版。画面（index.html の下の帯）はここから出る（T-0805）。
 *
 * 土台が同じなので、Itera（itera2-dev・itera2）とミャク楽エージェントは同じ番号を名乗る。
 * package.json の version は別物（配布物ごとに違う意味を持つ）で、ここには関係しない。
 *
 * 上げ方（2026-11-11 山内さん）: ホスト（src/）を変える PR ごとに minor を上げる。細かい直しなら patch。
 * ミャク楽だけのホストの PR はミャク楽だけ上げる（番号がずれてよい）。同じ変更を横流しする PR のときだけ同じ番号にする（2026-11-12）。
 */
export const OS_VERSION = '2.3.1';
