/**
 * src/core/vfs/VfsEventFormatter.test.ts
 * ファイル操作の知らせの文（VfsEventFormatter）の形（T-0922）
 *
 * AI と利用者が読む「何が起きたか」の 1 行。呼び手は HostApiRouter（fs:*）と Explorer（利用者の操作）。
 * 1 件はパスを、行き先の決まった操作（移動・コピー・アップロード）は名前を、複数は件数と最初の 3 つの名前を出す。
 * 行き先のフォルダが無く、先が元と違う項目（改名・ゴミ箱から戻す）は、複数でも「元 -> 先」（T-0923）。
 * itera2-dev とミャク楽で同じファイルを置く（文の形を両方で同じに保つため）。
 */

import { describe, it, expect } from 'vitest';
import { VfsEventFormatter } from './VfsEventFormatter';

describe('VfsEventFormatter', () => {
  it('1 件: パスを引用符で出す（保存・削除）', () => {
    expect(VfsEventFormatter.format({ actor: 'App [notes]', action: 'edit', items: [{ srcPath: 'data/a.md' }] })).toBe(
      'App [notes] saved edits to "data/a.md"',
    );
    expect(
      VfsEventFormatter.format({ actor: 'App [notes]', action: 'delete', items: [{ srcPath: 'data/a.md' }] }),
    ).toBe('App [notes] deleted "data/a.md"');
  });

  it('改名・戻す（1 件・行き先つき）: 元 -> 先', () => {
    expect(
      VfsEventFormatter.format({
        actor: 'User',
        action: 'move',
        items: [{ srcPath: 'data/a.md', destPath: 'data/b.md' }],
      }),
    ).toBe('User moved "data/a.md" -> "data/b.md"');
    expect(
      VfsEventFormatter.format({
        actor: 'App [files]',
        action: 'move',
        items: [{ srcPath: 'trash/1_a.md', destPath: 'data/a.md' }],
      }),
    ).toBe('App [files] moved "trash/1_a.md" -> "data/a.md"');
  });

  it('元と先が同じなら、パスを 1 つだけ出す', () => {
    expect(
      VfsEventFormatter.format({
        actor: 'User',
        action: 'copy',
        items: [{ srcPath: 'data/a.md', destPath: 'data/a.md' }],
      }),
    ).toBe('User copied "data/a.md"');
  });

  it('行き先のフォルダが在る 1 件: 名前と行き先', () => {
    expect(
      VfsEventFormatter.format({
        actor: 'User',
        action: 'copy',
        items: [{ srcPath: 'data/src/a.md', destPath: 'data/dst/a.md' }],
        targetDir: 'data/dst',
      }),
    ).toBe('User copied "a.md" to "data/dst"');
    expect(
      VfsEventFormatter.format({
        actor: 'User',
        action: 'upload',
        items: [{ srcPath: 'data/in/a.png' }],
        targetDir: 'data/in',
      }),
    ).toBe('User uploaded "a.png" to "data/in"');
  });

  it('行き先が空（最上位）なら、行き先を書かずにパスを出す', () => {
    expect(
      VfsEventFormatter.format({ actor: 'User', action: 'upload', items: [{ srcPath: 'a.png' }], targetDir: '' }),
    ).toBe('User uploaded "a.png"');
  });

  it('複数（3 件まで）: 件数と名前を全部', () => {
    expect(
      VfsEventFormatter.format({
        actor: 'User',
        action: 'delete',
        items: [{ srcPath: 'data/a.md' }, { srcPath: 'data/b.md' }, { srcPath: 'data/x/c.md' }],
      }),
    ).toBe('User deleted 3 items ("a.md", "b.md", "c.md")');
    expect(
      VfsEventFormatter.format({
        actor: 'User',
        action: 'move',
        items: [
          { srcPath: 'data/a.md', destPath: 'data/z/a.md' },
          { srcPath: 'data/b.md', destPath: 'data/z/b.md' },
        ],
        targetDir: 'data/z',
      }),
    ).toBe('User moved 2 items ("a.md", "b.md") to "data/z"');
  });

  it('4 件以上: 最初の 3 つと、残りの数', () => {
    const items = ['a', 'b', 'c', 'd', 'e'].map((n) => ({ srcPath: `data/in/${n}.md` }));
    expect(VfsEventFormatter.format({ actor: 'User', action: 'upload', items, targetDir: 'data/in' })).toBe(
      'User uploaded 5 items ("a.md", "b.md", "c.md" and 2 more) to "data/in"',
    );
    expect(VfsEventFormatter.format({ actor: 'User', action: 'delete', items: items.slice(0, 4) })).toBe(
      'User deleted 4 items ("a.md", "b.md", "c.md" and 1 more)',
    );
  });

  it('複数で、行き先のフォルダが無い（ゴミ箱から戻す）: 項目ごとに 元 -> 先（T-0923）', () => {
    expect(
      VfsEventFormatter.format({
        actor: 'User',
        action: 'move',
        items: [
          { srcPath: 'trash/1_a.md', destPath: 'data/a.md' },
          { srcPath: 'trash/2_b.md', destPath: 'docs/b.md' },
        ],
      }),
    ).toBe('User moved 2 items ("trash/1_a.md" -> "data/a.md", "trash/2_b.md" -> "docs/b.md")');
    const items = [1, 2, 3, 4].map((n) => ({ srcPath: `trash/${n}_f${n}.md`, destPath: `data/f${n}.md` }));
    expect(VfsEventFormatter.format({ actor: 'User', action: 'move', items })).toBe(
      'User moved 4 items ("trash/1_f1.md" -> "data/f1.md", "trash/2_f2.md" -> "data/f2.md", "trash/3_f3.md" -> "data/f3.md" and 1 more)',
    );
  });

  it('複数で、先が元と同じ項目は名前だけ（行き先のフォルダが無いとき）', () => {
    expect(
      VfsEventFormatter.format({
        actor: 'User',
        action: 'copy',
        items: [
          { srcPath: 'data/a.md', destPath: 'data/a.md' },
          { srcPath: 'data/b.md', destPath: 'data/c.md' },
        ],
      }),
    ).toBe('User copied 2 items ("a.md", "data/b.md" -> "data/c.md")');
  });

  it('name が在れば名前に使う・項目が無ければ空', () => {
    expect(
      VfsEventFormatter.format({
        actor: 'User',
        action: 'create',
        items: [{ srcPath: 'data/a', name: 'A' }],
        targetDir: 'data',
      }),
    ).toBe('User created "A" to "data"');
    expect(VfsEventFormatter.format({ actor: 'User', action: 'delete', items: [] })).toBe('');
  });
});
