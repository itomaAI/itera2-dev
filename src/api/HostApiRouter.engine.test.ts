// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import bridgeSource from './guest_bridge.js?raw';
import { HostApiRouter } from './HostApiRouter';
import type { EngineTable, OwnerNotice } from './EngineCalls';

/**
 * src/api/HostApiRouter.engine.test.ts
 * engine:* の配線（T-0908）。規則そのものは EngineCalls.test.ts・chatPost.test.ts。ここで見るのは、つなぎ目:
 *   - ゲストの取っ手（guest_bridge.js）が送る口と、ホストが受ける口が、過不足なく同じ
 *   - 呼び手は、プロセスの記録から決めた主体と pid
 *   - 知らせは、持ち主のプロセスの窓にだけ送る
 *   - chat:append は、前と同じく「呼んだプロセスが仕えるエンジン」に置く（同じ手順を通すようにした）
 * 送受の偽物: transport は登録された口を表に取るだけ。束の表は「viewer が eng-1 を持っている」だけを知る。
 */

const PROTOCOL = 'itera:ipc:v2';
const VIEWER = { type: 'app', id: 'viewer_app' };

function fakeBundle(turnId: string) {
  return {
    afterReset: 'Continue as told.',
    post: vi.fn(async (role: string, content: any, meta: any) => ({ id: turnId, timestamp: 1, role, content, meta })),
    wake: vi.fn(),
    stop: vi.fn(),
    reset: vi.fn(async (_options: any) => ({ archived: false, sessionId: 's2' })),
    statusInput: vi.fn(async () => ({
      engine: { running: false, busy: false, outstandingTools: 0 },
      turns: [],
      session: null,
      contextLimit: null,
    })),
    tools: {},
  };
}

function world(options: { engines?: boolean } = {}) {
  const handlers = new Map<string, (payload: any, sourcePid: string) => Promise<any>>();
  const sendEvent = vi.fn();
  const transport = {
    registerHandler: (action: string, handler: any) => handlers.set(action, handler),
    sendEvent,
  };
  const viewerWindow = { tag: 'window-of-viewer' };
  const processes = new Map<string, any>([
    ['viewer', { pid: 'viewer', app: 'viewer_app', path: 'apps/viewer.html', iframe: { contentWindow: viewerWindow } }],
    ['windowless', { pid: 'windowless', app: 'daemon_app', path: 'services/d.html', iframe: null }],
  ]);

  const rootBundle = fakeBundle('root-turn');
  const engine = {
    id: 'eng-1',
    bundle: fakeBundle('sub-turn'),
    conversation: {
      history: { get: () => [{ id: 't1', timestamp: 1, role: 'user', content: 'x', meta: {} }] },
      save: vi.fn(async (dir: string, _principal: any) => ({ path: dir, media: 0 })),
    },
  };
  const listeners: Array<(notice: OwnerNotice) => void> = [];
  const table = {
    create: vi.fn(async (_owner: any, _spec: any) => engine),
    of: vi.fn((ownerPid: string, id: string) => {
      if (ownerPid !== 'viewer' || id !== 'eng-1') throw new Error(`Engine "${id}" not found.`);
      return engine;
    }),
    owned: vi.fn((ownerPid: string) => (ownerPid === 'viewer' ? [engine] : [])),
    dispose: vi.fn(async (_id: string, _reason?: string) => true),
    onOwnerEvent: (callback: (notice: OwnerNotice) => void) => {
      listeners.push(callback);
    },
  };

  new HostApiRouter(transport as any, {
    vfs: {
      stat: () => {
        throw new Error('no file');
      },
      withBlob: vi.fn(),
    } as any,
    configManager: {} as any,
    processManager: { processes, on: vi.fn() } as any,
    engineFor: (pid) => (processes.has(pid) ? (rootBundle as any) : null),
    engines: options.engines === false ? null : (table as unknown as EngineTable),
    guestLocalStore: {} as any,
  });

  const call = (action: string, payload: any, pid = 'viewer') => {
    const handler = handlers.get(action);
    if (!handler) throw new Error(`no handler: ${action}`);
    return handler(payload, pid);
  };
  const notify = (notice: OwnerNotice) => listeners.forEach((cb) => cb(notice));
  return { handlers, call, notify, sendEvent, viewerWindow, table, engine, rootBundle };
}

/** ゲストの取っ手の口を全部呼んで、送られた engine:* の名前を集める */
async function actionsSentByBridge(): Promise<string[]> {
  (window as any).__ITERA_PID__ = 'p1';
  delete (window as any).MetaOS;
  const posted: any[] = [];
  window.postMessage = ((msg: any) => posted.push(msg)) as any;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  new Function(bridgeSource)();
  const api = (window as any).MetaOS.engine;

  const creating = api.create();
  const req = posted.find((m) => m.action === 'engine:create');
  window.dispatchEvent(
    new MessageEvent('message', {
      data: {
        protocol: PROTOCOL,
        type: 'res',
        id: req.id,
        source: 'host',
        target: req.source,
        action: req.action,
        payload: { id: 'eng-1' },
        error: null,
      },
      source: window,
    }),
  );
  const e = await creating;
  for (const verb of ['append', 'wake', 'stop', 'reset', 'status', 'turns', 'save', 'dispose']) {
    void e[verb]('a', 'b', {}).catch(() => {});
  }
  void api.list().catch(() => {});
  // 読み込みのときに橋が自分で送る口（エンジンと関係ないもの）は数えない
  const actions = posted.filter((m) => m.type === 'req').map((m) => m.action as string);
  return [...new Set(actions.filter((action) => action.startsWith('engine:')))];
}

