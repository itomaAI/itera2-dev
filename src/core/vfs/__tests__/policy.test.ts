import { VFS_POLICY } from '../policy';

describe('VFS_POLICY', () => {
  it('detects permanent delete paths', () => {
    expect(VFS_POLICY.isPermanentDelete('trash')).toBe(true);
    expect(VFS_POLICY.isPermanentDelete('trash/foo')).toBe(true);
    expect(VFS_POLICY.isPermanentDelete('system/temp')).toBe(true);
    expect(VFS_POLICY.isPermanentDelete('system/logs/2026.json')).toBe(true);
    expect(VFS_POLICY.isPermanentDelete('apps/home.html')).toBe(false);
  });
});