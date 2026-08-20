/**
 * src/core/vfs/localBridgeRelease.test.ts
 * Local Bridge の検証付きスタブ化（T-0037）
 *
 * 対象は `vfs_root/system/services/local_bridge.html`（ゲスト実装）。
 * vitest の対象外なので、**実装をコピーせずソースから取り出して評価する**。
 * （コピーすると、コピーだけが正しくて本体が壊れている状態を検出できない。）
 *
 * ここで守るのは一点だけ:
 *   **ホスト側に同じ内容があると確かめられたときにしか、VFS のバイト列を捨てない。**
 *
 * スタブ化は「消す」操作である。取り違えれば利用者のファイルが失われる。
 * したがって「ホストに無い」「内容が違う」「確認が取れない」の 3 つは、
 * それぞれ別の結末（見送り / 見送り / 中断）でなければならない。
 * とくに **確認が取れないときに「無い」と誤読して捨てないこと**。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE_PATH = resolve(__dirname, '../../../vfs_root/system/services/local_bridge.html');

/** ソースから断片を切り出す。取り出せなければ**失敗させる**（黙って素通りさせない）。 */
function extract(src: string, re: RegExp, label: string): string {
  const m = src.match(re);
  if (!m) {
    throw new Error(
      `local_bridge.html から ${label} を取り出せなかった。実装の書き方が変わった可能性がある。` +
        '試験を通す前に、まず対象を確認すること。',
    );
  }
  return m[0];
}

interface Harness {
  release: (conn: any, root: string, relPath: string, onProgress?: (p: any) => void) => Promise<any>;
  stubbed: Array<{ path: string; meta: any }>;
  verifyCalls: string[][];
  chunk: number;
}

/**
 * 実物の releaseVerified を、外側の依存だけ差し替えて取り出す。
 * isStub と VERIFY_CHUNK も**実物を使う**（値も契約のうちなので）。
 */
function load(opts: {
  state: Record<string, any>;
  hostFiles: Record<string, { hash: string; size: number }>;
  failVerifyOnCall?: number;
}): Harness {
  const src = readFileSync(SOURCE_PATH, 'utf-8');
  const fnSrc = extract(
    src,
    /async function releaseVerified\(conn, root, relPath, onProgress\) \{[\s\S]*?\n {8}\}/,
    'releaseVerified',
  );
  const isStubSrc = extract(src, /const isStub = \(info\) => [^\n]+/, 'isStub');
  const chunkSrc = extract(src, /const VERIFY_CHUNK = \d+;/, 'VERIFY_CHUNK');

  const stubbed: Array<{ path: string; meta: any }> = [];
  const verifyCalls: string[][] = [];

  const MetaOS = {
    fs: {
      getSyncState: async () => opts.state,
      createStub: async (path: string, meta: any) => {
        stubbed.push({ path, meta });
      },
    },
  };

  const getJson = async (_url: string, init: any) => {
    const paths: string[] = JSON.parse(init.body).paths;
    verifyCalls.push(paths);
    if (opts.failVerifyOnCall && verifyCalls.length === opts.failVerifyOnCall) {
      throw new Error('HTTP 500');
    }
    const results: Record<string, any> = {};
    for (const rel of paths) {
      const h = opts.hostFiles[rel];
      results[rel] = h ? { present: true, hash: h.hash, size: h.size } : { present: false };
    }
    return { results };
  };

  const factory = new Function(
    'ensureLive',
    'MOUNT_BASE',
    'MetaOS',
    'getJson',
    'api',
    `${chunkSrc}\n${isStubSrc}\n${fnSrc}\nreturn { releaseVerified, VERIFY_CHUNK };`,
  );
  const mod = factory(
    () => undefined,
    'local',
    MetaOS,
    getJson,
    (_c: any, p: string) => `http://host${p}`,
  );

  return { release: mod.releaseVerified, stubbed, verifyCalls, chunk: mod.VERIFY_CHUNK };
}

const CONN = { name: 'yachiyo', serverUrl: 'http://host' };
const file = (hash: string) => ({ kind: 'file', hash });
const stub = (hash: string) => ({ kind: 'file', hash, syncState: 'stub' });

