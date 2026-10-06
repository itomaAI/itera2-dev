/**
 * @vitest-environment jsdom
 * declareRoute（T-0619）: 申告は呼び出し元の app にだけ当たる。前面なら場所（履歴）を更新し、背面なら記録だけ。
 */
import { describe, expect, it } from 'vitest';
import { ProcessManager } from './ProcessManager';

function mk() {
  const pm = new ProcessManager({} as any, {} as any, {} as any);
  const proc = (
    pid: string,
    path: string,
    state: 'foreground' | 'background' | 'running',
    type: 'app' | 'daemon' = 'app',
  ) =>
    ({
      pid,
      path,
      type,
      state,
      iframe: null as any,
      blobUrls: [],
      lastActiveTime: 0,
      currentUri: `metaos://run/${path}`,
    }) as any;
  pm.processes.set('home', proc('home', 'system/apps/home.html', 'foreground'));
  pm.processes.set('explorer', proc('explorer', 'system/apps/explorer.html', 'background'));
  pm.processes.set('d', proc('d', 'system/services/d.html', 'running', 'daemon'));
  pm.setCurrentRoute({ pid: 'home', uri: 'metaos://run/system/apps/home.html' });
  const routes: any[] = [];
  pm.on('current_route_changed', (r: any) => routes.push(r));
  return { pm, routes };
}

describe('ProcessManager.declareRoute (T-0619)', () => {
  it('背面の app の申告は、その app の記録だけ更新し、前面の path も場所も変えない', () => {
    const { pm, routes } = mk();
    const uri = pm.declareRoute('?path=agent', 'explorer');
    expect(uri).toBe('metaos://run/system/apps/explorer.html?path=agent');
    expect(pm.processes.get('explorer')!.path).toBe('system/apps/explorer.html?path=agent');
    expect(pm.processes.get('home')!.path).toBe('system/apps/home.html');
    expect(pm.currentRoute).toEqual({ pid: 'home', uri: 'metaos://run/system/apps/home.html' });
    expect(routes).toEqual([]);
  });

  it('前面の app の申告は場所を更新する（履歴が購読する）', () => {
    const { pm, routes } = mk();
    pm.declareRoute('?view=list', 'home');
    expect(pm.processes.get('home')!.path).toBe('system/apps/home.html?view=list');
    expect(pm.currentRoute).toEqual({ pid: 'home', uri: 'metaos://run/system/apps/home.html?view=list' });
    expect(routes.length).toBe(1);
  });

  it('daemon や無い pid の申告は null', () => {
    const { pm } = mk();
    expect(pm.declareRoute('?x=1', 'd')).toBeNull();
    expect(pm.declareRoute('?x=1', 'nope')).toBeNull();
    expect(pm.processes.get('home')!.path).toBe('system/apps/home.html');
  });

  it('pid を省けば前面の app（シェル内部からの呼び出し）', () => {
    const { pm } = mk();
    expect(pm.declareRoute('?x=1')).toBe('metaos://run/system/apps/home.html?x=1');
  });
});
