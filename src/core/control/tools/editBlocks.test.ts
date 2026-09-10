/**
 * src/core/control/tools/editBlocks.test.ts
 * <edit_file> の SEARCH ブロック（T-0407）
 *
 * これが無いと同じ穴に落ち続ける: 「一致が一意でない」「塊が壊れている」のどちらも、
 * 以前は黙って通って success が返っていた。壊れたことに気づける唯一の手掛かりが
 * 「後でファイルを読み直して、書いたつもりの箇所を見に行く」ことだった。
 * ここで守りたいのは結果の正しさより **失敗が音を立てること** である。
 */

import { describe, it, expect } from 'vitest';
import { parseEditBlocks, applyEditBlocks } from './editBlocks';

/** 塊を切り出して当てる（道具が実際に通す順序） */
function edit(file: string, blocks: string, regex = false): string {
  return applyEditBlocks(file, parseEditBlocks(blocks), { regex });
}

describe('一意性 —— 定義文の "must be unique" を実装で守る', () => {
  it('一意なら置き換える', () => {
    const out = edit('a\nfoo\nb\n', '<<<<<SEARCH\nfoo\n=====\nbar\n>>>>>');
    expect(out).toBe('a\nbar\nb\n');
  });

  it('2 か所に当たるときは書かずにエラー。件数と行番号を出す', () => {
    // 2026-09-10 に踏んだ形そのもの: 本文が節見出しに言及していて、そちらに先に当たる
    const file = ['# 札', '', 'レポート: 成果物（下の `## 成果物` に一覧）', '', '## 成果物', '- x', ''].join('\n');
    expect(() => edit(file, '<<<<<SEARCH\n## 成果物\n=====\n## 成果物\n- y\n>>>>>')).toThrow(
      /matched 2 times \(line 3, 5\)/,
    );
  });

  it('周りの行を足して一意にすれば通る（エラー文が案内する直し方）', () => {
    const file = ['レポート: 成果物（下の `## 成果物` に一覧）', '', '## 成果物', '- x'].join('\n');
    const out = edit(file, '<<<<<SEARCH\n## 成果物\n- x\n=====\n## 成果物\n- x\n- y\n>>>>>');
    expect(out).toBe(['レポート: 成果物（下の `## 成果物` に一覧）', '', '## 成果物', '- x', '- y'].join('\n'));
  });

  it('見つからなければ書かない', () => {
    expect(() => edit('a\nb\n', '<<<<<SEARCH\nzzz\n=====\nyyy\n>>>>>')).toThrow(/not found/);
  });

  it('部分文字列としては当たるので、字下げごと写さなくても通る', () => {
    expect(edit('  const x = 1;\n', '<<<<<SEARCH\nconst x = 1;\n=====\nconst x = 2;\n>>>>>')).toBe('  const x = 2;\n');
  });

  it('複数行にまたがって字下げが食い違うときは、その理由を言う', () => {
    const file = 'function f() {\n    return 1;\n}\n';
    const blocks = '<<<<<SEARCH\nfunction f() {\n  return 1;\n}\n=====\nX\n>>>>>';
    expect(() => edit(file, blocks)).toThrow(/indentation differs/);
  });

  it('行末の空白だけが違うときも、その理由を言う', () => {
    const file = 'a  \nb\n';
    expect(() => edit(file, '<<<<<SEARCH\na\nb\n=====\nX\n>>>>>')).toThrow(/trailing whitespace/);
  });

  it('先頭行だけは在るときは、その行番号を出す', () => {
    const file = 'function f() {\n  return 1;\n}\n';
    expect(() => edit(file, '<<<<<SEARCH\nfunction f() {\n  return 2;\n}\n=====\nx\n>>>>>')).toThrow(
      /first line occurs at line 1/,
    );
  });

  it('両側が同一の塊は、書き換えのつもりの書き損じなのでエラー', () => {
    expect(() => edit('a\n', '<<<<<SEARCH\na\n=====\na\n>>>>>')).toThrow(/would not change anything/);
  });
});

