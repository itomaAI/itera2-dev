import { describe, it, expect } from 'vitest';
import { isSelectableForPicker } from './FilePickerModal';

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
