import { describe, it, expect, vi } from 'vitest';

/**
 * src/core/vfs/VfsInitializerResilience.test.ts
 * 起動時の配信の耐性 — T-0380（1 件の書き込み失敗で起動を止めない）
 *
 * 押さえるのは 3 点。
 *  1. upstream/ や既定ファイルの 1 件が書けなくても initialize() は投げず、残りを置いて failures に残す
 *  2. 初回起動で 1 件も置けなければ投げる（この先が全部落ちるので、ここで止めた方が原因が見える）
 *  3. 2 回目以降の起動なら全部失敗しても投げない（前回の実体で動ける）
 */

vi.mock('../../config/default_files', () => ({
  DEFAULT_FILES: {
    'system/': '',
    'system/a.txt': 'A',
    'system/b.txt': 'B',
  },
}));

import { VfsInitializer } from './VfsInitializer';

function makeWorld(opts: { existing?: string[]; failWrite?: (path: string) => boolean }) {
  const dirs = new Set(opts.existing ?? []);
  const files = new Map<string, string>();
  const failWrite = opts.failWrite ?? (() => false);
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
      if (failWrite(path)) throw new Error('OPFS Write Error: state changed');
      files.set(path, content);
    },
    setAclRecursive: async () => {},
  };
  const nodeStore = { getNode: () => undefined };
  const pathResolver = { getIdByPath: (path: string) => (files.has(path) ? 'id' : undefined) };
  const initializer = new VfsInitializer(vfs as never, nodeStore as never, pathResolver as never);
  return { initializer, files, dirs };
}

describe('VfsInitializer.initialize の耐性', () => {
  it('1 件が書けなくても投げず、残りを置いて failures に残す', async () => {
    const w = makeWorld({ failWrite: (p) => p.endsWith('a.txt') });
    await expect(w.initializer.initialize()).resolves.toBeUndefined();

    expect(w.files.get('system/b.txt')).toBe('B');
    expect(w.files.get('system/upstream/system/b.txt')).toBe('B');
    expect(w.files.has('system/a.txt')).toBe(false);
    expect(w.initializer.failures.map((f) => f.path)).toEqual(['system/a.txt']);
  });

  it('初回起動で 1 件も置けなければ投げる（最初の失敗を含めて）', async () => {
    const w = makeWorld({ failWrite: () => true });
    await expect(w.initializer.initialize()).rejects.toThrow(/nothing could be written.*system\/a\.txt.*state changed/);
  });

  it('2 回目以降の起動なら全部失敗しても投げない', async () => {
    const w = makeWorld({ existing: ['system'], failWrite: () => true });
    await expect(w.initializer.initialize()).resolves.toBeUndefined();
    expect(w.initializer.failures.length).toBe(2);
  });

  it('失敗が無ければ failures は空', async () => {
    const w = makeWorld({});
    await w.initializer.initialize();
    expect(w.initializer.failures).toEqual([]);
    expect(w.files.size).toBe(4);
  });
});
