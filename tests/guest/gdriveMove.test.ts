/**
 * tests/guest/gdriveMove.test.ts
 * gdrive_sync の onMove — 改名・移動を Drive の側（files.update の parents と name）で済ませる（T-0691）
 *
 * 核は onMove が true を返すと stub を実体化せずに手元を動かす。だから true を返すのは
 * 「Drive の項目を動かし終え、アンカーの鍵を新パスへ付け替え終えた」ときだけでなければならない。
 * 実装をコピーせず、ソースの <script> をそのまま評価する（gdriveExclusion.test.ts と同じ作法）。
 * 外側（MetaOS.fs と Drive の API）は偽物に差し替える。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const HTML = readFileSync(resolve(__dirname, '../../vfs_root/system/services/gdrive_sync.html'), 'utf-8');

function scriptBody(): string {
  const m = HTML.match(/<script>([\s\S]*)<\/script>/);
  if (!m) throw new Error('gdrive_sync.html から script を取り出せなかった。');
  let s = m[1];
  const sub = (from: string, to: string) => {
    if (!s.includes(from)) throw new Error(`gdrive_sync.html に ${from} が無い。実装の書き方が変わった可能性がある。`);
    s = s.replace(from, to);
  };
  sub('const MOVE_WAIT_MS = 30 * 1000;', 'const MOVE_WAIT_MS = 300;');
  sub('const MOVE_POLL_MS = 50;', 'const MOVE_POLL_MS = 5;');
  sub('const DEBOUNCE_MS = 1500;', 'const DEBOUNCE_MS = 60000;'); // 試験中に照合を走らせない
  const tail = /\n\s*init\(\);\s*$/;
  if (!tail.test(s)) throw new Error('gdrive_sync.html の末尾に init() が無い。');
  return s.replace(
    tail,
    `
      return {
        onMove, onFetchContent, planDriveMove, rekeyAnchor, reconcile,
        set(o) { if ('root' in o) rootFolderId = o.root; if ('mount' in o) mountPath = o.mount; if ('syncing' in o) isSyncing = o.syncing; },
        get isSyncing() { return isSyncing; },
        stopTimer() { clearTimeout(syncTimer); },
      };`,
  );
}

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  md5Checksum?: string;
  size?: string;
  modifiedTime: string;
};
type Req = { method: string; url: string; body?: unknown };

const FOLDER = 'application/vnd.google-apps.folder';
const TOKEN = 'system/temp/gdrive_token.json';
const ANCHOR = 'system/temp/gdrive_anchor.json';
const INDEX = 'system/temp/gdrive_index.json';

function makeEnv(mount = 'drive') {
  const files = new Map<string, string>();
  const local = new Set<string>();
  const drive = new Map<string, DriveFile>();
  const reqs: Req[] = [];
  const fail: { patch?: number; anchorWrite?: boolean } = {};
  let seq = 0;

  const meta = {
    fs: {
      async read(p: string) {
        if (!files.has(p)) throw new Error(`ENOENT ${p}`);
        return files.get(p)!;
      },
      async write(p: string, c: unknown) {
        if (p === ANCHOR && fail.anchorWrite) throw new Error('disk full');
        files.set(p, typeof c === 'string' ? c : '<bytes>');
        local.add(p);
      },
      async exists(p: string) {
        return local.has(p);
      },
      async stat(p: string) {
        return { hash: `h:${p}`, createdAt: 1, updatedAt: 2 };
      },
      async getSyncState() {
        await new Promise((r) => setTimeout(r, 30));
        const out: Record<string, unknown> = {};
        for (const p of local) {
          if (p.startsWith('system/')) continue;
          out[p] = p.endsWith('.txt') ? { kind: 'file', hash: `h:${p}` } : { kind: 'directory' };
        }
        return out;
      },
      async listMounts() {
        return [{ mountPath: mount }];
      },
      async mkdir(p: string) {
        local.add(p);
      },
    },
    net: {
      async fetch(url: string, opts: { method?: string; body?: string } = {}) {
        const method = (opts.method || 'GET').toUpperCase();
        const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : undefined;
        reqs.push({ method, url, body });
        const u = new URL(url);
        const m = u.pathname.match(/\/drive\/v3\/files\/([^/]+)$/);
        if (u.pathname.endsWith('/changes/startPageToken')) return { status: 200, data: { startPageToken: 'p1' } };
        if (u.pathname.endsWith('/changes')) return { status: 200, data: { changes: [], newStartPageToken: 'p1' } };
        if (method === 'GET' && u.pathname.endsWith('/drive/v3/files')) {
          return { status: 200, data: { files: [...drive.values()].map((f) => ({ ...f })) } };
        }
        if (method === 'POST' && u.pathname.endsWith('/drive/v3/files')) {
          const id = `new${++seq}`;
          drive.set(id, {
            id,
            name: body.name,
            mimeType: body.mimeType,
            parents: body.parents,
            modifiedTime: new Date().toISOString(),
          });
          return { status: 200, data: { id } };
        }
        if (m && method === 'GET' && u.searchParams.get('alt') === 'media') {
          return drive.has(m[1]) ? { status: 200, data: new Uint8Array([1, 2, 3]) } : { status: 404, data: '' };
        }
        if (m && method === 'PATCH') {
          if (fail.patch && !(body && body.trashed)) return { status: fail.patch, data: 'boom' };
          const f = drive.get(decodeURIComponent(m[1]));
          if (!f) return { status: 404, data: '' };
          if (body && body.trashed) {
            drive.delete(f.id);
            return { status: 200, data: { id: f.id } };
          }
          const add = u.searchParams.get('addParents');
          const rm = u.searchParams.get('removeParents');
          if (rm) f.parents = f.parents.filter((x) => x !== rm);
          if (add) f.parents.push(add);
          if (body && body.name) f.name = body.name;
          return { status: 200, data: { ...f } };
        }
        return { status: 500, data: `unexpected ${method} ${url}` };
      },
    },
  };

  const api = new Function('MetaOS', 'window', scriptBody())(meta, { MetaOS: meta });
  api.set({ root: 'ROOT', mount });

  const at = (p: string) => (mount ? `${mount}/${p}` : p);
  return {
    api,
    files,
    local,
    drive,
    reqs,
    fail,
    at,
    /** Drive の木・アンカー・索引・手元を揃えて置く（同期が追いついた状態） */
    seed(tree: Array<{ id: string; path: string; dir?: boolean; parent: string }>, opts: { stubs?: string[] } = {}) {
      const anchor: Record<string, unknown> = {};
      const byId: Record<string, unknown> = {};
      for (const t of tree) {
        const name = t.path.split('/').pop()!;
        const f: DriveFile = {
          id: t.id,
          name,
          mimeType: t.dir ? FOLDER : 'text/plain',
          parents: [t.parent],
          md5Checksum: t.dir ? undefined : `md5-${t.id}`,
          size: t.dir ? undefined : '3',
          modifiedTime: '2026-11-12T00:00:00.000Z',
        };
        drive.set(t.id, f);
        byId[t.id] = {
          name,
          parents: [t.parent],
          kind: t.dir ? 'directory' : 'file',
          md5: f.md5Checksum || null,
          size: 3,
          modifiedTime: 1,
        };
        anchor[at(t.path)] = t.dir
          ? { id: t.id, kind: 'directory', hash: null, rhash: null }
          : {
              id: t.id,
              kind: 'file',
              hash: (opts.stubs || []).includes(t.path) ? null : `h:${at(t.path)}`,
              rhash: f.md5Checksum,
            };
        local.add(at(t.path));
      }
      files.set(TOKEN, JSON.stringify({ accessToken: 'tok', expiresAt: Date.now() + 3600_000 }));
      files.set(ANCHOR, JSON.stringify(anchor));
      files.set(INDEX, JSON.stringify({ byId, pageToken: null, builtAt: Date.now(), rootFolderId: 'ROOT' }));
    },
    anchor(): Record<string, { id: string }> {
      return JSON.parse(files.get(ANCHOR)!);
    },
    /** 核の役: onMove が true を返したら手元を動かす */
    moveLocal(from: string, to: string) {
      for (const p of [...local]) {
        if (p === from || p.startsWith(from + '/')) {
          local.delete(p);
          local.add(to + p.slice(from.length));
        }
      }
    },
  };
}

