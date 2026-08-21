/**
 * tests/guest/gdriveExclusion.test.ts
 * gdrive_sync の除外判定（T-0014）
 *
 * 対象は VFS 側のゲスト実装 `vfs_root/system/services/gdrive_sync.html` である。
 * ここは vitest の対象外なので、**実装をコピーせず、ソースから関数を取り出して評価する**。
 * （コピーすると、コピーだけが正しくて本体が壊れている状態を検出できない。）
 *
 * 守りたいこと:
 *   ドライブ同期はルート('')をマウントしうるため、他プロバイダ（Local Bridge）の
 *   マウント地点だけでなく **その祖先ディレクトリ** も同期対象から外す必要がある。
 *   祖先を持ったままにすると、Drive 側でその入れ物が消えたときに
 *   VFS のディレクトリ削除 → 配下ごと巻き添え → 相手が実機へ削除を伝播、
 *   という経路が成立する（利用者のファイルが消える向き）。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE_PATH = resolve(__dirname, '../../vfs_root/system/services/gdrive_sync.html');

/** ソースから断片を切り出す。取り出せなければ**失敗させる**（黙って素通りさせない）。 */
function extract(source: string, pattern: RegExp, label: string): string {
  const m = source.match(pattern);
  if (!m) {
    throw new Error(
      `gdrive_sync.html から ${label} を取り出せなかった。` +
        `実装の書き方が変わった可能性がある。試験を通す前に、まず対象を確認すること。`,
    );
  }
  return m[0];
}

/**
 * 実ソースの isExcluded を、外側の変数だけ差し替えて取り出す。
 * ALWAYS_EXCLUDED / SYSTEM_SYNCED は実物をそのまま使う（値も契約のうちなので）。
 */
function loadIsExcluded(foreignMountPaths: string[], userExcludedPaths: string[] = []) {
  const src = readFileSync(SOURCE_PATH, 'utf-8');

  const alwaysExcluded = extract(src, /const ALWAYS_EXCLUDED = \[[^\]]*\];/, 'ALWAYS_EXCLUDED');
  const systemSynced = extract(src, /const SYSTEM_SYNCED = \[[^\]]*\];/, 'SYSTEM_SYNCED');
  const matchesPrefix = extract(src, /function matchesPrefix\(path, prefix\) \{[\s\S]*?\n {6}\}/, 'matchesPrefix');
  const isExcluded = extract(src, /function isExcluded\(path\) \{[\s\S]*?\n {6}\}/, 'isExcluded');

  const factory = new Function(
    'foreignMountPaths',
    'userExcludedPaths',
    `${alwaysExcluded}\n${systemSynced}\n${matchesPrefix}\n${isExcluded}\nreturn isExcluded;`,
  );
  return factory(foreignMountPaths, userExcludedPaths) as (path: string) => boolean;
}

// 実環境のマウント表（実測値）
const MOUNTS = ['local/spark-5b30/workspace', 'local/yachiyo/ws_itera'];

describe('gdrive_sync: 他プロバイダの領域を除外する', () => {
  it('マウント配下は除外する（従来からの動作）', () => {
    const isExcluded = loadIsExcluded(MOUNTS);

    expect(isExcluded('local/yachiyo/ws_itera')).toBe(true);
    expect(isExcluded('local/yachiyo/ws_itera/itera2-dev/src/main.ts')).toBe(true);
    expect(isExcluded('local/spark-5b30/workspace/memo.txt')).toBe(true);
  });

  it('マウント地点の祖先も除外する（本命 / T-0014）', () => {
    const isExcluded = loadIsExcluded(MOUNTS);

    // ここが false のままだと、Drive 側でこの入れ物が消えたときに
    // 配下（＝Local Bridge の管轄）ごと削除され、実機へ伝播しうる。
    expect(isExcluded('local')).toBe(true);
    expect(isExcluded('local/yachiyo')).toBe(true);
    expect(isExcluded('local/spark-5b30')).toBe(true);
  });

  it('名前が似ているだけのパスは巻き込まない（前置一致の誤爆防止）', () => {
    const isExcluded = loadIsExcluded(MOUNTS);

    // 'local' で始まるが 'local/' ではない
    expect(isExcluded('localstuff')).toBe(false);
    expect(isExcluded('locale/ja.json')).toBe(false);
    // 兄弟の接続名
    expect(isExcluded('local2/yachiyo/ws_itera')).toBe(false);
  });

  it('マウントが1つも無ければ、この規則は何も除外しない', () => {
    const isExcluded = loadIsExcluded([]);

    expect(isExcluded('local')).toBe(false);
    expect(isExcluded('local/yachiyo')).toBe(false);
    expect(isExcluded('data/notes.md')).toBe(false);
  });

  it('通常のデータは従来どおり同期対象のまま（陰性対照）', () => {
    const isExcluded = loadIsExcluded(MOUNTS);

    expect(isExcluded('data/01_projects/Myaku_Raku/plan.md')).toBe(false);
    expect(isExcluded('memory/knowledge/index.md')).toBe(false);
    expect(isExcluded('apps/handoff.html')).toBe(false);
  });

  it('system/ の allowlist は壊れていない（祖先は残す＝今回の規則とは逆向き）', () => {
    const isExcluded = loadIsExcluded(MOUNTS);

    // 入れ物としての 'system' は同期対象に含める必要がある
    // （落とすと Drive に空フォルダが溜まる。実際に125個堆積した）
    expect(isExcluded('system')).toBe(false);
    expect(isExcluded('system/config')).toBe(false);
    expect(isExcluded('system/config/preferences.json')).toBe(false);

    // 許可されていない system 配下は除外
    expect(isExcluded('system/logs')).toBe(true);
    expect(isExcluded('system/temp/gdrive_token.json')).toBe(true);
    expect(isExcluded('system/credentials/github.json')).toBe(true);
  });

  it('trash と空パスは除外する', () => {
    const isExcluded = loadIsExcluded(MOUNTS);

    expect(isExcluded('trash')).toBe(true);
    expect(isExcluded('trash/old.md')).toBe(true);
    expect(isExcluded('')).toBe(true);
  });

  it('利用者指定の除外は従来どおり効く', () => {
    const isExcluded = loadIsExcluded(MOUNTS, ['data/00_inbox']);

    expect(isExcluded('data/00_inbox')).toBe(true);
    expect(isExcluded('data/00_inbox/capture.md')).toBe(true);
    expect(isExcluded('data/00_inboxes')).toBe(false);
  });
});
