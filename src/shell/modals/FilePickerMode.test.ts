import { describe, it, expect } from 'vitest';
import { isSelectableForPicker, resolveSavePath } from './FilePickerModal';

/**
 * ファイル選択ダイアログで何を選べるか（T-0017）
 *
 * 背景:
 *   以前は `if (stat.kind === 'directory') return;` でディレクトリを明示的に弾いており、
 *   フォルダを選ぶ手段が無かった。既定は 'file' のままにして後方互換を保つ。
 *
 * 拡張子フィルタは**ファイルにだけ**掛ける。ディレクトリにも掛けると、
 * 名前に点を含むフォルダ（例: `v1.2`）だけが選べるという妙な挙動になる。
 */

describe('選べるかどうかの判定', () => {
  it('既定（file）ではフォルダを選べない（従来どおり）', () => {
    expect(isSelectableForPicker('directory', 'file', 'docs', [])).toBe(false);
  });

  it('directory ではフォルダを選べる（本命 / これが無かった）', () => {
    expect(isSelectableForPicker('directory', 'directory', 'docs', [])).toBe(true);
  });

  it('directory ではファイルを選べない', () => {
    expect(isSelectableForPicker('file', 'directory', 'a.md', [])).toBe(false);
  });

  it('any では両方選べる', () => {
    expect(isSelectableForPicker('directory', 'any', 'docs', [])).toBe(true);
    expect(isSelectableForPicker('file', 'any', 'a.md', [])).toBe(true);
  });

  it('拡張子フィルタはファイルに効く（従来どおり）', () => {
    expect(isSelectableForPicker('file', 'file', 'a.md', ['.md'])).toBe(true);
    expect(isSelectableForPicker('file', 'file', 'a.png', ['.md'])).toBe(false);
  });

  it('拡張子フィルタはフォルダには効かせない', () => {
    // ここを効かせると「v1.2」のような名前のフォルダだけが選べることになる。
    expect(isSelectableForPicker('directory', 'directory', 'releases/v1.2', ['.md'])).toBe(true);
    expect(isSelectableForPicker('directory', 'any', 'docs', ['.md'])).toBe(true);
  });

  it('大文字の拡張子でも通す（従来どおり）', () => {
    expect(isSelectableForPicker('file', 'file', 'A.MD', ['.md'])).toBe(true);
  });
});

describe('保存先のフルパス（showSaveDialog）', () => {
  it('フォルダ＋名前をつなぐ。ルートなら名前だけ', () => {
    expect(resolveSavePath('個人/資料', '見積.xlsx', [])).toBe('個人/資料/見積.xlsx');
    expect(resolveSavePath('', 'a.txt', [])).toBe('a.txt');
    expect(resolveSavePath('docs/', 'a.txt', [])).toBe('docs/a.txt');
  });

  it('拡張子が無ければ filters の先頭を付け、合わない拡張子は断る', () => {
    expect(resolveSavePath('d', '見積', ['.xlsx', '.csv'])).toBe('d/見積.xlsx');
    expect(resolveSavePath('d', '見積.csv', ['.xlsx', '.csv'])).toBe('d/見積.csv');
    expect(resolveSavePath('d', '見積.pdf', ['.xlsx', '.csv'])).toBeNull();
    expect(resolveSavePath('d', 'v1.2', ['.xlsx'])).toBeNull();
  });

  it('空・区切り文字・. .. は断る', () => {
    for (const n of ['', '  ', 'a/b', 'a\\b', '.', '..']) expect(resolveSavePath('d', n, []), n).toBeNull();
  });
});
