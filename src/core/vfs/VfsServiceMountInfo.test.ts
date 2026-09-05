import { describe, it, expect } from 'vitest';
import { VfsService } from './VfsService';
import { ProviderManager } from './ProviderManager';
import { VfsEventBus } from './VfsEventBus';
import type { TreeNode } from './types';

/**
 * src/core/vfs/VfsServiceMountInfo.test.ts
 * getTree() が配る同期の印（isMountPoint / isVirtual）— T-0005
 *
 * ここが本命である。表示側（TreeView）は渡された印を描くだけなので、
 * 「どこに印を付けるか」の判断はすべてこの関数にある。
 *
 * 最初の実装は「プロバイダの管轄下すべて」に印を付け、実物で破綻した。
 * Google ドライブ同期が VFS 全体（mountPath === ''）をマウントしていたため、
 * **全ディレクトリが該当**して印の情報量がゼロになった。
 * 印が意味を持つのは、管轄が切り替わる境界から先だけである。
 */

function makePathResolver() {
  return {
    normalizePath: (p: string) => String(p || '').replace(/^\/+|\/+$/g, ''),
    buildTree: () => [] as TreeNode[],
  };
}

function makeProviderManager(pathResolver: any) {
  const processes = new Map<string, any>();
  const transport = { sendEvent: () => {}, invokeGuest: async () => true };
  return new ProviderManager(new VfsEventBus(), transport as any, { processes } as any, pathResolver as any);
}

function dir(name: string, path: string, children: TreeNode[] = []): TreeNode {
  return { id: path, name, path, kind: 'directory', meta: {} as any, children };
}

/**
 * getTree() が触るのは pathResolver / _filterTreeByPermission / providerManager だけなので、
 * prototype から起こして必要な依存だけ与える（ChatPanel.test.ts と同じ作法）。
 */
function makeService(tree: TreeNode[], mounts: Array<{ path: string; pid: string }>) {
  const pathResolver = makePathResolver();
  pathResolver.buildTree = () => tree;

  const providerManager = makeProviderManager(pathResolver);
  for (const m of mounts) providerManager.registerProvider(m.path, m.pid);

  const svc: any = Object.create(VfsService.prototype);
  svc.pathResolver = pathResolver;
  svc.providerManager = providerManager;
  svc._filterTreeByPermission = (_principal: any, nodes: TreeNode[]) => nodes;

  return svc as VfsService;
}

/** 木を平坦にして path -> node で引けるようにする */
function flatten(nodes: TreeNode[], acc: Record<string, TreeNode> = {}) {
  for (const n of nodes) {
    acc[n.path] = n;
    if (n.children) flatten(n.children, acc);
  }
  return acc;
}

const PRINCIPAL = { type: 'user', id: 'local_user' } as any;

