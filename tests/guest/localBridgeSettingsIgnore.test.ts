/**
 * tests/guest/localBridgeSettingsIgnore.test.ts
 * 設定アプリ「無視するファイル」の編集画面（T-0072）
 *
 * 対象は `vfs_root/system/apps/local_bridge_settings.html`（ゲスト実装）。
 * vitest の対象外なので、**実装をコピーせずソースから取り出して評価する**。
 * （コピーすると、コピーだけが正しくて本体が壊れている状態を検出できない。）
 *
 * 背景:
 *   T-0059 で 3 階層（既定 ∪ 接続 ∪ ルート）の編集欄を画面に並べたところ、
 *   接続 3・ルート 4 の環境で **8 個の欄が縦に並び**、本文を押し下げた。
 *   T-0072 で「行のボタン → その階層だけを開く画面」に移した。
 *
 * ここで守るのは二点:
 *   1. **保存した設定が、デーモンが読む形になっていること。**
 *      デーモンは `config.ignorePatterns` / `conn.ignorePatterns` /
 *      `conn.roots[root].ignorePatterns` の 3 か所しか見ない（`ignorePatternsFor()`）。
 *      見た目を直すついでにここを崩すと、**画面上は保存できたのに何も無視されない**。
 *   2. **対象の番号が再描画で増えないこと。**
 *      画面は 15 秒ごとに描き直される。番号を積むだけの実装だと、
 *      開いたままの画面が指す対象がずれていく。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE_PATH = resolve(__dirname, '../../vfs_root/system/apps/local_bridge_settings.html');
const SRC = readFileSync(SOURCE_PATH, 'utf-8');

/** ソースから断片を切り出す。取り出せなければ**失敗させる**（黙って素通りさせない）。 */
function extract(re: RegExp, label: string): string {
  const m = SRC.match(re);
  if (!m) {
    throw new Error(
      `local_bridge_settings.html から ${label} を取り出せなかった。実装の書き方が変わった可能性がある。` +
        '試験を通す前に、まず対象を確認すること。',
    );
  }
  return m[0];
}

const parseIgnoreSrc = extract(/const parseIgnore = \(text\) =>[\s\S]*?\.filter\(Boolean\);/, 'parseIgnore');
const ignoreKeySrc = extract(/const ignoreKey = \(t\) => [^\n]+/, 'ignoreKey');
const targetIndexSrc = extract(/function ignoreTargetIndex\(t\) \{[\s\S]*?\n {6}\}/, 'ignoreTargetIndex');
const saveIgnoreSrc = extract(/async function saveIgnore\(\) \{[\s\S]*?\n {6}\}/, 'saveIgnore');

describe('設定アプリ: 編集対象の番号', () => {
  function loadTargets() {
    const factory = new Function(
      `let ignoreTargets = [];\n${ignoreKeySrc}\n${targetIndexSrc}\n` +
        'return { ignoreTargetIndex, targets: () => ignoreTargets };',
    );
    return factory() as { ignoreTargetIndex: (t: any) => number; targets: () => any[] };
  }

  it('同じ対象は同じ番号に畳む（15 秒ごとの再描画で増えない・本命）', () => {
    const { ignoreTargetIndex, targets } = loadTargets();
    const a = ignoreTargetIndex({ scope: 'root', conn: 'spark', root: 'workspace' });
    const b = ignoreTargetIndex({ scope: 'root', conn: 'spark', root: 'workspace' });
    expect(b).toBe(a);
    expect(targets()).toHaveLength(1);
  });

  it('接続が同じでもルートが違えば別の番号', () => {
    const { ignoreTargetIndex } = loadTargets();
    const a = ignoreTargetIndex({ scope: 'root', conn: 'spark', root: 'workspace' });
    const b = ignoreTargetIndex({ scope: 'root', conn: 'spark', root: 'densoten' });
    expect(b).not.toBe(a);
  });

  it('階層が違えば別の番号（接続ごと と ルートごと を取り違えない）', () => {
    const { ignoreTargetIndex } = loadTargets();
    const conn = ignoreTargetIndex({ scope: 'conn', conn: 'spark', root: null });
    const root = ignoreTargetIndex({ scope: 'root', conn: 'spark', root: 'workspace' });
    const global = ignoreTargetIndex({ scope: 'global' });
    expect(new Set([conn, root, global]).size).toBe(3);
  });
});

interface SaveHarness {
  saveIgnore: () => Promise<void>;
  config: any;
  restartHinted: boolean;
  alerts: string[];
}

