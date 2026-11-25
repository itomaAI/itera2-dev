/**
 * @vitest-environment jsdom
 * 配布物が許さないとき（ミャク楽: `GUEST_SAME_ORIGIN_SWITCH = false`）は、決して同一オリジンで起動しない（T-0838）。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/guest_origin_policy', () => ({ GUEST_SAME_ORIGIN_SWITCH: false }));

import { ProcessManager } from './ProcessManager';
import { GUEST_SANDBOX } from './guestSandbox';
import { USER_MOVER } from './processGate';

// 何のアプリかは登録簿から決まる（T-0903）。ここでは登録簿に無いパスを起こす
const REGISTRY = { getAllApps: () => [], getAllServices: () => [] };
const CONFIG = { homePath: () => 'system/apps/home.html' };

describe('ProcessManager — 配布物がスイッチを持たないとき（T-0838）', () => {
  it('外そうとすると断り、起動は opaque のまま', async () => {
    const pm = new ProcessManager({ releaseContent: async () => {} } as any, REGISTRY as any, CONFIG as any);
    (pm as any).compiler = { compile: () => new Promise(() => {}) };
    await expect(pm.setGuestSameOrigin(true)).rejects.toThrow(/not available/);
    expect(pm.isGuestSameOrigin()).toBe(false);
    void pm.spawn(USER_MOVER, { pid: 'd', path: 'system/services/d.html', type: 'daemon' });
    expect(pm.processes.get('d')!.iframe.getAttribute('sandbox')).toBe(GUEST_SANDBOX);
  });

  it('内部の状態が true にされても、旗は opaque（配布物の可否が最後に効く）', () => {
    const pm = new ProcessManager({ releaseContent: async () => {} } as any, REGISTRY as any, CONFIG as any);
    (pm as any).compiler = { compile: () => new Promise(() => {}) };
    (pm as any).guestSameOrigin = true;
    void pm.spawn(USER_MOVER, { pid: 'd', path: 'system/services/d.html', type: 'daemon' });
    expect(pm.processes.get('d')!.iframe.getAttribute('sandbox')).toBe(GUEST_SANDBOX);
  });
});
