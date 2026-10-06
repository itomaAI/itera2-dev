import { describe, it, expect, vi } from 'vitest';

/**
 * src/core/vfs/VfsInitializerPaths.test.ts
 * 起動時に paths.json / acl.json を読み、層と ACL をそこから決める（T-0614）。
 *
 *  1. 初回起動: 配信物の paths.json を先に読んで層を決め、配信したあと VFS の値で ACL を当てる
 *  2. AI の領域（agent.home）に agent-only の ACL がかかる。無い配布物（null）では何もかけない
 *  3. 利用者の書き先の層（user.config）は配信で上書きしない
 *  4. 配布物に paths.json が無ければ「何も知らない形」で起動し、ACL は system/ の守りだけ
 *  5. VFS の paths.json が壊れていれば配信物に落ちて理由を残す
 */

const PATHS = JSON.stringify({
  agent: { home: 'agentarea', init: 'agentarea/init.md', scratch: null },
  user: {
    home: 'userarea',
    config: 'userarea/config',
    registry: null,
    locales: null,
    appRegistry: null,
    sessions: null,
  },
});
const ACL = JSON.stringify({
  areas: [
    { path: 'system', policy: 'readonly' },
    { path: 'system/config', policy: 'open' },
    { ref: 'agent.home', policy: 'agent-only' },
    { ref: 'agent.scratch', policy: 'agent-shared' },
  ],
});

const FILES: Record<string, string> = {
  'system/': '',
  'system/config/paths.json': PATHS,
  'system/config/acl.json': ACL,
  'system/lib/x.js': 'LIB v2',
  'userarea/': '',
  'userarea/config/': '',
  'userarea/config/preferences.json': '{"username":"shipped"}',
  'agentarea/': '',
};

vi.mock('../../config/default_files', () => ({
  get DEFAULT_FILES() {
    return (globalThis as { __files?: Record<string, string> }).__files ?? {};
  },
}));

import { VfsInitializer } from './VfsInitializer';

function makeWorld(opts: { existing?: Record<string, string | null>; defaults?: Record<string, string> } = {}) {
  (globalThis as { __files?: Record<string, string> }).__files = opts.defaults ?? FILES;
  const dirs = new Set<string>();
  const files = new Map<string, string>();
  for (const [p, c] of Object.entries(opts.existing ?? {})) {
    if (c === null) dirs.add(p);
    else files.set(p, c);
  }
  const acl: Array<{ path: string; owner: string }> = [];
  const vfs = {
    exists: (_p: unknown, path: string) => dirs.has(path) || files.has(path),
    mkdir: async (_p: unknown, path: string) => {
      dirs.add(path);
      return path;
    },
    readFile: async (_p: unknown, path: string) => {
      if (!files.has(path)) throw new Error(`not found: ${path}`);
      return files.get(path)!;
    },
    writeFile: async (_p: unknown, path: string, content: string) => {
      files.set(path, content);
    },
    setAclRecursive: async (_p: unknown, path: string, a: { owner: { type: string } }) => {
      acl.push({ path, owner: a.owner.type });
    },
  };
  const nodeStore = { getNode: (id: string) => ({ kind: id.endsWith('/') ? 'directory' : 'file' }) };
  const pathResolver = {
    getIdByPath: (path: string) => (files.has(path) ? path : dirs.has(path) ? `${path}/` : undefined),
  };
  const initializer = new VfsInitializer(vfs as never, nodeStore as never, pathResolver as never);
  return { initializer, files, dirs, acl };
}

