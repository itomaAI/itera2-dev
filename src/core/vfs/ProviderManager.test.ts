/**
 * src/core/vfs/ProviderManager.test.ts
 * Itera OS v2: ProviderManager Echo Cancellation Test Suite
 *
 * 主眼は「同期デーモンの自己励起ループ」の回帰防止である。
 * エコーキャンセルの判定が type === 'app' に限定されていた頃は、
 * systemPrivilege を持つデーモン ({ type: 'system', id: pid }) の書き込みが
 * 自分自身へ通知され、アンカー保存 → 自己通知 → 再同期 → 保存 が
 * 永久に回り続けていた。最初のテストはその状態では FAIL する。
 */

import { describe, it, expect } from 'vitest';
import { ProviderManager } from './ProviderManager';
import { VfsEventBus } from './VfsEventBus';
import type { Principal, VfsMutation } from './types';

interface SentEvent {
  pid: string;
  event: string;
  payload: { mutations: VfsMutation[] };
}

function setup() {
  const eventBus = new VfsEventBus();
  const sent: SentEvent[] = [];

  // 担当プロセスへの道（ProcessManager の代わり）。届くのは registerProcess した pid だけ ——
  // 届かない相手への知らせが何も起こさないのは、ProcessManager の側の規則（ProcessManager.gate.test.ts）
  const live = new Set<string>();
  const registerProcess = (pid: string) => {
    live.add(pid);
  };
  const processes = {
    isReachable: (pid: string) => live.has(pid),
    notify: (pid: string, event: string, payload: any) => {
      if (live.has(pid)) sent.push({ pid, event, payload });
    },
    request: async (..._args: any[]): Promise<unknown> => {
      throw new Error('request is not stubbed');
    },
  };

  const pathResolver = {
    normalizePath: (p: string) => (p || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
  };

  const manager = new ProviderManager(eventBus, processes, pathResolver as any);

  // origin（個体の印）を省くと主体の id（主体だけで書く者の既定。T-0903）
  const publish = (path: string, sourcePrincipal: Principal, origin: string = sourcePrincipal.id) => {
    eventBus.publish({
      type: 'MUTATE',
      nodeId: 'node_test',
      node: null,
      path,
      sourcePrincipal,
      origin,
    });
  };

  return { eventBus, manager, sent, registerProcess, publish };
}

describe('ProviderManager echo cancellation', () => {
  it('does NOT notify a system-privileged daemon of its own write (infinite sync loop regression)', () => {
    const ctx = setup();
    const pid = 'gdrive_sync_daemon';
    ctx.registerProcess(pid);
    ctx.manager.registerProvider('', pid); // ルートマウント
    ctx.eventBus.clear(); // 登録時のダミー MUTATE を捨てる

    // 同期デーモンによるアンカー保存。systemPrivilege により type は 'system' になる。
    ctx.publish('system/temp/sync_anchor.json', { type: 'system', id: pid });
    ctx.eventBus.flushNow();

    // これが配送されると onMutate -> triggerSync -> saveAnchor が永久に回る。
    expect(ctx.sent).toHaveLength(0);
  });

  it('does NOT notify a normal app provider of its own write (pre-existing behavior)', () => {
    const ctx = setup();
    const pid = 'some_app_provider';
    ctx.registerProcess(pid);
    ctx.manager.registerProvider('drive', pid);
    ctx.eventBus.clear();

    ctx.publish('drive/notes.md', { type: 'app', id: pid });
    ctx.eventBus.flushNow();

    expect(ctx.sent).toHaveLength(0);
  });

  it('judges by the individual (origin), not by the principal: own write under an app-derived principal is not echoed (T-0903)', () => {
    const ctx = setup();
    const pid = 'sync_daemon-2'; // 同じ同期デーモンの 2 つ目の個体。主体はアプリ（sync_daemon）から決まる
    ctx.registerProcess(pid);
    ctx.manager.registerProvider('drive', pid);
    ctx.eventBus.clear();

    ctx.publish('drive/notes.md', { type: 'system', id: 'sync_daemon' }, pid);
    ctx.eventBus.flushNow();

    expect(ctx.sent).toHaveLength(0);
  });

  it('notifies the provider of a write by another individual of the same app (same principal, different origin) (T-0903)', () => {
    const ctx = setup();
    const pid = 'sync_daemon-2';
    ctx.registerProcess(pid);
    ctx.manager.registerProvider('drive', pid);
    ctx.eventBus.clear();

    ctx.publish('drive/notes.md', { type: 'system', id: 'sync_daemon' }, 'sync_daemon');
    // 主体の id が pid と同じ字面でも、起こした個体が別なら届く
    ctx.publish('drive/other.md', { type: 'app', id: pid }, 'someone_else');
    ctx.eventBus.flushNow();

    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0].payload.mutations.map((m) => m.path)).toEqual(['drive/notes.md', 'drive/other.md']);
  });

  it('still notifies the provider of changes made by other principals', () => {
    const ctx = setup();
    const pid = 'gdrive_sync_daemon';
    ctx.registerProcess(pid);
    ctx.manager.registerProvider('', pid);
    ctx.eventBus.clear();

    ctx.publish('data/report.md', { type: 'user', id: 'local_user' });
    ctx.publish('data/memo.md', { type: 'agent', id: 'Itera_AI' });
    ctx.publish('data/tool.md', { type: 'app', id: 'notes_app' });
    ctx.eventBus.flushNow();

    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0].pid).toBe(pid);
    expect(ctx.sent[0].event).toBe('sync:onMutate');
    expect(ctx.sent[0].payload.mutations).toHaveLength(3);
  });

  it("still notifies the provider of the kernel's changes (id 'kernel' must not collide with a pid)", () => {
    const ctx = setup();
    const pid = 'gdrive_sync_daemon';
    ctx.registerProcess(pid);
    ctx.manager.registerProvider('', pid);
    ctx.eventBus.clear();

    ctx.publish('data/x.md', { type: 'system', id: 'kernel' });
    ctx.eventBus.flushNow();

    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0].payload.mutations[0].path).toBe('data/x.md');
  });

  it('notifies the root provider of another daemon write that falls outside that daemon own mount', () => {
    const ctx = setup();
    const rootPid = 'root_sync_daemon';
    const drivePid = 'gdrive_sync_daemon';
    ctx.registerProcess(rootPid);
    ctx.registerProcess(drivePid);
    ctx.manager.registerProvider('', rootPid);
    ctx.manager.registerProvider('drive', drivePid);
    ctx.eventBus.clear();

    // Drive デーモンのアンカーは drive/ の外にあるため、ルートデーモンの管轄になる。
    // 発生元 pid が異なるので、これは抑止されない（相互通知は正常）。
    ctx.publish('system/temp/sync_anchor_drive.json', { type: 'system', id: drivePid });
    ctx.eventBus.flushNow();

    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0].pid).toBe(rootPid);
  });

  it('routes a drive/ mutation to the drive provider by longest-prefix match', () => {
    const ctx = setup();
    const rootPid = 'root_sync_daemon';
    const drivePid = 'gdrive_sync_daemon';
    ctx.registerProcess(rootPid);
    ctx.registerProcess(drivePid);
    ctx.manager.registerProvider('', rootPid);
    ctx.manager.registerProvider('drive', drivePid);
    ctx.eventBus.clear();

    ctx.publish('drive/team/spec.md', { type: 'user', id: 'local_user' });
    ctx.eventBus.flushNow();

    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0].pid).toBe(drivePid);
  });
});