/** saveIgnore を実装から取り出し、偽の DOM と偽の設定で走らせる。 */
function loadSave(scope: any, text: string, config: any): SaveHarness {
  const h: SaveHarness = { saveIgnore: null as any, config, restartHinted: false, alerts: [] };

  const DOM = (id: string) => (id === 'ig_edit' ? { value: text } : { textContent: '' });
  const mutateConfig = async (fn: (cfg: any) => any) => {
    // 本体と同じく「読み直して・変えて・書く」。ここでは書き戻しを h.config に受ける。
    const next = fn(JSON.parse(JSON.stringify(h.config)));
    if (!next) return false;
    h.config = next;
    return true;
  };
  const alertBox = (msg: string) => h.alerts.push(msg);
  const notifyRestartNeeded = () => {
    h.restartHinted = true;
  };
  const renderIgnoreModal = () => {};

  const factory = new Function(
    'igScope',
    'DOM',
    'mutateConfig',
    'alertBox',
    'notifyRestartNeeded',
    'renderIgnoreModal',
    `${parseIgnoreSrc}\n${saveIgnoreSrc}\nreturn saveIgnore;`,
  );
  h.saveIgnore = factory(scope, DOM, mutateConfig, alertBox, notifyRestartNeeded, renderIgnoreModal);
  return h;
}

const BASE = () => ({
  connections: [
    { serverUrl: 'http://127.0.0.1:8002', name: 'spark-5b30', machineId: 'M1', enabled: true },
    { serverUrl: 'http://127.0.0.1:8001', name: 'yachiyo', machineId: 'M2', enabled: true },
  ],
  ignorePatterns: ['.git', 'node_modules'],
});

describe('設定アプリ: 保存した設定は、デーモンが読む形になっている', () => {
  it('ルートごと → conn.roots[root].ignorePatterns（本命）', async () => {
    const h = loadSave({ scope: 'root', conn: 'spark-5b30', root: 'workspace' }, 'data\n*.png', BASE());
    await h.saveIgnore();
    const c = h.config.connections.find((x: any) => x.name === 'spark-5b30');
    expect(c.roots.workspace.ignorePatterns).toEqual(['data', '*.png']);
    // 他のルート・他の接続を巻き込まない
    expect(h.config.connections.find((x: any) => x.name === 'yachiyo').roots).toBeUndefined();
  });

  it('接続ごと → conn.ignorePatterns', async () => {
    const h = loadSave({ scope: 'conn', conn: 'spark-5b30', root: null }, 'datasets', BASE());
    await h.saveIgnore();
    expect(h.config.connections.find((x: any) => x.name === 'spark-5b30').ignorePatterns).toEqual(['datasets']);
  });

  it('すべての接続に効く既定 → config.ignorePatterns', async () => {
    const h = loadSave({ scope: 'global' }, '.git\nnode_modules\ndist', BASE());
    await h.saveIgnore();
    expect(h.config.ignorePatterns).toEqual(['.git', 'node_modules', 'dist']);
  });

  it('デーモンが書く name / machineId を消さない', async () => {
    const h = loadSave({ scope: 'root', conn: 'spark-5b30', root: 'workspace' }, 'data', BASE());
    await h.saveIgnore();
    const c = h.config.connections.find((x: any) => x.name === 'spark-5b30');
    expect(c.machineId).toBe('M1');
    expect(c.serverUrl).toBe('http://127.0.0.1:8002');
  });

  it('同じルートに二度書いても、前の指定を積み増さない（置き換える）', async () => {
    const first = loadSave({ scope: 'root', conn: 'spark-5b30', root: 'workspace' }, 'data', BASE());
    await first.saveIgnore();
    const second = loadSave({ scope: 'root', conn: 'spark-5b30', root: 'workspace' }, '*.png', first.config);
    await second.saveIgnore();
    const c = second.config.connections.find((x: any) => x.name === 'spark-5b30');
    expect(c.roots.workspace.ignorePatterns).toEqual(['*.png']);
  });

  it('空行と前後の空白は落とす（空欄なら空の配列）', async () => {
    const h = loadSave({ scope: 'global' }, '  data  \n\n\n   \n*.png', BASE());
    await h.saveIgnore();
    expect(h.config.ignorePatterns).toEqual(['data', '*.png']);

    const empty = loadSave({ scope: 'global' }, '\n  \n', BASE());
    await empty.saveIgnore();
    expect(empty.config.ignorePatterns).toEqual([]);
  });

  it('接続が見つからないときは何も書かない（黙って新しい接続を作らない）', async () => {
    const h = loadSave({ scope: 'conn', conn: 'いない機械', root: null }, 'data', BASE());
    await h.saveIgnore();
    expect(h.config.connections).toHaveLength(2);
    expect(h.alerts.join('\n')).toContain('接続が見つかりません');
    expect(h.restartHinted).toBe(false);
  });

  it('保存したらデーモンの再起動を促す（設定は起動時にしか読まれない）', async () => {
    const h = loadSave({ scope: 'global' }, 'data', BASE());
    await h.saveIgnore();
    expect(h.restartHinted).toBe(true);
  });
});
