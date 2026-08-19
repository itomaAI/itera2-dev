// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { TreeView } from './TreeView';

/**
 * TreeView の 'select'（T-0017）
 *
 * 背景:
 *   ディレクトリのクリックは開閉するだけで 'open' を発火しない。
 *   そのため「どれが選ばれたか」を知りたい側（ファイル選択ダイアログ）は
 *   フォルダの選択を受け取る術が無かった。
 *
 *   'open' の意味は変えない。Explorer は 'open' でファイルを開くので、
 *   ここにディレクトリを混ぜると「フォルダを開こうとする」ことになる。
 */

const meta = () => ({ size: 0, createdAt: 0, updatedAt: 0, version: 1, flags: {}, acl: {} });
const dir = (name: string, path: string, children: any[] = []): any => ({
  id: path.replace(/\//g, '_'),
  name,
  path,
  kind: 'directory',
  meta: meta(),
  children,
});
const file = (name: string, path: string): any => ({
  id: path.replace(/\//g, '_'),
  name,
  path,
  kind: 'file',
  meta: meta(),
});

function setup() {
  document.body.innerHTML = '';
  const container = document.createElement('div');
  document.body.appendChild(container);
  const tv = new TreeView(container, null);
  tv.render([dir('docs', 'docs', [file('a.md', 'docs/a.md')]), file('b.md', 'b.md')]);
  return { tv, container };
}

const click = (container: HTMLElement, path: string) => {
  const el = container.querySelector(`[data-path="${path}"]`) as HTMLElement;
  if (!el) throw new Error(`ノードが見つからない: ${path}（TreeView の描画が変わった可能性）`);
  el.click();
};

describe("TreeView: 'select'", () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('ディレクトリのクリックでも発火する（本命 / これが無かった）', () => {
    const { tv, container } = setup();
    const got: Array<[string, string]> = [];
    tv.on('select', (p: string, k: string) => got.push([p, k]));

    click(container, 'docs');
    expect(got).toEqual([['docs', 'directory']]);
  });

  it('ファイルのクリックでも発火する（ダイアログはこれ一本で受けられる）', () => {
    const { tv, container } = setup();
    const got: Array<[string, string]> = [];
    tv.on('select', (p: string, k: string) => got.push([p, k]));

    click(container, 'b.md');
    expect(got).toEqual([['b.md', 'file']]);
  });

  it("'open' はファイルだけ。ディレクトリでは出さない（Explorer への影響を出さない）", () => {
    const { tv, container } = setup();
    const opened: string[] = [];
    tv.on('open', (p: string) => opened.push(p));

    click(container, 'docs');
    expect(opened).toEqual([]);

    click(container, 'b.md');
    expect(opened).toEqual(['b.md']);
  });
});
