// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach, type Mock } from 'vitest';
import { TreeView } from './TreeView';

/**
 * src/shell/panels/TreeViewSortWeights.test.ts
 * あとから足した行も、並びの重みの位置に入ること（T-0922）
 *
 * 重み（nodeOrder.ts の DEFAULT_SORT_WEIGHTS と appearance.json の sortWeight）は、
 * 初めに描くとき（_buildInitialTree）と、差分で 1 行を差し込むとき（_insertSorted）の 2 か所で効く。
 * 差し込みの比較に重みを渡し忘れても、それまで落ちる試験が無かった。
 * 例: 起動したあとで初めて `trash` が出来ると、重みを見ない差し込みでは名前順の位置に入り、一番下に行かない。
 *
 * 🔴 差し込みは二分探索なので、兄弟が 2 行だと重みを見なくても偶然正しい位置に落ちることがある。
 * どの件も、重みを渡さない差し込みでは落ちる並べ方にしてある（行を足す順に意味がある）。
 */

const meta = () => ({ size: 0, createdAt: 0, updatedAt: 0, version: 1 });

function dir(name: string): any {
  return { id: `id_${name}`, name, path: name, kind: 'directory', meta: meta(), children: [] };
}
/** 最上位へ足す ATTACH（親は無い） */
const attachTop = (n: any) => ({
  type: 'ATTACH',
  nodeId: n.id,
  path: n.path,
  node: { id: n.id, name: n.name, kind: n.kind, meta: n.meta, flags: {}, parentId: null },
});

function mount() {
  document.body.innerHTML = '<div id="tree"></div>';
  const container = document.getElementById('tree') as HTMLElement;
  return { view: new TreeView(container, null), container };
}

/** 画面に出ている行を、上から順にパスの列にする */
function rowsOf(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('div[data-path]')).map((d) => (d as HTMLElement).dataset.path!);
}

describe('TreeView: あとから足した行と並びの重み（T-0922）', () => {
  let getTree: Mock<() => any[]>;
  beforeEach(() => {
    document.body.innerHTML = '';
    getTree = vi.fn<() => any[]>(() => []);
  });
  afterEach(() => vi.restoreAllMocks());

  it('既定の重み: あとから足した aaa は system より前、trash は一番下に入る', () => {
    const { view, container } = mount();
    view.render([dir('個人'), dir('system')]);
    expect(rowsOf(container)).toEqual(['個人', 'system']);

    view.applyMutations([attachTop(dir('aaa')), attachTop(dir('trash'))], getTree);

    expect(getTree).not.toHaveBeenCalled();
    expect(rowsOf(container)).toEqual(['aaa', '個人', 'system', 'trash']);
  });

  it('上書きした重み（appearance.json の sortWeight）も差し込みに効く', () => {
    const { view, container } = mount();
    view.setSortWeights({ 個人: 300 });
    view.render([dir('個人'), dir('system')]);
    expect(rowsOf(container)).toEqual(['system', '個人']);

    view.applyMutations([attachTop(dir('aaa')), attachTop(dir('trash')), attachTop(dir('メモ'))], getTree);

    expect(getTree).not.toHaveBeenCalled();
    expect(rowsOf(container)).toEqual(['aaa', 'メモ', 'system', 'trash', '個人']);
  });

  it('差し込んだ結果は、同じ行を初めから描いた結果と同じ並び', () => {
    const { view, container } = mount();
    view.render([dir('個人'), dir('system')]);
    view.applyMutations([attachTop(dir('aaa')), attachTop(dir('trash'))], getTree);
    const incremental = rowsOf(container);

    const again = mount();
    again.view.render([dir('個人'), dir('system'), dir('trash'), dir('aaa')]);
    expect(incremental).toEqual(rowsOf(again.container));
  });
});
