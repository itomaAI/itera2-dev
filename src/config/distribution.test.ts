import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GUEST_PATH_REFS, normalizeGuestPaths } from '../core/sys/GuestPaths';
import { parseAreaAcl, resolveAreaAcl } from '../core/vfs/areaAcl';

/**
 * 配布物の形を決めるファイル（vfs_root/system/config/paths.json と acl.json。T-0614）が
 * 配信物に在って読めることを、ビルドの時点で止める。
 * 実行時は「無ければ何も知らない形」で起動するが、それは事故の受け皿であって配布の仕方ではない。
 */
const CONFIG_DIR = resolve(__dirname, '../../vfs_root/system/config');
const read = (name: string) => JSON.parse(readFileSync(resolve(CONFIG_DIR, name), 'utf8')) as unknown;

describe('配布物の paths.json', () => {
  it('在って、全部の値が整う（捨てられる値が無い）', () => {
    const r = normalizeGuestPaths(read('paths.json'));
    expect(r.problems).toEqual([]);
    // この配布物（itera2-dev）の形。変えるならここも変える（黙って変わらないための印）
    expect(r.paths.agent.home).toBe('memory');
    expect(r.paths.agent.init).toBe('memory/init.md');
    expect(r.paths.user.home).toBe('data');
    expect(r.paths.user.config).toBeNull();
    expect(r.paths.user.locales).toBe('user/locales');
  });
});

describe('配布物の acl.json', () => {
  it('在って、全部の行が通り、ref は paths.json の鍵を指す', () => {
    const acl = parseAreaAcl(read('acl.json'));
    expect(acl.problems).toEqual([]);
    for (const e of acl.entries) {
      if (e.ref) expect(GUEST_PATH_REFS).toContain(e.ref);
    }
    const paths = normalizeGuestPaths(read('paths.json')).paths;
    const r = resolveAreaAcl(acl.entries, paths);
    expect(r.problems).toEqual([]);
    // system/ が最初に閉じられ、AI の領域にだけ agent-only
    expect(r.areas[0]).toMatchObject({ path: 'system', policy: 'readonly' });
    expect(r.areas.filter((a) => a.policy === 'agent-only').map((a) => a.path)).toEqual(['memory']);
  });
});