describe('ProviderManager listMounts', () => {
  it('returns all registered mounts', () => {
    const ctx = setup();
    ctx.manager.registerProvider('', 'root_sync_daemon');
    ctx.manager.registerProvider('drive', 'gdrive_sync_daemon');

    const mounts = ctx.manager.listMounts();
    expect(mounts).toHaveLength(2);
    expect(mounts.map((m) => m.mountPath).sort()).toEqual(['', 'drive']);
  });

  it('drops a mount after unregister', () => {
    const ctx = setup();
    ctx.manager.registerProvider('drive', 'gdrive_sync_daemon');
    ctx.manager.unregisterProvider('drive');

    expect(ctx.manager.listMounts()).toHaveLength(0);
  });

  it('returns copies so that callers cannot mutate the internal mount table', () => {
    const ctx = setup();
    ctx.manager.registerProvider('drive', 'gdrive_sync_daemon');

    const mounts = ctx.manager.listMounts();
    mounts[0].mountPath = 'tampered';

    expect(ctx.manager.listMounts()[0].mountPath).toBe('drive');
  });
});

describe('ProviderManager capabilities / moveContent（T-0689）', () => {
  it('registerProvider は申し出を持ち、既定は move: false。listMounts に出る', () => {
    const ctx = setup();
    ctx.manager.registerProvider('', 'root_sync_daemon');
    ctx.manager.registerProvider('drive', 'gdrive_sync_daemon', { move: true });

    const byPath = Object.fromEntries(ctx.manager.listMounts().map((m) => [m.mountPath, m.capabilities]));
    expect(byPath['']).toEqual({ move: false });
    expect(byPath['drive']).toEqual({ move: true });
  });

  it('listMounts の capabilities は写し（外から書いても表は変わらない）', () => {
    const ctx = setup();
    ctx.manager.registerProvider('drive', 'gdrive_sync_daemon', { move: true });
    ctx.manager.listMounts()[0].capabilities.move = false;
    expect(ctx.manager.listMounts()[0].capabilities.move).toBe(true);
  });

  it('move を申し出ていないプロバイダには頼まず false', async () => {
    const ctx = setup();
    ctx.registerProcess('sync');
    ctx.manager.registerProvider('', 'sync');
    const calls: any[] = [];
    (ctx.manager as any).processes.request = async (...args: any[]) => {
      calls.push(args);
      return true;
    };
    expect(await ctx.manager.moveContent('a', 'b')).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('申し出があり生きていれば fs:move_content を頼み、true のときだけ true', async () => {
    const ctx = setup();
    ctx.registerProcess('sync');
    ctx.manager.registerProvider('', 'sync', { move: true });
    const calls: any[] = [];
    (ctx.manager as any).processes.request = async (pid: string, name: string, payload: any) => {
      calls.push([pid, name, payload]);
      return payload.oldPath === 'ok/x' ? true : 'not-a-boolean';
    };
    expect(await ctx.manager.moveContent('ok/x', 'ok/y')).toBe(true);
    expect(await ctx.manager.moveContent('ng/x', 'ng/y')).toBe(false);
    expect(calls).toEqual([
      ['sync', 'fs:move_content', { oldPath: 'ok/x', newPath: 'ok/y' }],
      ['sync', 'fs:move_content', { oldPath: 'ng/x', newPath: 'ng/y' }],
    ]);
  });

  it('担当が死んでいれば頼まず false（登録は残る）', async () => {
    const ctx = setup();
    ctx.manager.registerProvider('', 'sync', { move: true });
    (ctx.manager as any).processes.request = async () => {
      throw new Error('should not be called');
    };
    expect(await ctx.manager.moveContent('a', 'b')).toBe(false);
  });

  it('向こうが例外を投げたら false（何も変えていないと読む）', async () => {
    const ctx = setup();
    ctx.registerProcess('sync');
    ctx.manager.registerProvider('', 'sync', { move: true });
    (ctx.manager as any).processes.request = async () => {
      throw new Error('remote move failed');
    };
    expect(await ctx.manager.moveContent('a', 'b')).toBe(false);
  });
});