describe('VfsService.getTree: 同期の印', () => {
  it('ルート全体がマウントされていても、印は付けない（本命 / 実物で破綻した条件）', () => {
    // Google ドライブ同期が VFS 全体を同期している構成。
    // ここで全ディレクトリに印が付くと、画面が印だらけになって用をなさない。
    const tree = [dir('data', 'data', [dir('projects', 'data/projects')]), dir('memory', 'memory')];
    const svc = makeService(tree, [{ path: '', pid: 'gdrive_sync_daemon' }]);

    const nodes = flatten(svc.getTree(PRINCIPAL));

    expect(nodes['data'].isVirtual).toBeFalsy();
    expect(nodes['data/projects'].isVirtual).toBeFalsy();
    expect(nodes['memory'].isVirtual).toBeFalsy();
  });

  it('ルート以外のマウントには印を付け、配下へ伝播させる', () => {
    const tree = [
      dir('local', 'local', [
        dir('yachiyo', 'local/yachiyo', [
          dir('ws_itera', 'local/yachiyo/ws_itera', [dir('src', 'local/yachiyo/ws_itera/src')]),
        ]),
      ]),
    ];
    const svc = makeService(tree, [{ path: 'local/yachiyo/ws_itera', pid: 'local_bridge' }]);

    const nodes = flatten(svc.getTree(PRINCIPAL));

    // 境界より手前（入れ物）は印を付けない
    expect(nodes['local'].isVirtual).toBeFalsy();
    expect(nodes['local/yachiyo'].isVirtual).toBeFalsy();

    // 境界とその配下に付ける
    expect(nodes['local/yachiyo/ws_itera'].isVirtual).toBe(true);
    expect(nodes['local/yachiyo/ws_itera'].isMountPoint).toBe(true);
    expect(nodes['local/yachiyo/ws_itera/src'].isVirtual).toBe(true);
    expect(nodes['local/yachiyo/ws_itera/src'].isMountPoint).toBeFalsy();
  });

  it('ルート同期と個別マウントが同居しても、個別マウントだけが目立つ（案B）', () => {
    const tree = [
      dir('data', 'data'),
      dir('local', 'local', [dir('yachiyo', 'local/yachiyo', [dir('ws_itera', 'local/yachiyo/ws_itera')])]),
    ];
    const svc = makeService(tree, [
      { path: '', pid: 'gdrive_sync_daemon' },
      { path: 'local/yachiyo/ws_itera', pid: 'local_bridge' },
    ]);

    const nodes = flatten(svc.getTree(PRINCIPAL));

    expect(nodes['data'].isVirtual).toBeFalsy();
    expect(nodes['local'].isVirtual).toBeFalsy();
    expect(nodes['local/yachiyo/ws_itera'].isVirtual).toBe(true);
  });

  it('部分木マウント（drive）は、ルートではないので印が付く', () => {
    const tree = [dir('drive', 'drive', [dir('photos', 'drive/photos')]), dir('data', 'data')];
    const svc = makeService(tree, [{ path: 'drive', pid: 'gdrive_sync_daemon' }]);

    const nodes = flatten(svc.getTree(PRINCIPAL));

    expect(nodes['drive'].isVirtual).toBe(true);
    expect(nodes['drive'].isMountPoint).toBe(true);
    expect(nodes['drive/photos'].isVirtual).toBe(true);
    expect(nodes['data'].isVirtual).toBeFalsy();
  });

  it('マウントが1つも無ければ、どこにも印は付かない（陰性対照）', () => {
    const tree = [dir('data', 'data', [dir('projects', 'data/projects')])];
    const svc = makeService(tree, []);

    const nodes = flatten(svc.getTree(PRINCIPAL));

    expect(nodes['data'].isVirtual).toBeFalsy();
    expect(nodes['data/projects'].isVirtual).toBeFalsy();
  });
});

/**
 * stat() が配る同期の情報（T-0352）
 *
 * 「実体が手元にあるか（syncState）」と「誰の管轄か（syncProvider）」は直交する。
 * 前者は node.meta に保存される。後者は**保存しない** ——
 * 問い合わせのたびにマウント表から導くので、デーモンが落ちれば次の問い合わせで消える。
 * 保存された印にすると、管轄が変わったあとも嘘が残る。
 *
 * getTree と違い、ここではルートマウントも隠さない。木では「全ディレクトリが該当して
 * 印の情報量がゼロになる」ため境界から先だけに付けるが、stat は 1 件を名指しで問う場面で、
 * 隠すと「取りに行ける stub」と「取りに行けない stub（孤児）」を区別できなくなる。
 */
function makeStatService(
  files: Record<string, { syncState?: 'stub' | 'synced' }>,
  mounts: Array<{ path: string; pid: string }>,
  opts: { withProvider?: boolean } = {},
) {
  const pathResolver: any = makePathResolver();
  pathResolver.getIdByPath = (p: string) => (p in files ? p : undefined);
  pathResolver.getPathById = (id: string) => id;

  const svc: any = Object.create(VfsService.prototype);
  svc.pathResolver = pathResolver;
  svc.auth = { checkNodePermission: () => {} };
  svc.nodeStore = {
    getNode: (id: string) => ({
      id,
      name: id.split('/').pop(),
      kind: 'file',
      meta: { size: 10, createdAt: 1, updatedAt: 2, version: 1, syncState: files[id].syncState },
      flags: { isSystem: false, isTrashed: false },
      acl: { owner: { type: 'user', id: 'local_user' }, rules: [] },
    }),
  };

  if (opts.withProvider !== false) {
    const providerManager = makeProviderManager(pathResolver);
    for (const m of mounts) providerManager.registerProvider(m.path, m.pid);
    svc.providerManager = providerManager;
  }
  return svc as VfsService;
}

