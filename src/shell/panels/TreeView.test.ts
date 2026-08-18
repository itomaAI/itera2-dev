// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { TreeView } from './TreeView';

/**
 * src/shell/panels/TreeView.test.ts
 * 仮想ディレクトリ（同期プロバイダの管轄）の見分け（T-0005）
 *
 * 背景:
 *   VFS の中だけに在るディレクトリと、同期プロバイダがマウントしている領域が
 *   同じ 📁 で並んでおり、見分けが付かなかった。
 *
 * 最初の実装は「プロバイダの管轄下すべて」に印を付けたが、**実物で破綻した**。
 * Google ドライブ同期は VFS 全体（ルート）をマウントしうるため、
 * その構成では全ディレクトリが該当し、印としての情報量がゼロになる。
 *   → 印を出すのは「管轄が**切り替わる境界**から先」だけにする（判定は VfsService 側）。
 *   → 見た目は名前の隣ではなく**アイコンの隅のバッジ**にする（行が横に伸びないため）。
 *
 * 守りたいのは「印が出ること」よりも **印が消えないこと** である。
 * アイコンの決定はもともと初期描画・差分更新・開閉トグルの3経路に重複していた。
 * したがって観測点は、描いた直後だけでなく **操作した後** に置く。
 */

const CLOUD = '☁️';

const meta = () => ({ size: 0, createdAt: 0, updatedAt: 0, version: 1, flags: {}, acl: {} });

function dir(name: string, path: string, extra: Record<string, unknown> = {}): any {
  return { id: path.replace(/\//g, '_'), name, path, kind: 'directory', meta: meta(), children: [], ...extra };
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

/** アイコン欄の絵文字（バッジを除いた本体） */
function iconOf(path: string): string {
  const span = row(path).querySelector('span:first-child') as HTMLElement;
  const badge = span.querySelector('span');
  const badgeText = badge ? badge.textContent || '' : '';
  return (span.textContent || '').replace(badgeText, '').trim();
}

/** アイコン欄に重ねたバッジの数 */
function badgeCount(path: string): number {
  const span = row(path).querySelector('span:first-child') as HTMLElement;
  return Array.from(span.querySelectorAll('span')).filter((s) => (s.textContent || '').includes(CLOUD)).length;
}

/** 行全体に現れる雲の総数（名前の隣に出ていないことの確認に使う） */
const cloudTotal = (path: string) => (row(path).innerHTML.match(/☁️/g) || []).length;

describe('TreeView: 仮想ディレクトリの見分け', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('通常のディレクトリには印を付けない（陰性対照）', () => {
    const { view } = makeView();
    view.render([dir('data', 'data')]);

    expect(iconOf('data')).toBe('📁');
    expect(cloudTotal('data')).toBe(0);
  });

  it('マウント地点は、開閉が分かる形のままバッジが付く', () => {
    const { view } = makeView();
    view.render([dir('ws_itera', 'local/yachiyo/ws_itera', { isMountPoint: true, isVirtual: true })]);

    // アイコンを雲に置き換えない。開いているか閉じているかは常に見えるべき。
    expect(iconOf('local/yachiyo/ws_itera')).toBe('📁');
    expect(badgeCount('local/yachiyo/ws_itera')).toBe(1);
  });

  it('マウント配下のディレクトリにもバッジが付く', () => {
    const { view } = makeView();
    view.render([dir('src', 'local/yachiyo/ws_itera/src', { isVirtual: true })]);

    expect(iconOf('local/yachiyo/ws_itera/src')).toBe('📁');
    expect(badgeCount('local/yachiyo/ws_itera/src')).toBe(1);
  });

  it('印はアイコンの隅だけに出る（名前の隣には出さない）', () => {
    const { view } = makeView();
    view.render([dir('src', 'local/yachiyo/ws_itera/src', { isVirtual: true })]);

    // 行全体の雲が1個 ＝ アイコンのバッジのみ。名前の隣にも出ていれば2個になる。
    expect(cloudTotal('local/yachiyo/ws_itera/src')).toBe(1);
  });

  it('開いても印が消えない（トグル経路）', () => {
    const { view } = makeView();
    view.render([dir('src', 'local/yachiyo/ws_itera/src', { isVirtual: true })]);

    row('local/yachiyo/ws_itera/src').dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // textContent で書き換えるとバッジごと消える。要素を差し替えているか。
    expect(iconOf('local/yachiyo/ws_itera/src')).toBe('📂');
    expect(badgeCount('local/yachiyo/ws_itera/src')).toBe(1);
  });

  it('配下が同期されて差分更新が来ても、親の印が消えない（差分更新経路）', () => {
    const { view } = makeView();
    view.render([dir('src', 'local/yachiyo/ws_itera/src', { isVirtual: true })]);

    view.applyMutations(
      [
        {
          type: 'MUTATE',
          nodeId: 'local_yachiyo_ws_itera_src',
          path: 'local/yachiyo/ws_itera/src',
          node: { id: 'local_yachiyo_ws_itera_src', name: 'src', kind: 'directory', meta: meta() },
        },
      ],
      () => [],
    );

    expect(iconOf('local/yachiyo/ws_itera/src')).toBe('📁');
    expect(badgeCount('local/yachiyo/ws_itera/src')).toBe(1);
  });

  it('マウントの登録・解除は全再描画で拾う', () => {
    const { view } = makeView();
    view.render([dir('ws_itera', 'local/yachiyo/ws_itera')]);

    let rebuilt = 0;
    const getTree = () => {
      rebuilt++;
      return [dir('ws_itera', 'local/yachiyo/ws_itera', { isMountPoint: true, isVirtual: true })];
    };

    view.applyMutations(
      [
        {
          type: 'MUTATE',
          nodeId: 'dummy_mount',
          path: 'local/yachiyo/ws_itera',
          node: null,
          changedProperties: ['isMountPoint'],
        },
      ],
      getTree,
    );

    expect(rebuilt).toBe(1);
    expect(badgeCount('local/yachiyo/ws_itera')).toBe(1);
  });

  it('ファイルにはバッジを付けない（スタブの ☁️ とは別の話）', () => {
    const { view } = makeView();
    view.render([
      {
        id: 'f1',
        name: 'main.ts',
        path: 'local/yachiyo/ws_itera/main.ts',
        kind: 'file',
        meta: meta(),
        isVirtual: true,
      } as any,
    ]);

    expect(badgeCount('local/yachiyo/ws_itera/main.ts')).toBe(0);
  });
});
