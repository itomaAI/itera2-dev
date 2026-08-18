// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { TreeView } from './TreeView';

/**
 * src/shell/panels/TreeView.test.ts
 * 同期の印（T-0005）
 *
 * 設計（2026-08-18 山内さん判断）。印の役割を2つに分けている:
 *
 *   ☁️（名前の右） … このファイル／フォルダは**同期対象**である
 *   文字の薄さ      … 中身がまだ手元に無い（スタブ）
 *
 * したがって同期対象のファイルは、実体化されていても ☁️ を出し続ける。
 * ディレクトリとファイルで位置も意味も揃えた（以前はディレクトリだけアイコンの隅で、
 * ファイルの ☁️ は「スタブ」を意味しており、同じ絵文字が別の意味を持っていた）。
 *
 * ☁️ を出すのは「ルート以外のプロバイダが管轄する領域」だけである。
 * ルート同期（VFS 全体）まで含めると全件に付き、印としての情報量がゼロになる
 * （実際にそうなって作り直した）。
 *
 * 守りたいのは「印が出ること」よりも **印が消えないこと** なので、
 * 観測点は描いた直後だけでなく **操作した後** にも置く。
 */

const meta = (extra: Record<string, unknown> = {}) => ({
  size: 0,
  createdAt: 0,
  updatedAt: 0,
  version: 1,
  flags: {},
  acl: {},
  ...extra,
});

function dir(name: string, path: string, extra: Record<string, unknown> = {}): any {
  return { id: path.replace(/\//g, '_'), name, path, kind: 'directory', meta: meta(), children: [], ...extra };
}

function file(name: string, path: string, extra: Record<string, unknown> = {}): any {
  const { stub, ...rest } = extra as any;
  return {
    id: path.replace(/\//g, '_'),
    name,
    path,
    kind: 'file',
    meta: meta(stub ? { syncState: 'stub' } : {}),
    ...rest,
  };
}

function makeView() {
  document.body.innerHTML = '<div id="tree"></div>';
  const container = document.getElementById('tree') as HTMLElement;
  return { view: new TreeView(container, null), container };
}

function row(path: string): HTMLElement {
  const el = document.querySelector(`div[data-path="${path}"]`);
  if (!el) throw new Error(`row not found: ${path}`);
  return el as HTMLElement;
}

/** アイコン欄の絵文字 */
const iconOf = (path: string) => (row(path).querySelector('span:first-child') as HTMLElement).textContent?.trim();

/** 名前を描いている span */
const nameSpan = (path: string) => row(path).querySelectorAll('span')[1] as HTMLElement;

/** 名前の右に出ている雲の数 */
const cloudCount = (path: string) => (nameSpan(path).innerHTML.match(/☁️/g) || []).length;

/** 中身が手元に無いことを薄さで示しているか */
const isMuted = (path: string) => nameSpan(path).className.includes('text-text-muted');

const MOUNT = 'local/yachiyo/ws_itera';

describe('TreeView: 同期の印', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('同期対象でないディレクトリには何も付けない（陰性対照）', () => {
    const { view } = makeView();
    view.render([dir('data', 'data')]);

    expect(iconOf('data')).toBe('📁');
    expect(cloudCount('data')).toBe(0);
  });

  it('マウント地点も配下も、フォルダの形のまま名前の右に雲が付く', () => {
    const { view } = makeView();
    view.render([
      dir('ws_itera', MOUNT, { isMountPoint: true, isVirtual: true }),
      dir('src', `${MOUNT}/src`, { isVirtual: true }),
    ]);

    // 開閉（📂/📁）は木を読むうえで最も重要な手掛かりなので潰さない
    expect(iconOf(MOUNT)).toBe('📁');
    expect(cloudCount(MOUNT)).toBe(1);
    expect(iconOf(`${MOUNT}/src`)).toBe('📁');
    expect(cloudCount(`${MOUNT}/src`)).toBe(1);
  });

  it('同期対象のファイルは、実体化されていても雲を出し続ける（本命 / 今回の変更点）', () => {
    const { view } = makeView();
    view.render([file('main.ts', `${MOUNT}/main.ts`, { isVirtual: true })]);

    // 以前は「スタブのときだけ」出していた。いまは同期対象であることを示す印である。
    expect(cloudCount(`${MOUNT}/main.ts`)).toBe(1);
    expect(isMuted(`${MOUNT}/main.ts`)).toBe(false);
  });

  it('スタブは薄さで示す。雲は同期対象であることのみを示す', () => {
    const { view } = makeView();
    view.render([file('big.bin', `${MOUNT}/big.bin`, { isVirtual: true, stub: true })]);

    expect(cloudCount(`${MOUNT}/big.bin`)).toBe(1);
    expect(isMuted(`${MOUNT}/big.bin`)).toBe(true);
  });

  it('ルート同期のスタブには雲を付けない。薄さだけで示す（設計上の帰結・承認済み）', () => {
    // Google ドライブがルート（VFS 全体）を同期している場合、
    // その配下は isVirtual を立てない（全件に印が付いて無意味になるため）。
    // したがって『中身がまだ無い』ことは薄さのみが担う。
    const { view } = makeView();
    view.render([file('notes.md', 'data/notes.md', { stub: true })]);

    expect(cloudCount('data/notes.md')).toBe(0);
    expect(isMuted('data/notes.md')).toBe(true);
  });

  it('開いても印が消えない（トグル経路）', () => {
    const { view } = makeView();
    view.render([dir('src', `${MOUNT}/src`, { isVirtual: true })]);

    row(`${MOUNT}/src`).dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(iconOf(`${MOUNT}/src`)).toBe('📂');
    expect(cloudCount(`${MOUNT}/src`)).toBe(1);
  });

  it('差分更新が来ても印が消えない（同期のたびに消えないこと）', () => {
    const { view } = makeView();
    view.render([file('main.ts', `${MOUNT}/main.ts`, { isVirtual: true, stub: true })]);

    // スタブが実体化された、という更新。雲は残り、薄さだけが消えるべき。
    view.applyMutations(
      [
        {
          type: 'MUTATE',
          nodeId: `${MOUNT}/main.ts`.replace(/\//g, '_'),
          path: `${MOUNT}/main.ts`,
          node: { id: `${MOUNT}/main.ts`.replace(/\//g, '_'), name: 'main.ts', kind: 'file', meta: meta() },
        },
      ],
      () => [],
    );

    expect(cloudCount(`${MOUNT}/main.ts`)).toBe(1);
    expect(isMuted(`${MOUNT}/main.ts`)).toBe(false);
  });

  it('マウントの登録・解除は全再描画で拾う', () => {
    const { view } = makeView();
    view.render([dir('ws_itera', MOUNT)]);

    let rebuilt = 0;
    const getTree = () => {
      rebuilt++;
      return [dir('ws_itera', MOUNT, { isMountPoint: true, isVirtual: true })];
    };

    view.applyMutations(
      [
        {
          type: 'MUTATE',
          nodeId: 'dummy_mount',
          path: MOUNT,
          node: null,
          changedProperties: ['isMountPoint'],
        },
      ],
      getTree,
    );

    expect(rebuilt).toBe(1);
    expect(cloudCount(MOUNT)).toBe(1);
  });
});