const until = async (cond: () => boolean, ms = 2000) => {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const TREE = [
  { id: 'A', path: 'A', dir: true, parent: 'ROOT' },
  { id: 'a1', path: 'A/one.txt', parent: 'A' },
  { id: 'AS', path: 'A/sub', dir: true, parent: 'A' },
  { id: 'a2', path: 'A/sub/two.txt', parent: 'AS' },
  { id: 'B', path: 'B', dir: true, parent: 'ROOT' },
  { id: 'b1', path: 'B/x.txt', parent: 'B' },
];

describe('planDriveMove（判定）', () => {
  let env: ReturnType<typeof makeEnv>;
  let A: Record<string, { id: string }>;
  let R: Record<string, { id: string; kind: string }>;
  let byId: Record<string, { parents: string[] }>;
  beforeEach(() => {
    env = makeEnv('drive');
    env.seed(TREE);
    A = env.anchor();
    R = {};
    byId = {};
    for (const t of TREE) {
      R[env.at(t.path)] = { id: t.id, kind: t.dir ? 'directory' : 'file' };
      byId[t.id] = { parents: [t.parent] };
    }
  });
  const plan = (o: string, n: string) => env.api.planDriveMove(o, n, A, R, byId, 'ROOT');

  it('フォルダを別のフォルダへ: 親を付け替え、配下のアンカーの鍵を全部移す（本命）', () => {
    const p = plan('drive/A', 'drive/B/A2');
    expect(p).toMatchObject({ ok: true, id: 'A', oldName: 'A', newName: 'A2', oldParentId: 'ROOT', newParentId: 'B' });
    expect(new Map(p.moves)).toEqual(
      new Map([
        ['drive/A', 'drive/B/A2'],
        ['drive/A/one.txt', 'drive/B/A2/one.txt'],
        ['drive/A/sub', 'drive/B/A2/sub'],
        ['drive/A/sub/two.txt', 'drive/B/A2/sub/two.txt'],
      ]),
    );
  });
  it('同じフォルダの中の改名: 親は同じ', () => {
    expect(plan('drive/A/one.txt', 'drive/A/uno.txt')).toMatchObject({
      ok: true,
      oldParentId: 'A',
      newParentId: 'A',
      moves: [['drive/A/one.txt', 'drive/A/uno.txt']],
    });
  });
  it('名前が前置一致するだけの兄弟は巻き込まない', () => {
    A['drive/A2'] = { id: 'zz' };
    expect(plan('drive/A', 'drive/C').moves.map((m: string[]) => m[0])).not.toContain('drive/A2');
  });
  it('行き先の親が Drive に無ければ作る（newParentId: null）', () => {
    expect(plan('drive/B/x.txt', 'drive/N/M/x.txt')).toMatchObject({
      ok: true,
      newParentId: null,
      newParentRel: 'N/M',
    });
  });
  it.each([
    ['マウントの外へ', 'drive/A', 'data/A'],
    ['マウントの外から', 'data/A', 'drive/A9'],
    ['マウントそのもの', 'drive', 'drive2'],
    ['自分の配下へ', 'drive/A', 'drive/A/sub/A'],
    ['Drive に無い（未送信の新しいファイル）', 'drive/A/new.txt', 'drive/B/new.txt'],
    ['行き先が Drive に在る', 'drive/A/one.txt', 'drive/B/x.txt'],
    ['行き先がファイルの下', 'drive/A/one.txt', 'drive/B/x.txt/one.txt'],
  ])('断る: %s', (_label, o, n) => {
    expect(plan(o, n).ok).toBe(false);
  });
  it('断る: アンカーが別の fileId を指している（同期が追いついていない）', () => {
    A['drive/A/one.txt'] = { id: 'other' };
    expect(plan('drive/A/one.txt', 'drive/B/one.txt')).toMatchObject({ ok: false });
  });
  it('断る: 行き先が Drive にだけ在る（まだ取り込んでいない）', () => {
    R['drive/B/remote'] = { id: 'r9', kind: 'directory' };
    expect(plan('drive/A/one.txt', 'drive/B/remote')).toMatchObject({ ok: false });
    expect(plan('drive/A/one.txt', 'drive/B')).toMatchObject({ ok: false });
  });
  it('断る: 行き先がアンカーにだけ残っている', () => {
    A['drive/B/gone.txt'] = { id: 'g' };
    expect(plan('drive/A/one.txt', 'drive/B/gone.txt')).toMatchObject({ ok: false });
  });
  it('断る: Drive の親が導いた親と違う', () => {
    byId['a1'] = { parents: ['B'] };
    expect(plan('drive/A/one.txt', 'drive/A/uno.txt')).toMatchObject({ ok: false });
  });
  it('断る: 同期の外（system/temp）へ', () => {
    const root = makeEnv('');
    root.seed(TREE);
    const RR: Record<string, unknown> = {};
    for (const t of TREE) RR[t.path] = { id: t.id, kind: t.dir ? 'directory' : 'file' };
    expect(root.api.planDriveMove('A/one.txt', 'system/temp/one.txt', root.anchor(), RR, byId, 'ROOT').ok).toBe(false);
    expect(root.api.planDriveMove('A/one.txt', 'B/one.txt', root.anchor(), RR, byId, 'ROOT').ok).toBe(true);
  });
});

describe('rekeyAnchor', () => {
  it('鍵だけを付け替え、値と他の鍵は変えない。逆向きで戻る', () => {
    const env = makeEnv();
    const a = { x: { id: '1' }, 'x/y': { id: '2' }, xz: { id: '3' } };
    const moves = [
      ['x', 'q'],
      ['x/y', 'q/y'],
    ];
    const out = env.api.rekeyAnchor(structuredClone(a), moves);
    expect(out).toEqual({ q: { id: '1' }, 'q/y': { id: '2' }, xz: { id: '3' } });
    expect(
      env.api.rekeyAnchor(
        out,
        moves.map(([f, t]) => [t, f]),
      ),
    ).toEqual(a);
  });
});

describe('onMove（偽の Drive を相手に）', () => {
  it('フォルダの移動は files.update 1 回。中身は落とさず、stub は新パスで fileId から取れる（本命）', async () => {
    const env = makeEnv();
    env.seed(TREE, { stubs: ['A/sub/two.txt'] });
    env.local.delete('drive/A/sub/two.txt'); // stub（exists は真だが中身が無い）を区別しない偽物なので、手元の有無だけ見る
    env.local.add('drive/A/sub/two.txt');

    expect(await env.api.onMove('drive/A', 'drive/B/A2')).toBe(true);
    const patches = env.reqs.filter((r) => r.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toContain('/files/A?');
    expect(patches[0].url).toContain('addParents=B');
    expect(patches[0].url).toContain('removeParents=ROOT');
    expect(patches[0].body).toEqual({ name: 'A2' });
    expect(env.reqs.some((r) => r.url.includes('alt=media'))).toBe(false);
    expect(env.drive.get('A')!.parents).toEqual(['B']);

    const anchor = env.anchor();
    expect(Object.keys(anchor).filter((k) => k.startsWith('drive/A'))).toEqual([]);
    expect(anchor['drive/B/A2/sub/two.txt'].id).toBe('a2');
    expect(anchor['drive/B/x.txt'].id).toBe('b1');

    // 核が手元を動かすまで照合は止まっている
    expect(env.api.isSyncing).toBe(true);
    env.moveLocal('drive/A', 'drive/B/A2');
    await until(() => !env.api.isSyncing);
    env.api.stopTimer();

    env.reqs.length = 0;
    expect(await env.api.onFetchContent('drive/B/A2/sub/two.txt')).toBe(true);
    expect(env.reqs.map((r) => r.url).find((u) => u.includes('alt=media'))).toContain('/files/a2?alt=media');
    expect(env.anchor()['drive/B/A2/sub/two.txt']).toMatchObject({ id: 'a2', hash: 'h:drive/B/A2/sub/two.txt' });
  });

  it('同じフォルダの中の改名は addParents / removeParents を付けない', async () => {
    const env = makeEnv();
    env.seed(TREE);
    expect(await env.api.onMove('drive/A/one.txt', 'drive/A/uno.txt')).toBe(true);
    const patch = env.reqs.find((r) => r.method === 'PATCH')!;
    expect(patch.url).not.toContain('Parents=');
    expect(patch.body).toEqual({ name: 'uno.txt' });
    env.moveLocal('drive/A/one.txt', 'drive/A/uno.txt');
    await until(() => !env.api.isSyncing);
    env.api.stopTimer();
  });

  it('行き先の親が無ければ Drive に作ってから動かす', async () => {
    const env = makeEnv();
    env.seed(TREE);
    expect(await env.api.onMove('drive/B/x.txt', 'drive/N/x.txt')).toBe(true);
    const created = [...env.drive.values()].find((f) => f.name === 'N')!;
    expect(created.parents).toEqual(['ROOT']);
    expect(env.drive.get('b1')!.parents).toEqual([created.id]);
    env.moveLocal('drive/B/x.txt', 'drive/N/x.txt');
    await until(() => !env.api.isSyncing);
    env.api.stopTimer();
  });

  it('判定で断ったら何も書かずに false（核は実体化の経路へ）', async () => {
    const env = makeEnv();
    env.seed(TREE);
    const before = env.files.get(ANCHOR);
    env.local.add('drive/A/new.txt');
    expect(await env.api.onMove('drive/A/new.txt', 'drive/B/new.txt')).toBe(false);
    expect(env.reqs.filter((r) => r.method !== 'GET')).toEqual([]);
    expect(env.files.get(ANCHOR)).toBe(before);
    expect(env.api.isSyncing).toBe(false);
  });

  it('files.update が失敗したら false。アンカーは元のまま・作ったフォルダは片付ける', async () => {
    const env = makeEnv();
    env.seed(TREE);
    const before = env.files.get(ANCHOR);
    env.fail.patch = 500;
    expect(await env.api.onMove('drive/B/x.txt', 'drive/N/x.txt')).toBe(false);
    expect(env.files.get(ANCHOR)).toBe(before);
    expect([...env.drive.values()].some((f) => f.name === 'N')).toBe(false);
    expect(env.api.isSyncing).toBe(false);
  });

  it('Drive を動かした後でアンカーを書けなかったら、Drive を戻して false', async () => {
    const env = makeEnv();
    env.seed(TREE);
    env.fail.anchorWrite = true;
    expect(await env.api.onMove('drive/A', 'drive/B/A2')).toBe(false);
    const patches = env.reqs.filter((r) => r.method === 'PATCH');
    expect(patches).toHaveLength(2);
    expect(patches[1].url).toContain('addParents=ROOT');
    expect(patches[1].url).toContain('removeParents=B');
    expect(env.drive.get('A')).toMatchObject({ name: 'A', parents: ['ROOT'] });
    expect(env.api.isSyncing).toBe(false);
  });

  it('true を返したのに手元が動かなかったら（権限など）、見切って Drive とアンカーを戻す', async () => {
    const env = makeEnv();
    env.seed(TREE);
    const before = env.anchor();
    expect(await env.api.onMove('drive/A', 'drive/B/A2')).toBe(true);
    await until(() => !env.api.isSyncing);
    env.api.stopTimer();
    expect(env.drive.get('A')).toMatchObject({ name: 'A', parents: ['ROOT'] });
    expect(env.anchor()).toEqual(before);
  });

  it('照合の最中なら終わるのを待ってから動かす', async () => {
    const env = makeEnv();
    env.seed(TREE);
    env.api.set({ syncing: true });
    const p = env.api.onMove('drive/A/one.txt', 'drive/A/uno.txt');
    await new Promise((r) => setTimeout(r, 150));
    expect(env.reqs.some((r) => r.method === 'PATCH')).toBe(false);
    env.api.set({ syncing: false });
    expect(await p).toBe(true);
    env.moveLocal('drive/A/one.txt', 'drive/A/uno.txt');
    await until(() => !env.api.isSyncing);
    env.api.stopTimer();
  });

  it('照合が長くても、途中で譲らせて動かす（照合は YIELD_TO_MOVE で止まり、アンカーは壊れない）', async () => {
    const env = makeEnv();
    env.seed(TREE);
    const before = env.anchor();
    env.api.set({ syncing: true }); // triggerSync の役
    let err: Error | null = null;
    const rec = env.api
      .reconcile()
      .catch((e: Error) => {
        err = e;
      })
      .finally(() => env.api.set({ syncing: false }));
    const p = env.api.onMove('drive/A/one.txt', 'drive/A/uno.txt');
    await rec;
    expect(err && (err as Error).message).toBe('YIELD_TO_MOVE');
    expect(await p).toBe(true);
    const after = env.anchor();
    expect(after['drive/A/uno.txt']).toEqual(before['drive/A/one.txt']);
    expect(Object.keys(after).sort()).toEqual(
      Object.keys(before)
        .map((k) => (k === 'drive/A/one.txt' ? 'drive/A/uno.txt' : k))
        .sort(),
    );
    env.moveLocal('drive/A/one.txt', 'drive/A/uno.txt');
    await until(() => !env.api.isSyncing);
    env.api.stopTimer();
  });

  it('未ログインなら何も問わずに false', async () => {
    const env = makeEnv();
    env.seed(TREE);
    env.files.delete(TOKEN);
    expect(await env.api.onMove('drive/A', 'drive/B/A2')).toBe(false);
    expect(env.reqs).toEqual([]);
  });

  it('申し出: registerSyncProvider に onMove を渡している', () => {
    expect(HTML).toMatch(/registerSyncProvider\(mountPath, \{[\s\S]*?onMove,[\s\S]*?\}\);/);
  });
});
