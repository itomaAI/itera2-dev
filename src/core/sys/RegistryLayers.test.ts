import { describe, it, expect } from 'vitest';
import { AppRegistry } from './AppRegistry';
import { FileAssociationResolver } from './FileAssociationResolver';
import { VfsEventBus } from '../vfs/VfsEventBus';

/**
 * 登録簿の層（T-0427）。
 *
 * 配信の登録簿を毎回上書きできるようにするには、利用者が足したものを別の層に置くしかない。
 * そうでないと「新しいアプリが既存の環境へ永久に届かない」か「利用者の追加が毎回消える」の
 * どちらかになる。
 *
 * 🔴 アダプタ（adapters.json）はこの層に載せない。ホストの window へ import される＝
 * ホストの任意コード実行と等価で、しかも利用者の層は同期されるため。
 * ここでは「AppRegistry と FileAssociationResolver が層を持つ」ことだけを確かめる。
 */

function makeVfs(files: Record<string, string>) {
  return {
    files,
    exists: (_p: any, path: string) => path in files,
    readFile: async (_p: any, path: string) => files[path],
    writeFile: async (_p: any, path: string, content: string) => {
      files[path] = content;
    },
  } as any;
}

const SYS = 'system/registry';
const USR = 'user/registry';
const LAYERS = [SYS, USR];

