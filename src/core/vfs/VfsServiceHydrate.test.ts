import { describe, it, expect } from 'vitest';
import { VfsService } from './VfsService';
import { isVfsError } from './VfsError';

/**
 * src/core/vfs/VfsServiceHydrate.test.ts
 * パスを変える操作の前の実体化（_hydrateIfNeeded）— T-0689
 *
 * stub の中身を取りに行く鍵はパスだけである。改名・移動・ゴミ箱・復元・複製でパスを変える前に
 * 部分木の stub をすべて実体化しておかないと、新パスでは取れず、旧パスは次の照合で
 * 「ローカルで消された」と読まれて向こう側からも消える（ミャク楽で実際に起きた）。
 * 以前は「移動元と移動先のプロバイダが同じなら実体化しない」としていたが、追従できるプロバイダは無い。
 */

type FakeNode = {
  id: string;
  name: string;
  parentId: string | null;
  kind: 'file' | 'directory';
  meta: { syncState?: 'stub' };
};

function makeService(opts: {
  nodes: FakeNode[];
  mounts?: Array<{ path: string; pid: string; move?: boolean }>;
  failing?: string[];
  /** onMove の返事（既定 true）。例外を投げさせるときは関数 */
  moveResult?: boolean | (() => Promise<boolean>);
}) {
  const byId = new Map(opts.nodes.map((n) => [n.id, n]));
  const nodeStore = {
    getNode: (id: string) => byId.get(id),
    getChildren: (parentId: string | null) => opts.nodes.filter((n) => n.parentId === parentId),
  };
  const pathOf = (id: string): string => {
    const n = byId.get(id)!;
    return n.parentId === null ? n.name : `${pathOf(n.parentId)}/${n.name}`;
  };
  const pathResolver = {
    getIdByPath: (p: string) => opts.nodes.find((n) => pathOf(n.id) === p)?.id,
  };
  const mounts = opts.mounts ?? [{ path: '', pid: 'sync' }];
  const providerManager = {
    findProviderForPath: (p: string) => {
      const hit = mounts
        .filter((m) => m.path === '' || p === m.path || p.startsWith(m.path + '/'))
        .sort((a, b) => b.path.length - a.path.length)[0];
      return hit ? { mountPath: hit.path, pid: hit.pid, capabilities: { move: !!hit.move } } : undefined;
    },
    moveContent: async (oldPath: string, newPath: string) => {
      moved.push(`${oldPath} -> ${newPath}`);
      const r = opts.moveResult;
      if (typeof r === 'function') return await r();
      return r !== false;
    },
  };
  const fetched: string[] = [];
  const moved: string[] = [];
  const svc: any = Object.create(VfsService.prototype);
  svc.nodeStore = nodeStore;
  svc.pathResolver = pathResolver;
  svc.providerManager = providerManager;
  // 読むと provider が中身を落として stub の印が外れる（実物の readBlob と同じ結果だけを写す）
  svc.readBlob = async (_principal: any, path: string) => {
    fetched.push(path);
    if ((opts.failing ?? []).includes(path)) throw new Error(`Failed to fetch missing content for ${path}`);
    const id = pathResolver.getIdByPath(path)!;
    delete byId.get(id)!.meta.syncState;
    return new Blob([]);
  };
  return { svc: svc as VfsService, fetched, moved, byId };
}

const P = { type: 'user', id: 'local_user' } as any;

const tree = (): FakeNode[] => [
  { id: 'A', name: 'A', parentId: null, kind: 'directory', meta: {} },
  { id: 'A/res', name: 'resources', parentId: 'A', kind: 'directory', meta: {} },
  { id: 'A/res/match', name: 'match.js', parentId: 'A/res', kind: 'file', meta: { syncState: 'stub' } },
  { id: 'A/res/run', name: 'run.js', parentId: 'A/res', kind: 'file', meta: {} },
  { id: 'A/notes', name: 'notes.md', parentId: 'A', kind: 'file', meta: { syncState: 'stub' } },
];

