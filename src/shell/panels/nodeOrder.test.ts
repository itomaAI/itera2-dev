/**
 * src/shell/panels/nodeOrder.test.ts
 * 一覧の並び — 既定の規則と、重みによる上書き（T-0429）
 *
 * 守りたいこと:
 *   1. 既定は従来どおり「ディレクトリが先、あとは名前順」。重みを入れない限り並びは変わらない
 *   2. 重みは名前で引く。**接頭辞ではない**（'system' の重みが 'systematic' に効いてはならない）
 *   3. 設定が壊れていても並びは出る。見た目の設定の不備で一覧が消えるほうが困る
 */

import { describe, it, expect } from 'vitest';
import {
  compareNodes,
  weightOf,
  rootIconOf,
  DEFAULT_ROOT_ICONS,
  DEFAULT_SORT_WEIGHTS,
  type RootIcons,
  type SortWeights,
} from './nodeOrder';

const dir = (name: string) => ({ name, kind: 'directory' });
const file = (name: string) => ({ name, kind: 'file' });

const order = (nodes: Array<{ name: string; kind: string }>, weights?: SortWeights | null) =>
  [...nodes].sort((a, b) => compareNodes(a, b, weights)).map((n) => n.name);

describe('compareNodes', () => {
  it('重みが無ければ、ディレクトリが先・あとは名前順（従来どおり）', () => {
    expect(order([file('b.txt'), dir('z'), file('a.txt'), dir('a')])).toEqual(['a', 'z', 'a.txt', 'b.txt']);
  });

  it('重みの大きいものが後ろへ回る', () => {
    const w = { system: 100, trash: 200 };
    expect(order([dir('system'), dir('user'), dir('trash'), dir('agent')], w)).toEqual([
      'agent',
      'user',
      'system',
      'trash',
    ]);
  });

  it('負の重みで先頭に固定できる（後回しだけの仕組みにしない）', () => {
    expect(order([dir('system'), dir('user'), dir('memo')], { system: 100, memo: -10 })).toEqual([
      'memo',
      'user',
      'system',
    ]);
  });

  it('同じ重みの中では、従来どおりディレクトリが先・名前順', () => {
    const w = { system: 100, local: 100 };
    expect(order([dir('local'), file('system'), dir('system'), dir('user')], w)).toEqual([
      'user',
      'local',
      'system',
      'system',
    ]);
  });

  it('🔴 重みは名前そのもので引く（接頭辞で引かない）', () => {
    // 'system' を後回しにしたつもりで 'systematic.md' まで下がると、
    // 利用者のファイルが黙って沈む。
    const w = { system: 100 };
    expect(order([dir('system'), file('systematic.md'), dir('user')], w)).toEqual(['user', 'systematic.md', 'system']);
  });

  it('配信の既定は system / local を下げ、trash をいちばん下にする', () => {
    expect(order([dir('trash'), dir('system'), dir('user'), dir('local'), dir('agent')], DEFAULT_SORT_WEIGHTS)).toEqual(
      ['agent', 'user', 'local', 'system', 'trash'],
    );
  });
});

describe('weightOf', () => {
  it('知らない名前は 0', () => {
    expect(weightOf('user', { system: 100 })).toBe(0);
  });

  it('設定が無くても落ちない', () => {
    expect(weightOf('system', undefined)).toBe(0);
    expect(weightOf('system', null)).toBe(0);
  });

  it('数でない値・壊れた設定は 0 として扱う（並びは出る）', () => {
    const broken = { system: 'とても後ろ', local: NaN, trash: null } as unknown as SortWeights;
    expect(weightOf('system', broken)).toBe(0);
    expect(weightOf('local', broken)).toBe(0);
    expect(weightOf('trash', broken)).toBe(0);
    expect(weightOf('system', 'まるごと文字列' as unknown as SortWeights)).toBe(0);
  });
});

describe('rootIconOf', () => {
  it('最上位の名前には表の記号を返す', () => {
    expect(rootIconOf('system', DEFAULT_ROOT_ICONS)).toBe('⚙️');
    expect(rootIconOf('trash', DEFAULT_ROOT_ICONS)).toBe('🗑️');
    expect(rootIconOf('agent', DEFAULT_ROOT_ICONS)).toBe('✨');
  });

  it('表に無い最上位は null（呼び出し側が従来どおりの記号を出す）', () => {
    expect(rootIconOf('user', DEFAULT_ROOT_ICONS)).toBeNull();
    expect(rootIconOf('local', DEFAULT_ROOT_ICONS)).toBeNull();
  });

  it('🔴 最上位にだけ効く（深いところの同名フォルダは巻き込まない）', () => {
    // ここを名前だけで見ると、利用者が作った user/docs/system が歯車になる。
    expect(rootIconOf('user/docs/system', DEFAULT_ROOT_ICONS)).toBeNull();
    expect(rootIconOf('agent/rules/trash', DEFAULT_ROOT_ICONS)).toBeNull();
  });

  it('上書きできる。壊れた値と空文字は無いものとして扱う', () => {
    expect(rootIconOf('agent', { agent: '🤖' })).toBe('🤖');
    expect(rootIconOf('agent', { agent: '' })).toBeNull();
    expect(rootIconOf('agent', { agent: 42 } as unknown as RootIcons)).toBeNull();
  });

  it('設定が無ければ配信の既定を使う', () => {
    expect(rootIconOf('system', undefined)).toBe('⚙️');
    expect(rootIconOf('system', null)).toBe('⚙️');
  });

  it('空のパスは記号を持たない', () => {
    expect(rootIconOf('', DEFAULT_ROOT_ICONS)).toBeNull();
  });
});
