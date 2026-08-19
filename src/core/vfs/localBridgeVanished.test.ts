/**
 * src/core/vfs/localBridgeVanished.test.ts
 * Local Bridge: リモートから消えた項目の扱い（T-0027）
 *
 * 対象は `vfs_root/system/services/local_bridge.html`（ゲスト実装）。
 * vitest の対象外なので、**実装をコピーせずソースから取り出して評価する**。
 *
 * 背景:
 *   サーバー側の墓石（isDeleted）は Bridge の DELETE API を通したときだけ作られる。
 *   シェルの `mv` や `rm` は API を通らないので墓石が残らず、リモート一覧から
 *   黙って消えるだけになる。この「リモートに無い・VFS にある・アンカーにある」は
 *   分岐1〜8のどれにも当たらず素通りし、next は { ...anchor } なので
 *   **移動元が永久に残る**（実際に約180MBの幽霊が溜まっていた）。
 *
 * ここで守るのは二つ。
 *   1. 消えたものを消せること（移動元が残らない）
 *   2. **未送信の変更を巻き添えにしないこと**。
 *      サーバーは読めなかったファイルを一覧に載せないため、
 *      「一覧に無い」は「削除された」と同義ではない。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE_PATH = resolve(__dirname, '../../../vfs_root/system/services/local_bridge.html');

function extract(pattern: RegExp, name: string): string {
  const src = readFileSync(SOURCE_PATH, 'utf-8');
  const m = src.match(pattern);
  if (!m) {
    throw new Error(
      `local_bridge.html から ${name} を取り出せなかった。実装の書き方が変わった可能性がある。` +
        '試験を通す前に、まず対象を確認すること。',
    );
  }
  return m[0];
}

function loadClassifyVanished() {
  const fn = extract(/function classifyVanished\(l, a, same\) \{[\s\S]*?\n {8}\}/, 'classifyVanished');
  const factory = new Function(`${fn}\nreturn classifyVanished;`);
  return factory() as (l: any, a: any, same: (x: any, y: any) => boolean) => string;
}

function loadIsDegenerateListing() {
  const fn = extract(
    /function isDegenerateListing\(remoteCount, anchorCount\) \{[\s\S]*?\n {8}\}/,
    'isDegenerateListing',
  );
  const factory = new Function(`${fn}\nreturn isDegenerateListing;`);
  return factory() as (remoteCount: number, anchorCount: number) => boolean;
}

/** 実装と同じ比較（ハッシュのみを見る） */
const same = (x: any, y: any) => (x?.hash || null) === (y?.hash || null);

const F = (hash: string | null) => ({ kind: 'file', hash });
const D = () => ({ kind: 'directory', hash: null });

describe('local_bridge: リモートから消えた項目の扱い', () => {
  it('VFS 側が動いていなければ消す（本命 / 移動元・削除跡が残らない）', () => {
    const classify = loadClassifyVanished();
    expect(classify(F('A'), F('A'), same)).toBe('delete');
  });

  it('VFS 側に未送信の変更があれば消さず、復活させる（本命の逆側）', () => {
    const classify = loadClassifyVanished();
    // ここを 'delete' にすると、サーバーが一時的に一覧を返せなかっただけで
    // 未送信の編集が消える。取り返しがつかないのはこちら側。
    expect(classify(F('LOCAL'), F('A'), same)).toBe('revive');
  });

  it('ディレクトリはこの場で消さない（子を巻き添えにしないため）', () => {
    const classify = loadClassifyVanished();
    expect(classify(D(), D(), same)).toBe('directory');
    // 片側だけディレクトリに見える場合も、再帰削除の危険があるので同じ扱いにする。
    expect(classify(D(), F('A'), same)).toBe('directory');
    expect(classify(F('A'), D(), same)).toBe('directory');
  });

  it('この分岐の対象でないものは none（l か a が無い）', () => {
    const classify = loadClassifyVanished();
    expect(classify(null, F('A'), same)).toBe('none');
    expect(classify(F('L'), null, same)).toBe('none');
    expect(classify(null, null, same)).toBe('none');
  });

  it('ハッシュが両方 null でも「動いていない」と見なす（同一と扱う）', () => {
    const classify = loadClassifyVanished();
    expect(classify(F(null), F(null), same)).toBe('delete');
  });
});

describe('local_bridge: リモート一覧が信用できない場合', () => {
  it('一覧が空でアンカーに項目があるなら不自然（走査失敗と区別できない）', () => {
    const degenerate = loadIsDegenerateListing();
    // ここを false にすると、走査に失敗した一度きりの空応答で全消しになる。
    expect(degenerate(0, 5)).toBe(true);
  });

  it('もともと空なら不自然ではない', () => {
    const degenerate = loadIsDegenerateListing();
    expect(degenerate(0, 0)).toBe(false);
  });

  it('一覧が返っていれば、多少減っていても止めない（正当な一括移動を妨げない）', () => {
    const degenerate = loadIsDegenerateListing();
    // 1.4GB を _旧版/ へ移動したような場合、消える項目は大量になる。
    // これを止めてしまうと同期が進まないので、空のときだけを異常として扱う。
    expect(degenerate(1, 500)).toBe(false);
    expect(degenerate(3, 5)).toBe(false);
  });
});