describe('HostApiRouter: engine:* の配線', () => {
  it('ゲストの取っ手が送る口と、ホストが受ける口は、過不足なく同じ', async () => {
    const w = world();
    const sent = await actionsSentByBridge();
    const registered = [...w.handlers.keys()].filter((action) => action.startsWith('engine:'));

    expect(sent).toHaveLength(10);
    expect([...registered].sort()).toEqual([...sent].sort());
  });

  it('呼び手は、プロセスの記録から決めた主体と pid。spec はそのまま', async () => {
    const w = world();
    const spec = { from: 'data/c' };

    expect(await w.call('engine:create', { spec })).toEqual({ id: 'eng-1' });
    expect(w.table.create).toHaveBeenCalledWith({ pid: 'viewer', principal: VIEWER }, spec);
  });

  it('どの口も、呼び手が持っているエンジンに届く（仕えているエンジンには触らない）', async () => {
    const w = world();
    const id = 'eng-1';

    expect(await w.call('engine:append', { id, role: 'user', content: 'hi', opts: { wake: true } })).toEqual({
      id: 'sub-turn',
    });
    expect(w.engine.bundle.post).toHaveBeenCalledWith('user', [{ text: 'hi' }], {
      trigger_llm: true,
      source: 'viewer',
    });
    expect(await w.call('engine:wake', { id })).toBe(true);
    expect(w.engine.bundle.wake).toHaveBeenCalledTimes(1);
    expect(await w.call('engine:stop', { id })).toBe(true);
    expect(w.engine.bundle.stop).toHaveBeenCalledTimes(1);
    expect(await w.call('engine:reset', { id, opts: { summary: 'carry', restoreTools: false } })).toEqual({
      archived: false,
      sessionId: 's2',
    });
    expect(w.engine.bundle.reset).toHaveBeenCalledWith({
      summary: '[System: Session reset by viewer]\nContinue as told.\n\n[Carried Over Information]\ncarry',
      restoreTools: false,
    });
    expect(await w.call('engine:status', { id })).toMatchObject({ running: false, turns: 0 });
    expect((await w.call('engine:turns', { id })).map((t: any) => t.id)).toEqual(['t1']);
    expect(await w.call('engine:save', { id, path: 'data/out' })).toEqual({ path: 'data/out', media: 0 });
    expect(w.engine.conversation.save).toHaveBeenCalledWith('data/out', VIEWER);
    expect((await w.call('engine:list', {})).map((e: any) => e.id)).toEqual(['eng-1']);
    expect(await w.call('engine:dispose', { id })).toBe(true);
    expect(w.table.dispose).toHaveBeenCalledWith('eng-1', 'owner_request');

    for (const fn of [w.rootBundle.post, w.rootBundle.wake, w.rootBundle.stop, w.rootBundle.reset]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('持ち主でないプロセスからは「無い」', async () => {
    const w = world();
    await expect(w.call('engine:wake', { id: 'eng-1' }, 'windowless')).rejects.toThrow('Engine "eng-1" not found.');
    expect(await w.call('engine:list', {}, 'windowless')).toEqual([]);
    expect(w.engine.bundle.wake).not.toHaveBeenCalled();
  });

  it('束の表が無い組み立てでは、どの口も「Engines are not available.」', async () => {
    const w = world({ engines: false });
    const engineActions = [...w.handlers.keys()].filter((action) => action.startsWith('engine:'));
    expect(engineActions).toHaveLength(10);
    for (const action of engineActions) {
      await expect(w.call(action, { id: 'eng-1', spec: {} })).rejects.toThrow('Engines are not available.');
    }
  });
});

describe('HostApiRouter: 持ち主への知らせ', () => {
  it('持ち主のプロセスの窓にだけ、ゲストへ送る形で送る', () => {
    const w = world();

    w.notify({ ownerPid: 'viewer', engineId: 'eng-1', event: 'stream_chunk', data: 'he' });

    expect(w.sendEvent).toHaveBeenCalledTimes(1);
    expect(w.sendEvent).toHaveBeenCalledWith(
      'viewer',
      'engine:event',
      { id: 'eng-1', event: 'stream_chunk', data: { text: 'he' } },
      w.viewerWindow,
    );
  });

  it('窓の無いプロセス・もう居ないプロセスへは、送らない', () => {
    const w = world();
    w.notify({ ownerPid: 'windowless', engineId: 'eng-2', event: 'loop_stop', data: { reason: 'idle' } });
    w.notify({ ownerPid: 'gone', engineId: 'eng-3', event: 'disposed', data: { reason: 'owner_exit' } });
    expect(w.sendEvent).not.toHaveBeenCalled();
  });
});

describe('HostApiRouter: chat:append は前と同じ', () => {
  it('呼んだプロセスが仕えるエンジンに置く。持っているエンジンには置かない', async () => {
    const w = world();

    expect(await w.call('chat:append', { role: 'user', content: 'hi', opts: { wake: true } })).toEqual({
      id: 'root-turn',
    });
    expect(w.rootBundle.post).toHaveBeenCalledWith('user', [{ text: 'hi' }], { trigger_llm: true, source: 'viewer' });
    expect(w.engine.bundle.post).not.toHaveBeenCalled();
  });

  it('断り方も前と同じ（仕えるエンジンが無い・受けられない形）', async () => {
    const w = world();
    await expect(w.call('chat:append', { role: 'user', content: 'hi' }, 'nobody')).rejects.toThrow(
      'Chat is not available.',
    );
    await expect(w.call('chat:append', { role: 'model', content: 'hi' })).rejects.toThrow(
      "chat.append: role must be 'user' or 'system'",
    );
    expect(w.rootBundle.post).not.toHaveBeenCalled();
  });
});