describe('releaseVerified: 捨ててよいと確かめられたものだけ捨てる', () => {
  it('ホストと一致する実体はスタブ化する', async () => {
    const h = load({
      state: { 'local/yachiyo/ws/a.txt': file('H1') },
      hostFiles: { 'a.txt': { hash: 'H1', size: 10 } },
    });
    const r = await h.release(CONN, 'ws', '');
    expect(r.released).toBe(1);
    expect(r.bytes).toBe(10);
    expect(h.stubbed).toEqual([
      { path: 'local/yachiyo/ws/a.txt', meta: expect.objectContaining({ hash: 'H1', size: 10 }) },
    ]);
  });

  it('ホストに実体が無いものは捨てない（見送る）', async () => {
    const h = load({
      state: { 'local/yachiyo/ws/only_here.txt': file('H1') },
      hostFiles: {},
    });
    const r = await h.release(CONN, 'ws', '');
    expect(r.released).toBe(0);
    expect(h.stubbed).toEqual([]);
    expect(r.skipped[0]).toContain('ホストに実体が無い');
  });

  it('ハッシュが食い違うものは捨てない（VFS 側の編集を失わない）', async () => {
    const h = load({
      state: { 'local/yachiyo/ws/edited.txt': file('LOCAL') },
      hostFiles: { 'edited.txt': { hash: 'REMOTE', size: 3 } },
    });
    const r = await h.release(CONN, 'ws', '');
    expect(r.released).toBe(0);
    expect(h.stubbed).toEqual([]);
    expect(r.skipped[0]).toContain('ハッシュ不一致');
  });

  it('確認が取れないときは中断する（「無い」と読み替えて捨てない）', async () => {
    const h = load({
      state: { 'local/yachiyo/ws/a.txt': file('H1') },
      hostFiles: { 'a.txt': { hash: 'H1', size: 1 } },
      failVerifyOnCall: 1,
    });
    await expect(h.release(CONN, 'ws', '')).rejects.toThrow('[中断]');
    expect(h.stubbed).toEqual([]);
  });

  it('中断しても、それまでにスタブ化した分は握りつぶさない', async () => {
    const state: Record<string, any> = {};
    const hostFiles: Record<string, { hash: string; size: number }> = {};
    // 2 回目の verify で落とすため、chunk をまたぐ件数を作る
    for (let i = 0; i < 250; i++) {
      state[`local/yachiyo/ws/f${i}.txt`] = file(`H${i}`);
      hostFiles[`f${i}.txt`] = { hash: `H${i}`, size: 2 };
    }
    const h = load({ state, hostFiles, failVerifyOnCall: 2 });
    await expect(h.release(CONN, 'ws', '')).rejects.toMatchObject({
      partial: expect.objectContaining({ released: h.chunk }),
    });
    expect(h.stubbed.length).toBe(h.chunk);
  });

  it('すでにスタブのものは対象にしない', async () => {
    const h = load({
      state: { 'local/yachiyo/ws/a.txt': stub('H1') },
      hostFiles: { 'a.txt': { hash: 'H1', size: 1 } },
    });
    const r = await h.release(CONN, 'ws', '');
    expect(r.total).toBe(0);
    expect(h.verifyCalls).toEqual([]);
  });

  it('ディレクトリは対象にしない', async () => {
    const h = load({
      state: { 'local/yachiyo/ws/dir': { kind: 'directory' } },
      hostFiles: {},
    });
    expect((await h.release(CONN, 'ws', '')).total).toBe(0);
  });

  it('部分パスを指定すると、その配下だけを対象にする', async () => {
    const h = load({
      state: {
        'local/yachiyo/ws/src/a.txt': file('A'),
        'local/yachiyo/ws/other/b.txt': file('B'),
      },
      hostFiles: { 'src/a.txt': { hash: 'A', size: 1 }, 'other/b.txt': { hash: 'B', size: 1 } },
    });
    const r = await h.release(CONN, 'ws', 'src');
    expect(r.released).toBe(1);
    expect(h.stubbed[0].path).toBe('local/yachiyo/ws/src/a.txt');
  });

  it('名前が前方一致するだけの隣を巻き込まない', async () => {
    const h = load({
      state: { 'local/yachiyo/ws/src_old/x.txt': file('X') },
      hostFiles: { 'src_old/x.txt': { hash: 'X', size: 1 } },
    });
    // 'src' を指定したときに 'src_old' が入ると、意図しないものを捨てる
    expect((await h.release(CONN, 'ws', 'src')).total).toBe(0);
  });

  it('大量のときは分割して確認し、進捗を返す', async () => {
    const state: Record<string, any> = {};
    const hostFiles: Record<string, { hash: string; size: number }> = {};
    for (let i = 0; i < 450; i++) {
      state[`local/yachiyo/ws/f${i}.txt`] = file(`H${i}`);
      hostFiles[`f${i}.txt`] = { hash: `H${i}`, size: 1 };
    }
    const h = load({ state, hostFiles });
    const seen: any[] = [];
    const r = await h.release(CONN, 'ws', '', (p) => seen.push(p));

    expect(r.released).toBe(450);
    // 1 回の verify に全件を載せない（ホストが計算し終えるまで何も返らなくなる）
    expect(h.verifyCalls.length).toBe(Math.ceil(450 / h.chunk));
    expect(Math.max(...h.verifyCalls.map((c) => c.length))).toBeLessThanOrEqual(h.chunk);
    expect(seen.length).toBe(h.verifyCalls.length);
    expect(seen[seen.length - 1]).toMatchObject({ done: 450, total: 450, released: 450 });
  });
});
