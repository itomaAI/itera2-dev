// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach, type Mock } from 'vitest';
import { TreeView } from './TreeView';

/**
 * src/shell/panels/TreeViewIncremental.test.ts
 * 差分更新が木の大きさに依らないこと（T-0544）
 *
 * 以前の差分更新は、1 件ごとに `document.querySelector('div[data-path="…"]')` で行を探し、
 * ディレクトリの ATTACH / DETACH のたびに VFS 全体の木を組んで描き直していた。
 * 木は閉じたフォルダの中身まで DOM に載せているので、どちらも写しの大きさに比例して重い
 * （実測: Firefox・行 22,552 で探索 1 回 約 7ms、描き直し 1 回 0.5〜0.7 秒）。
 * Local Bridge の同期は 1 件ずつ変化を出すので、ホストで 1,000 件消すと画面が 7 秒以上止まった。
 *
 * ここで守るのは 3 つ:
 *   1. 行は索引で引く（document を走査しない。相手の木の行も掴まない）
 *   2. 全体の描き直しは、本当に要るとき（ディレクトリの移動・改名、マウントの登録・解除）だけ
 *   3. 差分で当てた結果が、描き直した結果と同じ見た目・並びになる
 */

const meta = () => ({ size: 0, createdAt: 0, updatedAt: 0, version: 1 });
const idOf = (path: string) => path.replace(/\//g, '_');

function dir(name: string, path: string, children: any[] = []): any {
  return { id: idOf(path), name, path, kind: 'directory', meta: meta(), children };
}
function file(name: string, path: string): any {
  return { id: idOf(path), name, path, kind: 'file', meta: meta() };
}
function node(n: any, parentPath: string | null) {
  return {
    id: n.id,
    name: n.name,
    kind: n.kind,
    meta: n.meta,
    flags: {},
    parentId: parentPath ? idOf(parentPath) : null,
  };
}
const attach = (n: any, parentPath: string | null) => ({
  type: 'ATTACH',
  nodeId: n.id,
  path: n.path,
  node: node(n, parentPath),
});
const detach = (path: string) => ({ type: 'DETACH', nodeId: idOf(path), path, node: null });

function mount(html = '<div id="tree"></div>') {
  document.body.innerHTML = html;
  const container = document.getElementById('tree') as HTMLElement;
  return { view: new TreeView(container, null), container };
}

/** 画面に出ている行を、木の順（深さ優先）でパスの列にする */
function rowsOf(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('div[data-path]')).map((d) => (d as HTMLElement).dataset.path!);
}

function base() {
  return [
    dir('data', 'data', [
      dir('a', 'data/a', [file('x.txt', 'data/a/x.txt'), file('y.txt', 'data/a/y.txt')]),
      dir('b', 'data/b'),
      file('m.md', 'data/m.md'),
    ]),
  ];
}