describe('壊れた塊を黙って捨てない', () => {
  it('3 つ書いて 2 つ目の終端が無ければ、1 つ目も適用しない', () => {
    const blocks = ['<<<<<SEARCH', 'a', '=====', 'A', '>>>>>', '<<<<<SEARCH', 'b', '=====', 'B'].join('\n');
    expect(() => parseEditBlocks(blocks)).toThrow(/No closing marker found for the SEARCH block starting at line 6/);
  });

  it('区切りが無ければエラー（以前は塊ごと消えていた）', () => {
    expect(() => parseEditBlocks('<<<<<SEARCH\na\n>>>>>')).toThrow(/No separator found/);
  });

  it('開始マーカーが無ければ、個数ではなく「無い」と言う', () => {
    expect(() => parseEditBlocks('SEARCH\na\n=====\nb\n>>>>>')).toThrow(/No SEARCH block found/);
  });

  it('探す側が空の塊はエラー（全文に当たってしまうため）', () => {
    expect(() => parseEditBlocks('<<<<<SEARCH\n=====\nb\n>>>>>')).toThrow(/nothing to find/);
  });
});

describe('マーカーの個数 —— 候補が 1 本なら長さを問わない', () => {
  it('揃っていなくても通る（数えなくてよい）', () => {
    const out = edit('x\n', '<<<<<SEARCH\nx\n=======\ny\n>>>>>>>>>>');
    expect(out).toBe('y\n');
  });

  it('複数の塊を続けて書いても、隣の塊のマーカーを拾わない', () => {
    const blocks = ['<<<<<SEARCH', 'a', '======', 'A', '>>>>>>>', '<<<<<SEARCH', 'b', '====', 'B', '>>>>'].join('\n');
    expect(edit('a\nb\n', blocks)).toBe('A\nB\n');
  });

  it('本文に長さの違う `=` の行があっても、開始と同数のほうが選ばれる', () => {
    // ここが以前は黙って壊れていた。区切りは「最初に見つかった行」を無条件に採っていた
    const file = 'p\n======\nq\n';
    const blocks = ['<<<<<SEARCH', 'p', '======', 'q', '=====', 'DONE', '>>>>>'].join('\n');
    expect(edit(file, blocks)).toBe('DONE\n');
  });

  it('同じ長さの候補が 2 本あって決められないときは、行番号を並べてエラー', () => {
    const blocks = ['<<<<<SEARCH', 'p', '=====', 'q', '=====', 'DONE', '>>>>>'].join('\n');
    expect(() => parseEditBlocks(blocks)).toThrow(/Ambiguous separator .* line 3 .* line 5|Ambiguous separator/);
  });

  it('置換文の中に開始マーカーらしき行があるときは、壊さずエラーで止まる（既知の限界）', () => {
    // edit_file 自身の文書を edit_file で書き換えようとした場合。
    // 以前は置換文が途中で切れたまま success が返っていた
    const blocks = [
      '<<<<<SEARCH',
      'old',
      '=====',
      'example:',
      '<<<<<SEARCH',
      'a',
      '=====',
      'b',
      '>>>>>',
      'end',
      '>>>>>',
    ].join('\n');
    expect(() => parseEditBlocks(blocks)).toThrow(/Ambiguous closing marker/);
  });
});

describe('置換文はそのまま入る', () => {
  it('`$&` や `$1` が化けない', () => {
    expect(edit('K\n', '<<<<<SEARCH\nK\n=====\ncost: $5 $& $1\n>>>>>')).toBe('cost: $5 $& $1\n');
  });

  it('正規表現の記号を含む文字列を、そのまま探せる', () => {
    expect(edit('a.b\naxb\n', '<<<<<SEARCH\na.b\n=====\nOK\n>>>>>')).toBe('OK\naxb\n');
  });
});

describe('regex="true"', () => {
  it('行頭行末が効く（m フラグは従来どおり）', () => {
    expect(edit('foo1\nfoo2\n', '<<<<<SEARCH\n^foo1$\n=====\nBAR\n>>>>>', true)).toBe('BAR\nfoo2\n');
  });

  it('正規表現でも 2 か所に当たればエラー', () => {
    expect(() => edit('foo1\nfoo2\n', '<<<<<SEARCH\n^foo\\d$\n=====\nBAR\n>>>>>', true)).toThrow(/matched 2 times/);
  });
});
