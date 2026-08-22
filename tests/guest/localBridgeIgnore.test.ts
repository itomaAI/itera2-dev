/**
 * tests/guest/localBridgeIgnore.test.ts
 * Local Bridge の無視パターンと、無視対象になった既存項目の掃除（T-0059）
 *
 * 対象は `vfs_root/system/services/local_bridge.html`（ゲスト実装）。
 * vitest の対象外なので、**実装をコピーせずソースから取り出して評価する**。
 * （コピーすると、コピーだけが正しくて本体が壊れている状態を検出できない。）
 *
 * ここで守るのは二点:
 *   1. 無視パターンは「全体の既定 ∪ 接続ごと ∪ ルートごと」の和で効く。
 *   2. **掃除が消してよいのはスタブだけ。** 実体化済みのファイルと、ホスト側は触らない。
 *
 * 掃除は「消す」操作であり、対象は数万件になりうる。取り違えれば利用者のファイルが失われる。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE_PATH = resolve(__dirname, '../../vfs_root/system/services/local_bridge.html');
const SRC = readFileSync(SOURCE_PATH, 'utf-8');

/** ソースから断片を切り出す。取り出せなければ**失敗させる**（黙って素通りさせない）。 */
function extract(re: RegExp, label: string): string {
  const m = SRC.match(re);
  if (!m) {
    throw new Error(
      `local_bridge.html から ${label} を取り出せなかった。実装の書き方が変わった可能性がある。` +
        '試験を通す前に、まず対象を確認すること。',
    );
  }
  return m[0];
}

const globSrc = extract(/function globToRegex\(glob\) \{[\s\S]*?\n {8}\}/, 'globToRegex');
const compileSrc = extract(/function compileIgnorePatterns\(patterns\) \{[\s\S]*?\n {8}\}/, 'compileIgnorePatterns');
const isIgnoredSrc = extract(/function isIgnoredCompiled\(rel, compiled\) \{[\s\S]*?\n {8}\}/, 'isIgnoredCompiled');
const patternsForSrc = extract(/function ignorePatternsFor\(conn, root\) \{[\s\S]*?\n {8}\}/, 'ignorePatternsFor');
const compiledForSrc = extract(
  /const ignoreCache = new Map\(\);\n {8}function compiledIgnoreFor\(conn, root\) \{[\s\S]*?\n {8}\}/,
  'compiledIgnoreFor',
);
const isStubSrc = extract(/const isStub = \(info\) => [^\n]+/, 'isStub');
const cleanupSrc = extract(/async function ignoreCleanup\(mount, opts\) \{[\s\S]*?\n {8}\}/, 'ignoreCleanup');

const COMMON = `${globSrc}\n${compileSrc}\n${isIgnoredSrc}\n${patternsForSrc}\n${compiledForSrc}\n${isStubSrc}\n`;

/** 無視の解決だけを取り出す（config を差し替えられる形で）。 */
function loadIgnore(config: any) {
  const factory = new Function(
    'config',
    `${COMMON}\nreturn { ignorePatternsFor, compiledIgnoreFor, isIgnoredCompiled };`,
  );
  return factory(config);
}

interface Harness {
  cleanup: (mount: any, opts?: any) => Promise<any>;
  deleted: string[];
  saved: Record<string, any> | null;
  saveCalls: number;
}

/** 実物の ignoreCleanup を、外側の依存だけ差し替えて取り出す。 */
function load(opts: {
  config: any;
  state: Record<string, any>;
  anchor: Record<string, any>;
  failDelete?: string[];
}): Harness {
  const deleted: string[] = [];
  const h: Harness = { cleanup: null as any, deleted, saved: null, saveCalls: 0 };
  const state = { ...opts.state };

  const MetaOS = {
    fs: {
      getSyncState: async () => state,
      delete: async (path: string) => {
        if (opts.failDelete && opts.failDelete.includes(path)) throw new Error('使用中');
        deleted.push(path);
        delete state[path];
      },
    },
  };

  const loadAnchor = async () => ({ entries: { ...opts.anchor }, broken: false, identity: null });
  const saveAnchor = async (_c: any, _r: string, _p: any, entries: Record<string, any>) => {
    h.saved = entries;
    h.saveCalls++;
  };

  const factory = new Function(
    'config',
    'MetaOS',
    'loadAnchor',
    'saveAnchor',
    `${COMMON}\n${cleanupSrc}\nreturn ignoreCleanup;`,
  );
  h.cleanup = factory(opts.config, MetaOS, loadAnchor, saveAnchor);
  return h;
}