describe('TreeView: 差分更新（T-0544）', () => {
  let getTree: Mock<() => any[]>;
  beforeEach(() => {
    document.body.innerHTML = '';
    getTree = vi.fn<() => any[]>(() => base());
  });
  afterEach(() => vi.restoreAllMocks());

  it('ディレクトリを消しても全体を描き直さない。配下の行も一緒に消える（本命）', () => {
    const { view, container } = mount();
    view.render(base());
    view.applyMutations([detach('data/a/x.txt'), detach('data/a/y.txt'), detach('data/a')], getTree);
    expect(getTree).not.toHaveBeenCalled();
    expect(rowsOf(container)).toEqual(['data', 'data/b', 'data/m.md']);
  });

  it('新しいディレクトリは全体を描き直さずに足す。同じ束でも次の束でも、その中へ足せる', () => {
    const { view, container } = mount();
    view.render(base());
    const c = dir('c', 'data/c');
    view.applyMutations([attach(c, 'data'), attach(file('p.txt', 'data/c/p.txt'), 'data/c')], getTree);
    view.applyMutations([attach(file('q.txt', 'data/c/q.txt'), 'data/c')], getTree);
    expect(getTree).not.toHaveBeenCalled();
    expect(rowsOf(container)).toEqual([
      'data',
      'data/a',
      'data/a/x.txt',
      'data/a/y.txt',
      'data/b',
      'data/c',
      'data/c/p.txt',
      'data/c/q.txt',
      'data/m.md',
    ]);
    // 字下げも描き直したときと同じ（親の 1 段下）
    const q = container.querySelector('div[data-path="data/c/q.txt"]') as HTMLElement;
    expect(q.style.paddingLeft).toBe('32px');
  });

  it('ディレクトリの移動・改名（同じ id の DETACH と ATTACH）は 1 回だけ全体を描き直す', () => {
    const { view } = mount();
    view.render(base());
    const moved = { ...dir('a2', 'data/b/a2'), id: idOf('data/a') };
    view.applyMutations(
      [
        { type: 'DETACH', nodeId: moved.id, path: 'data/a', node: null },
        { type: 'ATTACH', nodeId: moved.id, path: 'data/b/a2', node: node(moved, 'data/b') },
      ],
      getTree,
    );
    expect(getTree).toHaveBeenCalledTimes(1);
  });

  it('ファイルの移動は差分で当てる（描き直さない）', () => {
    const { view, container } = mount();
    view.render(base());
    const moved = { ...file('x.txt', 'data/b/x.txt'), id: idOf('data/a/x.txt') };
    view.applyMutations(
      [
        { type: 'DETACH', nodeId: moved.id, path: 'data/a/x.txt', node: null },
        { type: 'ATTACH', nodeId: moved.id, path: 'data/b/x.txt', node: node(moved, 'data/b') },
      ],
      getTree,
    );
    expect(getTree).not.toHaveBeenCalled();
    expect(rowsOf(container)).toEqual(['data', 'data/a', 'data/a/y.txt', 'data/b', 'data/b/x.txt', 'data/m.md']);
  });

  it('足した行は並びの位置に入る（ディレクトリが先・名前順）。描き直した結果と同じ', () => {
    const { view, container } = mount();
    view.render(base());
    view.applyMutations(
      [
        attach(file('a.md', 'data/a.md'), 'data'),
        attach(file('z.md', 'data/z.md'), 'data'),
        attach(dir('aa', 'data/aa'), 'data'),
        attach(file('n.md', 'data/n.md'), 'data'),
      ],
      getTree,
    );
    const incremental = rowsOf(container);

    const again = mount('<div id="tree"></div>');
    const full = base();
    full[0].children.push(
      file('a.md', 'data/a.md'),
      file('z.md', 'data/z.md'),
      dir('aa', 'data/aa'),
      file('n.md', 'data/n.md'),
    );
    again.view.render(full);
    expect(incremental).toEqual(rowsOf(again.container));
  });

  it('行を document から探さない（木の大きさに比例する走査をしない）', () => {
    const { view } = mount();
    view.render(base());
    const qs = vi.spyOn(Document.prototype, 'querySelector');
    const byId = vi.spyOn(Document.prototype, 'getElementById');
    const muts: any[] = [];
    for (let i = 0; i < 50; i++) muts.push(attach(file(`f${i}.txt`, `data/b/f${i}.txt`), 'data/b'));
    view.applyMutations(muts, getTree);
    view.applyMutations(
      muts.map((m) => detach(m.path)),
      getTree,
    );
    view.applyMutations(
      [
        {
          type: 'MUTATE',
          nodeId: idOf('data/m.md'),
          path: 'data/m.md',
          node: node(file('m.md', 'data/m.md'), 'data'),
          changedProperties: ['size'],
        },
      ],
      getTree,
    );
    expect(qs).not.toHaveBeenCalled();
    expect(byId).not.toHaveBeenCalled();
  });

  it('同じ文書に木が 2 つあっても、相手の木の行を掴まない（エクスプローラとファイル選択）', () => {
    document.body.innerHTML = '<div id="t1"></div><div id="t2"></div>';
    const v1 = new TreeView(document.getElementById('t1') as HTMLElement, null);
    const v2 = new TreeView(document.getElementById('t2') as HTMLElement, null);
    v1.render(base());
    v2.render(base());
    v2.applyMutations([attach(file('only2.txt', 'data/b/only2.txt'), 'data/b'), detach('data/m.md')], getTree);
    const t1 = document.getElementById('t1') as HTMLElement;
    const t2 = document.getElementById('t2') as HTMLElement;
    expect(rowsOf(t1)).toEqual(['data', 'data/a', 'data/a/x.txt', 'data/a/y.txt', 'data/b', 'data/m.md']);
    expect(rowsOf(t2)).toEqual(['data', 'data/a', 'data/a/x.txt', 'data/a/y.txt', 'data/b', 'data/b/only2.txt']);
  });

  it('描き直したあとは新しい行を引く（索引が古い行を指したままにならない）', () => {
    const { view, container } = mount();
    view.render(base());
    view.render(base());
    view.applyMutations([attach(file('late.txt', 'data/a/late.txt'), 'data/a')], getTree);
    expect(rowsOf(container)).toContain('data/a/late.txt');
    expect(container.querySelectorAll('div[data-path="data/a/late.txt"]').length).toBe(1);
  });

  it('消したディレクトリと同じ id が後で戻ってきても、古い行の写しに足さない', () => {
    const { view, container } = mount();
    view.render(base());
    view.applyMutations([detach('data/a')], getTree);
    // 親の行が無いので、子の ATTACH は何もしない（以前と同じ振る舞い）
    view.applyMutations([attach(file('z.txt', 'data/a/z.txt'), 'data/a')], getTree);
    expect(rowsOf(container)).toEqual(['data', 'data/b', 'data/m.md']);
  });
});
