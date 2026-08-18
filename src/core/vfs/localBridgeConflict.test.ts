/**
 * src/core/vfs/localBridgeConflict.test.ts
 * Local Bridge の衝突判定（T-0013）
 *
 * 対象は `vfs_root/system/services/local_bridge.html`（ゲスト実装）。
 * vitest の対象外なので、**実装をコピーせずソースから取り出して評価する**。
 *
 * 背景:
 *   3-way マージには分岐が7つしかなく、「両方が動いた」場合の分岐が無かった。
 *   どれにも該当しないまま素通りし、next は { ...anchor } なので古い値が残る。
 *   次の巡回でも同じ判定になり、**永久に、無言で**同期されなくなる。
 *   実際に、私の edit_file とデーモンの書き込みが同一ミリ秒で衝突して発生した。
 *
 * ここで守るのは「衝突を衝突と呼べること」である。
 * 分岐5・6・7で正しく処理される場合を衝突と誤判定すると、
 * 何も壊れていないファイルが毎回退避されて増殖する。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE_PATH = resolve(__dirname, '../../../vfs_root/system/services/local_bridge.html');

function loadIsConflict() {
  const src = readFileSync(SOURCE_PATH, 'utf-8');
  const m = src.match(/function isConflict\(l, r, a, same\) \{[\s\S]*?\n {8}\}/);
  if (!m) {
    throw new Error(
      'local_bridge.html から isConflict を取り出せなかった。実装の書き方が変わった可能性がある。' +
        '試験を通す前に、まず対象を確認すること。',
    );
  }
  const factory = new Function(`${m[0]}\nreturn isConflict;`);
  return factory() as (l: any, r: any, a: any, same: (x: any, y: any) => boolean) => boolean;
}

/** 実装と同じ比較（ハッシュのみを見る） */
const same = (x: any, y: any) => (x?.hash || null) === (y?.hash || null);

const F = (hash: string | null) => ({ kind: 'file', hash });

describe('local_bridge: 衝突（両側が動いた）の判定', () => {
  it('両側がアンカーから別々に動いていたら衝突（本命）', () => {
    const isConflict = loadIsConflict();
    expect(isConflict(F('L'), F('R'), F('A'), same)).toBe(true);
  });

  it('ローカルだけ動いたものは衝突ではない（分岐5が処理する）', () => {
    const isConflict = loadIsConflict();
    expect(isConflict(F('L'), F('A'), F('A'), same)).toBe(false);
  });

  it('リモートだけ動いたものは衝突ではない（分岐6が処理する）', () => {
    const isConflict = loadIsConflict();
    expect(isConflict(F('A'), F('R'), F('A'), same)).toBe(false);
  });

  it('内容が一致していれば衝突ではない（分岐7が吸収する）', () => {
    const isConflict = loadIsConflict();
    // 両側がアンカーから動いているが、結果が同じ。
    // ここを衝突にすると、収束して直った項目まで毎回退避されてしまう。
    // （実際、止まっていた項目はこの経路で復旧させた）
    expect(isConflict(F('X'), F('X'), F('A'), same)).toBe(false);
  });

  it('片側が存在しないものは衝突ではない（新規・削除は分岐2〜4）', () => {
    const isConflict = loadIsConflict();
    expect(isConflict(null, F('R'), F('A'), same)).toBe(false);
    expect(isConflict(F('L'), null, F('A'), same)).toBe(false);
    expect(isConflict(null, null, F('A'), same)).toBe(false);
  });

  it('アンカーが無い状態で両側に別内容があるなら衝突として扱う', () => {
    const isConflict = loadIsConflict();
    // アンカーを消しても分岐5・6・7は成立しないため、
    // ここを false にすると、やはり永久に素通りする項目が残る。
    expect(isConflict(F('L'), F('R'), undefined, same)).toBe(true);
  });

  it('アンカーが無く、両側の内容が同じなら衝突ではない', () => {
    const isConflict = loadIsConflict();
    expect(isConflict(F('X'), F('X'), undefined, same)).toBe(false);
  });
});

/**
 * local_fetch の1件ごとの判断（T-0013 の派生）
 *
 * 以前の実装は「実体化済みなら何もしない」で成功を返していた。
 * それは『VFS に実体があるか』の報告であって『ホストと一致しているか』の報告ではない。
 * 中身が食い違っていても「既に実体」と答えるため、修復に使えないばかりか
 * 「確認した」という誤った安心を与えていた。
 */
function loadClassifyFetchTarget() {
  const src = readFileSync(SOURCE_PATH, 'utf-8');
  const isStub = src.match(/const isStub = \(info\) => [^;]+;/);
  const fn = src.match(/function classifyFetchTarget\(info, r\) \{[\s\S]*?\n {8}\}/);
  if (!isStub || !fn) {
    throw new Error(
      'local_bridge.html から classifyFetchTarget / isStub を取り出せなかった。' +
        '実装の書き方が変わった可能性がある。試験を通す前に、まず対象を確認すること。',
    );
  }
  const factory = new Function(`${isStub[0]}\n${fn[0]}\nreturn classifyFetchTarget;`);
  return factory() as (info: any, r: any) => string;
}

describe('local_fetch: 1件ごとの扱いを決める', () => {
  it('スタブは落としてくる', () => {
    const classify = loadClassifyFetchTarget();
    expect(classify({ syncState: 'stub', hash: 'H' }, { hash: 'H' })).toBe('stub');
  });

  it('実体があり、ホストと一致していれば何もしない', () => {
    const classify = loadClassifyFetchTarget();
    expect(classify({ hash: 'H' }, { hash: 'H' })).toBe('match');
  });

  it('実体があり、ホストと違えば衝突として扱う（本命 / 以前は「既に実体」と嘘をついていた）', () => {
    const classify = loadClassifyFetchTarget();
    expect(classify({ hash: 'LOCAL' }, { hash: 'HOST' })).toBe('conflict');
  });

  it('ホストに無いものは衝突ではない（消さずに報告するだけ）', () => {
    const classify = loadClassifyFetchTarget();
    expect(classify({ hash: 'LOCAL' }, undefined)).toBe('gone');
    expect(classify({ hash: 'LOCAL' }, { isDeleted: true })).toBe('gone');
  });

  it('スタブ判定は syncState で行う（hash の有無では判定できない）', () => {
    const classify = loadClassifyFetchTarget();
    // createStub にホスト側のハッシュを渡しているため、スタブでも hash は非 null。
    // hash で判定すると、スタブが「実体あり」に見えて実体化されなくなる（過去に踏んだ）。
    expect(classify({ syncState: 'stub', hash: 'H' }, { hash: 'OTHER' })).toBe('stub');
  });
});