const MOUNT = { conn: { name: 'kukuri' }, root: 'ds', mountPath: 'local/kukuri/ds', rootPath: '/home/u/ds' };
const stub = (hash: string) => ({ kind: 'file', hash, syncState: 'stub' });
const real = (hash: string) => ({ kind: 'file', hash });
const dir = () => ({ kind: 'directory' });

describe('無視パターンの解決: 全体 ∪ 接続 ∪ ルート', () => {
  it('3 つの層が和で効く', () => {
    const m = loadIgnore({ ignorePatterns: ['node_modules'] });
    const conn = { name: 'kukuri', ignorePatterns: ['*.png'], roots: { ds: { ignorePatterns: ['patches'] } } };
    expect(m.ignorePatternsFor(conn, 'ds')).toEqual(['node_modules', '*.png', 'patches']);
  });

  it('別のルートには、そのルートのパターンは効かない', () => {
    const m = loadIgnore({ ignorePatterns: [] });
    const conn = { name: 'kukuri', roots: { ds: { ignorePatterns: ['patches'] } } };
    expect(m.ignorePatternsFor(conn, 'other')).toEqual([]);
  });

  it('接続ごとの設定は、全体の既定を弱められない（和なので消せない）', () => {
    const m = loadIgnore({ ignorePatterns: ['node_modules'] });
    const conn = { name: 'kukuri', ignorePatterns: [] };
    const compiled = m.compiledIgnoreFor(conn, 'ds');
    expect(m.isIgnoredCompiled('a/node_modules/b.js', compiled)).toBe(true);
  });

  it('パターンを書き換えると、次の呼び出しで効き目が変わる（キャッシュが古い規則を握らない）', () => {
    const config = { ignorePatterns: [] as string[] };
    const m = loadIgnore(config);
    const conn = { name: 'kukuri' };
    expect(m.isIgnoredCompiled('data/x.png', m.compiledIgnoreFor(conn, 'ds'))).toBe(false);
    config.ignorePatterns.push('data');
    expect(m.isIgnoredCompiled('data/x.png', m.compiledIgnoreFor(conn, 'ds'))).toBe(true);
  });
});

