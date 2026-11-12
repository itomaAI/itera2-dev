/**
 * @vitest-environment jsdom
 * ゲストとホストの境界のスイッチ（T-0838）。
 * - 既定は opaque。状態はメモリだけ（ProcessManager を作り直せば必ず opaque）。
 * - 切り替えると走っているゲストを全部起動し直す。前面のアプリは最後に、引数と URI はそのまま。
 * - 切り替える口は人の画面（DesktopEnvironment）だけ。ホストの API・道具からは呼ばない。
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { ProcessManager } from './ProcessManager';
import { GUEST_SANDBOX, GUEST_SANDBOX_SAME_ORIGIN } from './guestSandbox';

function mk() {
  const vfs = { releaseContent: async () => {} };
  const registry = { getAllApps: () => [], getAllServices: () => [] };
  const pm = new ProcessManager(vfs as any, registry as any, { homePath: () => 'system/apps/home.html' } as any);
  // compile は終わらせない（iframe ができるところまでを見る）
  (pm as any).compiler = { compile: () => new Promise(() => {}) };
  return pm;
}

function proc(pid: string, state: string, extra: Record<string, unknown> = {}) {
  return {
    pid,
    path: `system/apps/${pid}.html`,
    type: state === 'running' ? 'daemon' : 'app',
    state,
    iframe: null as any,
    boot: { abandon() {} } as any,
    lastActiveTime: 0,
    currentUri: `metaos://run/system/apps/${pid}.html`,
    ...extra,
  } as any;
}

describe('ProcessManager — ゲストとホストの境界（T-0838）', () => {
  it('既定は opaque で起動する', () => {
    const pm = mk();
    expect(pm.isGuestSameOrigin()).toBe(false);
    void pm.spawn({ pid: 'd', path: 'system/services/d.html', type: 'daemon' });
    expect(pm.processes.get('d')!.iframe.getAttribute('sandbox')).toBe(GUEST_SANDBOX);
    expect(pm.sameOriginPids()).toEqual([]);
  });

  it('外すと同一オリジンで起動し直し、戻すと opaque で起動し直す', () => {
    const pm = mk();
    void pm.spawn({ pid: 'd', path: 'system/services/d.html', type: 'daemon' });
    // setGuestSameOrigin は起動の終わりまで待つので、待たずに iframe を見る
    void pm.setGuestSameOrigin(true);
    expect(pm.isGuestSameOrigin()).toBe(true);
    expect(pm.processes.get('d')!.iframe.getAttribute('sandbox')).toBe(GUEST_SANDBOX_SAME_ORIGIN);
    expect(pm.sameOriginPids()).toEqual(['d']);
    void pm.setGuestSameOrigin(false);
    expect(pm.isGuestSameOrigin()).toBe(false);
    expect(pm.processes.get('d')!.iframe.getAttribute('sandbox')).toBe(GUEST_SANDBOX);
    expect(pm.sameOriginPids()).toEqual([]);
  });

  it('作り直した ProcessManager は opaque（状態を保存しない）', () => {
    const a = mk();
    void a.setGuestSameOrigin(true);
    expect(a.isGuestSameOrigin()).toBe(true);
    expect(mk().isGuestSameOrigin()).toBe(false);
  });

  it('全部を起動し直す。前面のアプリは最後に、引数と URI はそのまま', async () => {
    const pm = mk();
    pm.processes.set(
      'front',
      proc('front', 'foreground', { args: { file: 'a.md' }, currentUri: 'metaos://run/x?view=1' }),
    );
    pm.processes.set('back', proc('back', 'background'));
    pm.processes.set('svc', proc('svc', 'running'));
    const calls: any[] = [];
    vi.spyOn(pm, 'spawn').mockImplementation(async (o) => {
      calls.push(o);
    });
    const seen: boolean[] = [];
    pm.on('guest_origin_changed', (on: boolean) => seen.push(on));
    await pm.setGuestSameOrigin(true);
    expect(calls.map((c) => c.pid)).toEqual(['back', 'svc', 'front']);
    expect(calls.every((c) => c.forceReload === true)).toBe(true);
    expect(calls.map((c) => c.show)).toEqual([false, false, true]);
    expect(calls[2]).toMatchObject({ type: 'app', args: { file: 'a.md' }, currentUri: 'metaos://run/x?view=1' });
    expect(calls[1]).toMatchObject({ type: 'daemon', path: 'system/apps/svc.html' });
    expect(seen).toEqual([true]);
  });
});

describe('前面のアプリを表示つきで起動し直す（T-0838 で見つけた）', () => {
  it('前面のホームだけが居るとき、起動し直しても iframe は 1 つ', () => {
    const pm = mk();
    const container = document.createElement('div');
    (pm as any).els.APPS_CONTAINER = container;
    void pm.spawn({ pid: 'home', path: 'system/apps/home.html', type: 'app', show: true });
    expect(pm.processes.get('home')!.state).toBe('foreground');
    void pm.spawn({ pid: 'home', path: 'system/apps/home.html', type: 'app', show: true, forceReload: true });
    expect(container.querySelectorAll('iframe').length).toBe(1);
    expect(pm.processes.get('home')!.iframe.parentElement).toBe(container);
    expect(pm.processes.get('home')!.state).toBe('foreground');
  });

  it('表示しない起動し直しでは、従来どおり前面を残りのアプリへ渡す', () => {
    const pm = mk();
    const container = document.createElement('div');
    (pm as any).els.APPS_CONTAINER = container;
    void pm.spawn({ pid: 'a', path: 'system/apps/a.html', type: 'app', show: true });
    void pm.spawn({ pid: 'b', path: 'system/apps/b.html', type: 'app', show: true });
    void pm.spawn({ pid: 'b', path: 'system/apps/b.html', type: 'app', show: false, forceReload: true });
    expect(pm.processes.get('a')!.state).toBe('foreground');
    expect(container.querySelectorAll('iframe').length).toBe(2);
  });
});

describe('切り替える口は人の画面だけ（T-0838）', () => {
  it('setGuestSameOrigin を呼ぶのは DesktopEnvironment だけ', () => {
    const root = resolve(__dirname, '../..');
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|js)$/.test(name) && !/\.test\.ts$/.test(name) && !/default_files/.test(name)) {
          if (readFileSync(p, 'utf-8').includes('setGuestSameOrigin(')) hits.push(relative(root, p));
        }
      }
    };
    walk(root);
    expect(hits.sort()).toEqual(['shell/core/DesktopEnvironment.ts', 'shell/windowing/ProcessManager.ts']);
  });
});