describe('AppRegistry: 層', () => {
  it('利用者の層にしかない項目は足される', async () => {
    const files = {
      [`${SYS}/apps.json`]: JSON.stringify([
        { id: 'explorer', name: 'Explorer', icon: '📁', path: 'system/apps/explorer.html' },
      ]),
      [`${USR}/apps.json`]: JSON.stringify([{ id: 'mine', name: 'Mine', icon: '⭐', path: 'user/apps/mine.html' }]),
    };
    const reg = new AppRegistry(makeVfs(files), new VfsEventBus(), LAYERS);
    await reg.loadAll();

    expect(
      reg
        .getAllApps()
        .map((a) => a.id)
        .sort(),
    ).toEqual(['explorer', 'mine']);
  });

  it('同じ id は後の層が勝つ', async () => {
    const files = {
      [`${SYS}/services.json`]: JSON.stringify([
        { id: 'web_search_daemon', name: 'Web Search', path: 'system/services/web_search.html', autoStart: true },
      ]),
      [`${USR}/services.json`]: JSON.stringify([
        { id: 'web_search_daemon', name: 'Web Search', path: 'system/services/web_search.html', autoStart: false },
      ]),
    };
    const reg = new AppRegistry(makeVfs(files), new VfsEventBus(), LAYERS);
    await reg.loadAll();

    // 配信のデーモンを利用者が止められる（これができないと設定のしようがない）
    expect(reg.getService('web_search_daemon')?.autoStart).toBe(false);
  });

  it('後の層は持っている鍵だけ勝つ（autoStart だけ置けば、path は配信のまま）', async () => {
    const files = {
      [`${SYS}/services.json`]: JSON.stringify([
        { id: 'web_search_daemon', name: 'Web Search', path: 'system/services/web_search.html', autoStart: true },
      ]),
      [`${USR}/services.json`]: JSON.stringify([{ id: 'web_search_daemon', autoStart: false }]),
    };
    const reg = new AppRegistry(makeVfs(files), new VfsEventBus(), LAYERS);
    await reg.loadAll();

    const svc = reg.getService('web_search_daemon');
    expect(svc?.autoStart).toBe(false);
    expect(svc?.path).toBe('system/services/web_search.html'); // 写しを持たなくても壊れない
    expect(svc?.name).toBe('Web Search');
  });

  it('壊れている層は飛ばし、そこまでに積んだ内容は保つ', async () => {
    const files = {
      [`${SYS}/apps.json`]: JSON.stringify([
        { id: 'explorer', name: 'Explorer', icon: '📁', path: 'system/apps/explorer.html' },
      ]),
      [`${USR}/apps.json`]: '[ これは JSON ではない',
    };
    const reg = new AppRegistry(makeVfs(files), new VfsEventBus(), LAYERS);
    await reg.loadAll();

    expect(reg.getApp('explorer')).toBeTruthy();
  });

  it('id の無い項目は捨てる', async () => {
    const files = {
      [`${SYS}/apps.json`]: JSON.stringify([{ name: 'No Id', icon: '?', path: 'x.html' }]),
    };
    const reg = new AppRegistry(makeVfs(files), new VfsEventBus(), LAYERS);
    await reg.loadAll();

    expect(reg.getAllApps()).toHaveLength(0);
  });

  it('updateEntry: 書き先は最後の層・書くのは下の層との差分だけ', async () => {
    const files: Record<string, string> = {
      [`${SYS}/services.json`]: JSON.stringify([
        { id: 'web_search_daemon', name: 'Web Search', path: 'system/services/web_search.html', autoStart: true },
      ]),
    };
    const reg = new AppRegistry(makeVfs(files), new VfsEventBus(), LAYERS);
    await reg.loadAll();

    const updated = await reg.updateEntry('services', 'web_search_daemon', { autoStart: false });
    expect(updated?.autoStart).toBe(false);
    expect(updated?.path).toBe('system/services/web_search.html');

    // 配信の層には触らない
    expect(JSON.parse(files[`${SYS}/services.json`])[0].autoStart).toBe(true);
    // 利用者の層に書かれるのは差分だけ（path や name の写しを持たない）
    expect(JSON.parse(files[`${USR}/services.json`])).toEqual([{ id: 'web_search_daemon', autoStart: false }]);
    // 読み直した値も新しい
    expect(reg.getService('web_search_daemon')?.autoStart).toBe(false);
  });

  it('updateEntry: 下の層と同じ値に戻したら、利用者の層から項目が消える', async () => {
    const files: Record<string, string> = {
      [`${SYS}/services.json`]: JSON.stringify([
        { id: 'a', name: 'A', path: 'system/services/a.html', autoStart: true },
      ]),
      [`${USR}/services.json`]: JSON.stringify([
        { id: 'a', autoStart: false },
        { id: 'mine', name: 'Mine', path: 'user/services/mine.html', autoStart: true },
      ]),
    };
    const reg = new AppRegistry(makeVfs(files), new VfsEventBus(), LAYERS);
    await reg.loadAll();

    await reg.updateEntry('services', 'a', { autoStart: true });
    // 上書きしていない状態に戻る。利用者が足した別の項目はそのまま
    expect(JSON.parse(files[`${USR}/services.json`])).toEqual([
      { id: 'mine', name: 'Mine', path: 'user/services/mine.html', autoStart: true },
    ]);
    expect(reg.getService('a')?.autoStart).toBe(true);
  });

  it('updateEntry: 利用者にしかない項目は丸ごと書く。壊れた書き先は作り直す', async () => {
    const files: Record<string, string> = {
      [`${SYS}/apps.json`]: JSON.stringify([]),
      [`${USR}/apps.json`]: '{ 壊れている',
    };
    const reg = new AppRegistry(makeVfs(files), new VfsEventBus(), LAYERS);
    await reg.loadAll();

    await reg.updateEntry('apps', 'mine', { name: 'Mine', icon: '⭐', path: 'user/apps/mine.html' });
    expect(JSON.parse(files[`${USR}/apps.json`])).toEqual([
      { id: 'mine', name: 'Mine', icon: '⭐', path: 'user/apps/mine.html' },
    ]);
    expect(reg.getApp('mine')?.path).toBe('user/apps/mine.html');
  });

  it('updateEntry: 層が 1 つなら、その場所へ項目を丸ごと書く（これまでの設定アプリと同じ）', async () => {
    const files: Record<string, string> = {
      [`${SYS}/services.json`]: JSON.stringify([
        { id: 'a', name: 'A', path: 'system/services/a.html', autoStart: true },
        { id: 'b', name: 'B', path: 'system/services/b.html', autoStart: true },
      ]),
    };
    const reg = new AppRegistry(makeVfs(files), new VfsEventBus(), [SYS]);
    await reg.loadAll();

    await reg.updateEntry('services', 'a', { autoStart: false });
    expect(JSON.parse(files[`${SYS}/services.json`])).toEqual([
      { id: 'a', name: 'A', path: 'system/services/a.html', autoStart: false },
      { id: 'b', name: 'B', path: 'system/services/b.html', autoStart: true },
    ]);
    expect(USR + '/services.json' in files).toBe(false);
  });

  it('層が 1 つなら、これまでと同じ 1 か所だけを読む', async () => {
    const files = {
      [`${SYS}/apps.json`]: JSON.stringify([
        { id: 'explorer', name: 'Explorer', icon: '📁', path: 'system/apps/explorer.html' },
      ]),
      [`${USR}/apps.json`]: JSON.stringify([{ id: 'mine', name: 'Mine', icon: '⭐', path: 'user/apps/mine.html' }]),
    };
    const reg = new AppRegistry(makeVfs(files), new VfsEventBus(), [SYS]);
    await reg.loadAll();

    expect(reg.getAllApps().map((a) => a.id)).toEqual(['explorer']);
  });
});

describe('FileAssociationResolver: 層', () => {
  const registry = { getApp: () => undefined, getAllApps: () => [] } as any;

  it('拡張子ごとに後の層が勝ち、配信側の残りは保たれる', async () => {
    const files = {
      [`${SYS}/associations.json`]: JSON.stringify({ extensions: { md: 'notes', png: 'viewer' } }),
      [`${USR}/associations.json`]: JSON.stringify({ extensions: { md: 'mine' } }),
    };
    const far = new FileAssociationResolver(makeVfs(files), registry, new VfsEventBus(), LAYERS);
    await far.loadAssociations();

    const assoc = (far as any).associations;
    expect(assoc.extensions.md).toBe('mine'); // 利用者が変えた
    expect(assoc.extensions.png).toBe('viewer'); // 触っていないものは配信のまま
  });

  it('壊れている層は飛ばす', async () => {
    const files = {
      [`${SYS}/associations.json`]: JSON.stringify({ extensions: { md: 'notes' } }),
      [`${USR}/associations.json`]: '{ 壊れている',
    };
    const far = new FileAssociationResolver(makeVfs(files), registry, new VfsEventBus(), LAYERS);
    await far.loadAssociations();

    expect((far as any).associations.extensions.md).toBe('notes');
  });
});