const MOUNT = 'local/yachiyo/ws_itera';

describe('VfsService.stat: 実体の有無と管轄は直交する', () => {
  it('管轄下のスタブ … 実体は無く、取りに行ける相手が分かる', () => {
    const svc = makeStatService({ [`${MOUNT}/a.ts`]: { syncState: 'stub' } }, [{ path: MOUNT, pid: 'local_bridge' }]);
    const s = svc.stat(PRINCIPAL, `${MOUNT}/a.ts`);
    expect(s.syncState).toBe('stub');
    expect(s.syncProvider).toEqual({ mountPath: MOUNT, pid: 'local_bridge' });
  });

  it('管轄下で実体もある … syncState は付かないが管轄は分かる（直交の証明）', () => {
    const svc = makeStatService({ [`${MOUNT}/a.ts`]: {} }, [{ path: MOUNT, pid: 'local_bridge' }]);
    const s = svc.stat(PRINCIPAL, `${MOUNT}/a.ts`);
    expect(s.syncState).toBeUndefined();
    expect(s.syncProvider).toEqual({ mountPath: MOUNT, pid: 'local_bridge' });
  });

  it('孤児のスタブ … 実体が無く、取りに行く相手も居ない', () => {
    // デーモンが落ちた／マウントを外した後の状態。保存された印なら「synced」のまま嘘が残る
    const svc = makeStatService({ [`${MOUNT}/a.ts`]: { syncState: 'stub' } }, []);
    const s = svc.stat(PRINCIPAL, `${MOUNT}/a.ts`);
    expect(s.syncState).toBe('stub');
    expect(s.syncProvider).toBeUndefined();
  });

  it('管轄外の素のファイル … どちらも付かない', () => {
    const svc = makeStatService({ 'memory/init.md': {} }, [{ path: MOUNT, pid: 'local_bridge' }]);
    const s = svc.stat(PRINCIPAL, 'memory/init.md');
    expect(s.syncState).toBeUndefined();
    expect(s.syncProvider).toBeUndefined();
  });

  it('ルートマウントでも管轄は隠さない（getTree の isVirtual と規則が違う）', () => {
    const svc = makeStatService({ 'data/x.md': { syncState: 'stub' } }, [{ path: '', pid: 'gdrive_sync_daemon' }]);
    const s = svc.stat(PRINCIPAL, 'data/x.md');
    expect(s.syncProvider).toEqual({ mountPath: '', pid: 'gdrive_sync_daemon' });
  });

  it('深いマウントがルートマウントに勝つ（最長前置一致）', () => {
    const svc = makeStatService({ [`${MOUNT}/a.ts`]: {} }, [
      { path: '', pid: 'gdrive_sync_daemon' },
      { path: MOUNT, pid: 'local_bridge' },
    ]);
    expect(svc.stat(PRINCIPAL, `${MOUNT}/a.ts`).syncProvider!.pid).toBe('local_bridge');
  });

  it('マウント地点そのものには印が付く', () => {
    const svc = makeStatService({ [MOUNT]: {} }, [{ path: MOUNT, pid: 'local_bridge' }]);
    expect(svc.stat(PRINCIPAL, MOUNT).isMountPoint).toBe(true);
    expect(svc.stat(PRINCIPAL, MOUNT).syncProvider!.pid).toBe('local_bridge');
  });

  it('同期プロバイダの仕組みが無い環境でも落ちず、何も足さない', () => {
    const svc = makeStatService({ 'memory/init.md': {} }, [], { withProvider: false });
    const s = svc.stat(PRINCIPAL, 'memory/init.md');
    expect(s.syncProvider).toBeUndefined();
    expect(s.isMountPoint).toBeUndefined();
  });
});
