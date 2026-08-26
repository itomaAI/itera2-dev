// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { TreeView } from './TreeView';

/**
 * TreeView.reveal（T-0251）
 *
 * 背景:
 *   ゲストや道具から「このディレクトリを見せる」経路が無かった。
 *   ディレクトリの受け皿はホストのエクスプローラパネル（解決器の HostExplorer）。
 *   reveal は祖先を開いて対象を選択するだけで、'open' も 'select' も出さない。
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
  tv.render([
    dir('data', 'data', [
      dir('apps', 'data/apps', [dir('loom', 'data/apps/loom', [file('a.md', 'data/apps/loom/a.md')])]),
    ]),
    file('b.md', 'b.md'),
  ]);
  return { tv, container };
}
const childrenOf = (c: HTMLElement, path: string) =>
  (c.querySelector(`div[data-path="${path}"]`) as HTMLElement).parentElement!.querySelector('ul')!;
const isSelected = (c: HTMLElement, path: string) =>
  (c.querySelector(`div[data-path="${path}"]`) as HTMLElement).classList.contains('border-primary');

describe('TreeView.reveal', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('祖先を全部開き、対象ディレクトリ自身も開いて選択する（本命）', () => {
    const { tv, container } = setup();
    expect(childrenOf(container, 'data').classList.contains('hidden')).toBe(true);

    expect(tv.reveal('data/apps/loom')).toBe(true);

    for (const p of ['data', 'data/apps', 'data/apps/loom']) {
      expect(childrenOf(container, p).classList.contains('hidden')).toBe(false);
    }
    expect(isSelected(container, 'data/apps/loom')).toBe(true);
    expect(isSelected(container, 'data')).toBe(false);
  });

  it('ファイルでも祖先を開いて選択する', () => {
    const { tv, container } = setup();
    expect(tv.reveal('data/apps/loom/a.md')).toBe(true);
    expect(childrenOf(container, 'data/apps/loom').classList.contains('hidden')).toBe(false);
    expect(isSelected(container, 'data/apps/loom/a.md')).toBe(true);
  });

  it("'open' と 'select' を発火しない（利用者の操作ではない）", () => {
    const { tv } = setup();
    const fired: string[] = [];
    tv.on('open', () => fired.push('open'));
    tv.on('select', () => fired.push('select'));
    tv.reveal('data/apps');
    expect(fired).toEqual([]);
  });

  it('木に無いパスは false を返し、何も変えない', () => {
    const { tv, container } = setup();
    expect(tv.reveal('nope/x')).toBe(false);
    expect(childrenOf(container, 'data').classList.contains('hidden')).toBe(true);
  });

  it('reveal のあとに開閉を続けても状態が食い違わない（expandedPaths を更新している）', () => {
    const { tv, container } = setup();
    tv.reveal('data/apps');
    // 開いた 'data' をクリック → 閉じる（expandedPaths が同期していなければ「開いたまま」になる）
    (container.querySelector('div[data-path="data"]') as HTMLElement).click();
    expect(childrenOf(container, 'data').classList.contains('hidden')).toBe(true);
  });
});
