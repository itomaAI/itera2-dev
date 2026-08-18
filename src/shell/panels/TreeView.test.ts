// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { TreeView } from './TreeView';

/**
 * src/shell/panels/TreeView.test.ts
 * 仮想ディレクトリ（Sync Provider の管轄下）の見分け（T-0005）
 *
 * 背景:
 *   VFS の中だけに在るディレクトリと、同期プロバイダがマウントしている領域の
 *   ディレクトリが同じ 📁 で並んでおり、見分けが付かなかった。
 *
 * 守りたいのは「印が出ること」よりも **印が消えないこと** である。
 *   アイコンの決定はもともと初期描画・差分更新・開閉トグルの3経路に
 *   重複して書かれていた。印を1経路にだけ足すと、
 *   「開いた瞬間に消える」「配下のファイルが同期されると消える」形で崩れる。
 *   したがって観測点は、描いた直後だけでなく **操作した後** に置く。
 */

const CLOUD = '☁️';

const meta = () => ({
  size: 0,
  createdAt: 0,
  updatedAt: 0,
  version: 1,
  flags: {},
  acl: {},
});

function dir(name: string, path: string, extra: Record<string, unknown> = {}): any {
  return { id: path.replace(/\//g, '_'), name, path, kind: 'directory', meta: meta(), children: [], ...extra };
}

function makeView() {
  document.body.innerHTML = '<div id="tree"></div>';
  const container = document.getElementById('tree') as HTMLElement;
  return { view: new TreeView(container, null), container };
}

/** 行（div.tree-content）を path で引く */
function row(path: string): HTMLElement {
  const el = document.querySelector(`div[data-path="${path}"]`);
  if (!el) throw new Error(`row not found: ${path}`);
  return el as HTMLElement;
}

const iconOf = (path: string) => (row(path).querySelector('span:first-child') as HTMLElement).textContent?.trim();
const cloudCount = (path: string) => (row(path).innerHTML.match(/☁️/g) || []).length;

describe('TreeView: 仮想ディレクトリの見分け', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('通常のディレクトリには印を付けない（陰性対照）', () => {
    const { view } = makeView();
    view.render([dir('data', 'data')]);

    expect(iconOf('data')).toBe('📁');
    expect(cloudCount('data')).toBe(0);
  });

  it('マウント地点はフォルダではなく雲を出す', () => {
    const { view } = makeView();
    view.render([dir('drive', 'drive', { isMountPoint: true, isVirtual: true })]);

    expect(iconOf('drive')).toBe(CLOUD);
    // アイコンが既に雲なので、名前の隣にもう一度付けない
    expect(cloudCount('drive')).toBe(1);
  });

  it('マウント配下のディレクトリは、フォルダのまま印だけが付く', () => {
    const { view } = makeView();
    view.render([dir('projects', 'drive/projects', { isVirtual: true })]);

    // 開閉の手掛かり（📁/📂）は木を読む上で最も重要なので潰さない
    expect(iconOf('drive/projects')).toBe('📁');
    expect(cloudCount('drive/projects')).toBe(1);
  });

  it('開いても印が消えない（トグル経路）', () => {
    const { view } = makeView();
    view.render([dir('projects', 'drive/projects', { isVirtual: true })]);

    row('drive/projects').dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(iconOf('drive/projects')).toBe('📂');
    expect(cloudCount('drive/projects')).toBe(1);
  });

  it('マウント地点を開いても雲のままである（トグル経路）', () => {
    const { view } = makeView();
    view.render([dir('drive', 'drive', { isMountPoint: true, isVirtual: true })]);

    row('drive').dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // ここが 📂 になると、開いている間だけマウント地点が普通のフォルダに化ける
    expect(iconOf('drive')).toBe(CLOUD);
  });

  it('配下が同期されて差分更新が来ても、親の印が消えない（差分更新経路）', () => {
    const { view } = makeView();
    view.render([dir('projects', 'drive/projects', { isVirtual: true })]);

    // 同期デーモンの書き込みで親ディレクトリの meta が更新された、という状況。
    // 差分更新の入力（VfsNode）には isVirtual が入っていないため、
    // DOM から引き継がないとここで印が落ちる。
    view.applyMutations(
      [
        {
          type: 'MUTATE',
          nodeId: 'drive_projects',
          path: 'drive/projects',
          node: { id: 'drive_projects', name: 'projects', kind: 'directory', meta: meta() },
        },
      ],
      () => [],
    );

    expect(iconOf('drive/projects')).toBe('📁');
    expect(cloudCount('drive/projects')).toBe(1);
  });

  it('マウントの登録・解除は全再描画で拾う', () => {
    const { view } = makeView();
    view.render([dir('local', 'local')]);

    let rebuilt = 0;
    const getTree = () => {
      rebuilt++;
      return [dir('local', 'local', { isMountPoint: true, isVirtual: true })];
    };

    // ProviderManager が出すダミー MUTATE（node は null）。
    // これを拾わないと、マウントしても再読込するまで印が変わらない。
    view.applyMutations(
      [
        {
          type: 'MUTATE',
          nodeId: 'dummy_mount',
          path: 'local',
          node: null,
          changedProperties: ['isMountPoint'],
        },
      ],
      getTree,
    );

    expect(rebuilt).toBe(1);
    expect(iconOf('local')).toBe(CLOUD);
  });
});