describe('VfsInitializer と paths.json / acl.json', () => {
  it('初回起動: 配信物から場所を知り、配信したあと VFS の値で ACL を当てる', async () => {
    const w = makeWorld();
    await w.initializer.initialize();

    expect(w.initializer.guestPaths.agent.home).toBe('agentarea');
    expect(w.initializer.guestPaths.user.config).toBe('userarea/config');
    // 配信したので 2 回目の読み取りは VFS のファイル
    expect(w.initializer.guestPathsSource).toBe('vfs');
    expect(w.initializer.areaAclSource).toBe('vfs');
    expect(w.initializer.distributionProblems).toEqual([]);
    expect(w.files.get('system/config/paths.json')).toBe(PATHS);

    // ACL: 宣言の順。agent.scratch は null なので飛ぶ
    expect(w.acl).toEqual([
      { path: 'system', owner: 'system' },
      { path: 'system/config', owner: 'system' },
      { path: 'agentarea', owner: 'agent' },
    ]);
  });

  it('利用者の書き先の層（user.config）は配信で上書きしない。配信が正の層は上書きする', async () => {
    const w = makeWorld({
      existing: {
        system: null,
        'system/config': null,
        'system/lib': null,
        'system/lib/x.js': 'LIB v1',
        'system/config/paths.json': PATHS,
        userarea: null,
        'userarea/config': null,
        'userarea/config/preferences.json': '{"username":"mine"}',
      },
    });
    await w.initializer.initialize();
    expect(w.files.get('system/lib/x.js')).toBe('LIB v2');
    expect(w.files.get('userarea/config/preferences.json')).toBe('{"username":"mine"}');
  });

  it('配布物に paths.json が無ければ「何も知らない形」。ACL は system/ の守りだけ', async () => {
    const w = makeWorld({ defaults: { 'system/': '', 'system/lib/x.js': 'LIB' } });
    await w.initializer.initialize();
    expect(w.initializer.guestPathsSource).toBe('none');
    expect(w.initializer.areaAclSource).toBe('none');
    expect(w.initializer.guestPaths.agent.home).toBeNull();
    expect(w.initializer.guestPaths.user.config).toBeNull();
    expect(w.acl.map((a) => a.path)).toEqual([
      'system',
      'system/config',
      'system/themes',
      'system/registry',
      'system/temp',
      'system/upstream',
      'system/credentials',
    ]);
    expect(w.acl.every((a) => a.owner === 'system')).toBe(true);
  });

  it('VFS の paths.json が壊れていれば配信物に落ちて、理由を残す（1 層の配布物: 書き先なので配信は直さない）', async () => {
    const oneLayer = JSON.stringify({ agent: { home: 'agentarea' }, user: { config: null } });
    const w = makeWorld({
      defaults: { 'system/': '', 'system/config/paths.json': oneLayer, 'agentarea/': '' },
      existing: { system: null, 'system/config': null, 'system/config/paths.json': '{ broken' },
    });
    await w.initializer.initialize();
    // 書き先の層（system/config）なので配信は上書きしない → 壊れたまま → 配信物の値で動く
    expect(w.files.get('system/config/paths.json')).toBe('{ broken');
    expect(w.initializer.guestPathsSource).toBe('defaults');
    expect(w.initializer.guestPaths.agent.home).toBe('agentarea');
    expect(w.initializer.distributionProblems.some((p) => /paths\.json: unreadable in VFS/.test(p))).toBe(true);
  });

  it('VFS の paths.json が壊れていても、2 層の配布物（system/config は配信が正）では配信が直す', async () => {
    const w = makeWorld({
      existing: { system: null, 'system/config': null, 'system/config/paths.json': '{ broken' },
    });
    await w.initializer.initialize();
    expect(w.files.get('system/config/paths.json')).toBe(PATHS);
    expect(w.initializer.guestPathsSource).toBe('vfs');
    expect(w.initializer.guestPaths.user.config).toBe('userarea/config');
    expect(w.initializer.distributionProblems.some((p) => /paths\.json: unreadable in VFS/.test(p))).toBe(true);
  });

  it('acl.json が壊れていれば組み込みの system/ の守りに落ちて、理由を残す', async () => {
    const w = makeWorld({ defaults: { ...FILES, 'system/config/acl.json': '{"areas": "nope"}' } });
    await w.initializer.initialize();
    expect(w.acl.map((a) => a.path)).toContain('system/credentials');
    expect(w.acl.map((a) => a.path)).not.toContain('agentarea');
    expect(w.initializer.distributionProblems).toEqual([
      'system/config/acl.json: acl.areas is not an array',
      'system/config/acl.json: no usable areas; applying the built-in system areas instead',
    ]);
  });
});
