import { describe, it, expect } from 'vitest';
import { VfsService } from './VfsService';
import { VFS_HARD_LIMITS } from '../../config/constants';

/**
 * src/core/vfs/VfsServiceUsage.test.ts
 * getUsage() が配る容量の事実 — T-0354（ホームの使用量バー）
 *
 * ゲストへは `fs:get_usage` が used / max / reserved の 3 つだけを配る。
 * ここで押さえるのは「used は索引の総量そのまま」「reserved は checkQuota が差し引く数と同じ」の 2 点。
 * どちらかがずれると、ゲストの表示がシェルの容量表示や実際に書ける上限と食い違う。
 */
function makeService(totalSize: number) {
  const svc: any = Object.create(VfsService.prototype);
  svc.nodeStore = { getTotalSize: () => totalSize };
  return svc as VfsService;
}

describe('VfsService.getUsage', () => {
  it('used は索引の総量、max / reserved は定数そのまま', () => {
    const u = makeService(12345).getUsage();
    expect(u.used).toBe(12345);
    expect(u.max).toBe(VFS_HARD_LIMITS.MAX_STORAGE_BYTES);
    expect(u.reserved).toBe(VFS_HARD_LIMITS.SYSTEM_RESERVE_BYTES);
  });

  it('ゲストが書ける上限 max − reserved は正で、reserved は max より小さい', () => {
    const u = makeService(0).getUsage();
    expect(u.reserved).toBeGreaterThan(0);
    expect(u.max - u.reserved).toBeGreaterThan(0);
  });

  it('シェル向けの派生値（percent / isFull）は据え置き', () => {
    const half = makeService(VFS_HARD_LIMITS.MAX_STORAGE_BYTES / 2).getUsage();
    expect(half.percent).toBeCloseTo(50);
    expect(half.isFull).toBe(false);
    const full = makeService(VFS_HARD_LIMITS.MAX_STORAGE_BYTES).getUsage();
    expect(full.percent).toBe(100);
    expect(full.isFull).toBe(true);
  });
});