describe('ignoreCleanup: 消してよいものだけ消す', () => {
  const config = { ignorePatterns: ['data'] };

  it('無視対象のスタブを消し、アンカーからも落とす', async () => {
    const h = load({
      config,
      state: { 'local/kukuri/ds/data/a.png': stub('A'), 'local/kukuri/ds/src/b.ts': stub('B') },
      anchor: { 'data/a.png': { hash: 'A' }, 'src/b.ts': { hash: 'B' } },
    });
    const r = await h.cleanup(MOUNT, {});
    expect(h.deleted).toEqual(['local/kukuri/ds/data/a.png']);
    expect(r.removed).toBe(1);
    expect(Object.keys(h.saved!)).toEqual(['src/b.ts']);
  });

  it('実体化済みのファイルは、無視対象でも消さない', async () => {
    const h = load({
      config,
      state: { 'local/kukuri/ds/data/keep.csv': real('K') },
      anchor: { 'data/keep.csv': { hash: 'K' } },
    });
    const r = await h.cleanup(MOUNT, {});
    expect(h.deleted).toEqual([]);
    expect(r.keptTotal).toBe(1);
    expect(h.saved).toEqual({ 'data/keep.csv': { hash: 'K' } });
  });

  it('実体化済みを含むディレクトリは消さない（巻き添えにしない）', async () => {
    const h = load({
      config,
      state: {
        'local/kukuri/ds/data': dir(),
        'local/kukuri/ds/data/keep.csv': real('K'),
        'local/kukuri/ds/data/gone.png': stub('G'),
      },
      anchor: { data: { kind: 'directory' }, 'data/keep.csv': { hash: 'K' }, 'data/gone.png': { hash: 'G' } },
    });
    await h.cleanup(MOUNT, {});
    expect(h.deleted).toEqual(['local/kukuri/ds/data/gone.png']);
    expect(Object.keys(h.saved!).sort()).toEqual(['data', 'data/keep.csv']);
  });

  it('中身がスタブだけのディレクトリは、中身を消したあとで消す', async () => {
    const h = load({
      config,
      state: {
        'local/kukuri/ds/data': dir(),
        'local/kukuri/ds/data/sub': dir(),
        'local/kukuri/ds/data/sub/a.png': stub('A'),
      },
      anchor: { data: {}, 'data/sub': {}, 'data/sub/a.png': { hash: 'A' } },
    });
    await h.cleanup(MOUNT, {});
    expect(h.deleted).toEqual(['local/kukuri/ds/data/sub/a.png', 'local/kukuri/ds/data/sub', 'local/kukuri/ds/data']);
    expect(h.saved).toEqual({});
  });

  it('消せなかったものが下にあるディレクトリは消さない', async () => {
    const h = load({
      config,
      state: { 'local/kukuri/ds/data': dir(), 'local/kukuri/ds/data/busy.png': stub('B') },
      anchor: { data: {}, 'data/busy.png': { hash: 'B' } },
      failDelete: ['local/kukuri/ds/data/busy.png'],
    });
    const r = await h.cleanup(MOUNT, {});
    expect(h.deleted).toEqual([]);
    expect(r.failed[0]).toContain('data/busy.png');
    expect(Object.keys(h.saved!).sort()).toEqual(['data', 'data/busy.png']);
  });

  it('VFS に居ないのにアンカーにだけ残っている残骸も落とす', async () => {
    const h = load({ config, state: {}, anchor: { 'data/old.png': { hash: 'O' }, 'src/a.ts': { hash: 'A' } } });
    const r = await h.cleanup(MOUNT, {});
    expect(r.anchorOnly).toBe(1);
    expect(Object.keys(h.saved!)).toEqual(['src/a.ts']);
  });

  it('dryRun は何も消さず、アンカーも書かない', async () => {
    const h = load({
      config,
      state: { 'local/kukuri/ds/data/a.png': stub('A'), 'local/kukuri/ds/data': dir() },
      anchor: { data: {}, 'data/a.png': { hash: 'A' } },
    });
    const r = await h.cleanup(MOUNT, { dryRun: true });
    expect(r.total).toBe(2);
    expect(r.removed).toBe(0);
    expect(h.deleted).toEqual([]);
    expect(h.saveCalls).toBe(0);
  });

  it('パターンが 1 つも無いときは何もしない（空の設定で全消ししない）', async () => {
    const h = load({
      config: { ignorePatterns: [] },
      state: { 'local/kukuri/ds/data/a.png': stub('A') },
      anchor: { 'data/a.png': { hash: 'A' } },
    });
    const r = await h.cleanup(MOUNT, {});
    expect(r.total).toBe(0);
    expect(h.deleted).toEqual([]);
    expect(h.saveCalls).toBe(0);
  });

  it('マウントの外にある項目は対象にしない', async () => {
    const h = load({
      config,
      state: { 'local/kukuri/other/data/a.png': stub('A') },
      anchor: {},
    });
    const r = await h.cleanup(MOUNT, {});
    expect(h.deleted).toEqual([]);
    expect(r.total).toBe(0);
  });
});

describe('ホスト側には触らない（源に対する検査）', () => {
  it('ignoreCleanup は通信を行わない', () => {
    expect(cleanupSrc).not.toMatch(/fetch\(/);
    expect(cleanupSrc).not.toMatch(/getJson\(/);
    expect(cleanupSrc).not.toMatch(/method: 'DELETE'/);
  });
});