describe('VfsService._hydrateIfNeeded: パスを変える前に stub を実体化する', () => {
  it('同じプロバイダの中の改名でも、部分木の stub をすべて実体化する（本命・実物で失った条件）', async () => {
    const { svc, fetched, byId } = makeService({ nodes: tree() });
    await svc._hydrateIfNeeded(P, 'A', 'B');
    expect(fetched.sort()).toEqual(['A/notes.md', 'A/resources/match.js']);
    expect(byId.get('A/res/match')!.meta.syncState).toBeUndefined();
    expect(byId.get('A/notes')!.meta.syncState).toBeUndefined();
  });

  it('実体のあるファイルは読まない', async () => {
    const { svc, fetched } = makeService({ nodes: tree() });
    await svc._hydrateIfNeeded(P, 'A/resources/run.js', 'B/run.js');
    expect(fetched).toEqual([]);
  });

  it('1 本でも取れなければ ESTUB で止める（何を運ぼうとしていたか・どれが取れなかったかを言う）', async () => {
    const { svc } = makeService({ nodes: tree(), failing: ['A/resources/match.js'] });
    let err: unknown;
    try {
      await svc._hydrateIfNeeded(P, 'A', 'B');
    } catch (e) {
      err = e;
    }
    expect(isVfsError(err)).toBe(true);
    expect((err as any).code).toBe('ESTUB');
    expect((err as any).message).toContain('A/resources/match.js');
    expect((err as any).message).toContain('Nothing was changed');
  });

  it('プロバイダを跨ぐ移動でも同じ規則（以前は warn で続行していた）', async () => {
    const { svc } = makeService({
      nodes: tree(),
      mounts: [{ path: 'A', pid: 'bridge' }],
      failing: ['A/notes.md'],
    });
    await expect(svc._hydrateIfNeeded(P, 'A/notes.md', 'data/notes.md')).rejects.toMatchObject({ code: 'ESTUB' });
  });

  it('stub を持つのにプロバイダが無いときも ESTUB（黙って空の stub を運ばない）', async () => {
    const { svc } = makeService({ nodes: tree() });
    (svc as any).providerManager = undefined;
    await expect(svc._hydrateIfNeeded(P, 'A/notes.md', 'B/notes.md')).rejects.toMatchObject({ code: 'ESTUB' });
  });

  it('stub が無ければ、プロバイダが無くても通る', async () => {
    const { svc } = makeService({ nodes: tree() });
    (svc as any).providerManager = undefined;
    await expect(svc._hydrateIfNeeded(P, 'A/resources/run.js', 'B/run.js')).resolves.toBeUndefined();
  });

  it('存在しないパスは何もしない（存在の検査は各操作がロックの中で行う）', async () => {
    const { svc, fetched } = makeService({ nodes: tree() });
    await svc._hydrateIfNeeded(P, 'nope', 'B');
    expect(fetched).toEqual([]);
  });
});

describe('VfsService._hydrateIfNeeded: プロバイダが move を申し出ているとき（改名・移動だけ）', () => {
  const withMove = [{ path: '', pid: 'sync', move: true }];

  it('同じプロバイダの中の改名は onMove に任せ、stub を実体化しない', async () => {
    const { svc, fetched, moved, byId } = makeService({ nodes: tree(), mounts: withMove });
    await svc._hydrateIfNeeded(P, 'A', 'B', { delegateMove: true });
    expect(moved).toEqual(['A -> B']);
    expect(fetched).toEqual([]);
    expect(byId.get('A/res/match')!.meta.syncState).toBe('stub');
  });

  it('onMove が false なら「何も変えていない」と読んで実体化に戻る', async () => {
    const { svc, fetched, moved } = makeService({ nodes: tree(), mounts: withMove, moveResult: false });
    await svc._hydrateIfNeeded(P, 'A', 'B', { delegateMove: true });
    expect(moved).toEqual(['A -> B']);
    expect(fetched.sort()).toEqual(['A/notes.md', 'A/resources/match.js']);
  });

  it('delegateMove が無い操作（複製・ゴミ箱・復元）は申し出があっても実体化する', async () => {
    const { svc, fetched, moved } = makeService({ nodes: tree(), mounts: withMove });
    await svc._hydrateIfNeeded(P, 'A', 'B');
    expect(moved).toEqual([]);
    expect(fetched).toHaveLength(2);
  });

  it('行き先がゴミ箱なら任せない（trash/ は同期の外。向こうを動かすと消える）', async () => {
    const { svc, fetched, moved } = makeService({ nodes: tree(), mounts: withMove });
    await svc._hydrateIfNeeded(P, 'A', 'trash/123_A', { delegateMove: true });
    expect(moved).toEqual([]);
    expect(fetched).toHaveLength(2);
  });

  it('プロバイダを跨ぐ移動は任せない', async () => {
    const { svc, fetched, moved } = makeService({
      nodes: tree(),
      mounts: [
        { path: 'A', pid: 'bridge', move: true },
        { path: '', pid: 'sync', move: true },
      ],
    });
    await svc._hydrateIfNeeded(P, 'A/notes.md', 'data/notes.md', { delegateMove: true });
    expect(moved).toEqual([]);
    expect(fetched).toEqual(['A/notes.md']);
  });

  it('プロバイダ自身の改名（衝突の写しなど）は向こうへ跳ね返さない', async () => {
    const { svc, fetched, moved } = makeService({ nodes: tree(), mounts: withMove });
    await svc._hydrateIfNeeded({ type: 'system', id: 'sync' } as any, 'A/notes.md', 'A/notes (Conflicted Copy).md', {
      delegateMove: true,
    });
    expect(moved).toEqual([]);
    expect(fetched).toEqual(['A/notes.md']);
  });

  it('行き先が既に在るなら向こうを先に動かさない（改名は EEXIST で失敗する）', async () => {
    const { svc, moved } = makeService({ nodes: tree(), mounts: withMove });
    await svc._hydrateIfNeeded(P, 'A/notes.md', 'A/resources/run.js', { delegateMove: true });
    expect(moved).toEqual([]);
  });

  it('申し出が無いプロバイダ（既定）は従来どおり実体化', async () => {
    const { svc, fetched, moved } = makeService({ nodes: tree() });
    await svc._hydrateIfNeeded(P, 'A', 'B', { delegateMove: true });
    expect(moved).toEqual([]);
    expect(fetched).toHaveLength(2);
  });
});
