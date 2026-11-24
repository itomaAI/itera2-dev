/**
 * src/shell/services/EngineManager.test.ts
 * 束の表（T-0908）。ルートのほかに束を作り、持ち主・寿命・知らせの規則を見る。
 * 束とエンジンと道具の台帳は本物。偽物は、VFS・プロセスの表・プロンプトと上流を差す側。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineManager, type EngineOwnerNotice } from './EngineManager';
import { EngineCalls } from '../../api/EngineCalls';
import { MAX_SUB_ENGINES } from '../../config/engine_limits';
import { createEngineBundle } from '../../core/control/EngineBundle';
import { ROOT_ENGINE_ID } from '../../core/control/Engine';
import { ToolRegistry } from '../../core/control/ToolRegistry';
import { HistoryManager } from '../../core/state/HistoryManager';
import { Translator } from '../../core/cognitive/Translator';
import { FakeVfs } from '../../core/state/bundleTestKit';
import { buildSessionExport } from '../../core/state/sessionArchive';
import type { Principal } from '../../core/vfs/types';

const APP: Principal = { type: 'app', id: 'viewer' };
const OWNER = { pid: 'viewer', principal: APP };
const media = (path: string) => ({ media: { path, mimeType: 'image/png', metadata: {} } });

function deferred() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve));
  return { wait, release };
}

function world() {
  const registry = new ToolRegistry(undefined, { record: () => {} } as any);
  const vfs = new FakeVfs();
  const logs: Array<[string, any]> = [];

  // プロセスの表（ProcessManager の代わり）。kill は表から外して process_killed を知らせる
  const procs = new Map<string, { pid: string; app: string; engine: string }>();
  const killed: string[] = [];
  const onKilled: Array<(pid: string, proc: any) => void> = [];
  const processes = {
    processes: procs,
    kill(pid: string) {
      const proc = procs.get(pid);
      if (!proc) return false;
      procs.delete(pid);
      killed.push(pid);
      onKilled.forEach((cb) => cb(pid, proc));
      return true;
    },
    on(event: string, cb: (...args: any[]) => void) {
      if (event === 'process_killed') onKilled.push(cb);
    },
  };
  const spawn = (pid: string, engine: string = ROOT_ENGINE_ID, app: string = pid) => {
    procs.set(pid, { pid, app, engine });
  };

  const osConfig: Record<string, any> = {
    llm: { model: 'google/big', temperature: 1 },
    preferences: { maxContinuousTools: 10, agentName: 'Itera' },
  };
  const configManager = { get: (category: string) => osConfig[category] };

  /** 上流の偽物を差す。出力は空（道具を投げずに終わる） */
  const arm = (engine: any) => {
    const generateStream = vi.fn(async (_m: any, onChunk: (c: string) => void, _signal: any, _origin: any) => {
      onChunk('');
    });
    engine.projector = { createContext: vi.fn(async () => []) };
    engine.llm = { generateStream };
    return generateStream;
  };

  const rootHistory = new HistoryManager();
  const root = createEngineBundle({
    id: ROOT_ENGINE_ID,
    role: 'root',
    history: rootHistory,
    vfs: vfs as any,
    configManager,
    translator: new Translator(),
    registry,
    fs: { tag: 'fs-root' } as any,
    conversation: {
      reset: vi.fn(async () => ({})),
      putAttachment: vi.fn(async () => 'p'),
      current: async () => null,
      currentId: () => null,
    },
    contextLimit: async () => null,
    wakePolicy: 'realtime',
    wakeDebounceMs: 1500,
  });
  const rootStream = arm(root.engine);

  /** 差された記録。gate.wait が在れば差す前に待ち、gate.error が在れば失敗する */
  const equips: Array<{ engine: any; config: any; role: string; unequip: any; generateStream: any }> = [];
  const gate: { wait: Promise<void> | null; error: Error | null } = { wait: null, error: null };
  const cognitive = {
    equip: vi.fn(async (engine: any, config: any, role: string) => {
      if (gate.wait) await gate.wait;
      if (gate.error) throw gate.error;
      const unequip = vi.fn();
      equips.push({ engine, config, role, unequip, generateStream: arm(engine) });
      return unequip;
    }),
    contextLimit: vi.fn(async (config?: any) => (config?.get('llm').model === 'google/small' ? 100 : 1000)),
  };
  const shellFor = vi.fn((engineId: string) => ({ tag: `shell-${engineId}` }) as any);
  const fsFor = vi.fn((engineId: string) => ({ tag: `fs-${engineId}` }) as any);

  const manager = new EngineManager({
    root,
    vfs: vfs as any,
    configManager,
    translator: new Translator(),
    registry,
    fsFor,
    shellFor,
    processes,
    cognitive,
    logger: { log: (category: string, payload: any) => logs.push([category, payload]) },
  });
  const notices: EngineOwnerNotice[] = [];
  manager.onOwnerEvent((notice) => notices.push(notice));
  /** process_events に書かれた行 */
  const rows = () => logs.filter(([category]) => category === 'process_events').map(([, payload]) => payload);
  const engineFiles = () => [...vfs.files.keys()].filter((k) => k.startsWith('system/temp/engines/'));

  spawn('viewer');
  return {
    manager,
    registry,
    vfs,
    procs,
    processes,
    killed,
    spawn,
    osConfig,
    root,
    rootHistory,
    rootStream,
    equips,
    gate,
    cognitive,
    shellFor,
    fsFor,
    notices,
    rows,
    engineFiles,
  };
}

/** 保存された会話を 1 つ置く（添付つき）。`unanswered` なら、答えていない発言で終わる */
function seedSaved(vfs: FakeVfs, dir = 'data/c', unanswered = false) {
  const turns: any[] = [
    { id: 't1', timestamp: 6, role: 'user', content: [media('system/temp/sessions/s1/a.png')], meta: {} },
    { id: 't2', timestamp: 7, role: 'model', content: 'seen', meta: { type: 'model_thought' } },
  ];
  if (unanswered) turns.push({ id: 't3', timestamp: 8, role: 'user', content: 'and then?', meta: {} });
  vfs.files.set(
    `${dir}/session.json`,
    JSON.stringify(buildSessionExport({ id: 's1', createdAt: 5, title: 'T' }, turns, 9)),
  );
  vfs.files.set(`${dir}/media/a.png`, 'A');
}

const settle = () => vi.advanceTimersByTimeAsync(2000);
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('EngineManager: 束を引く', () => {
  it('プロセスが仕えるエンジンの束を返す。持ち主は、自分の持ち物に仕えているわけではない', async () => {
    const w = world();
    w.spawn('home');
    const e = await w.manager.create(OWNER);
    w.spawn('helper', e.id);

    expect(w.manager.bundleFor('home')).toBe(w.root);
    expect(w.manager.bundleFor('viewer')).toBe(w.root);
    expect(w.manager.bundleFor('helper')).toBe(e.bundle);
    expect(w.manager.bundleFor('nobody')).toBeNull();
    // 表に無いエンジンに仕えているプロセスには、束が無い（ルートに落とさない）
    w.spawn('stray', 'eng-gone');
    expect(w.manager.bundleFor('stray')).toBeNull();
  });

  it('宛先に書けるのは持ち主だけ。持ち主でない者には、無いのと同じ答え', async () => {
    const w = world();
    w.spawn('other');
    const e = await w.manager.create(OWNER);

    expect(w.manager.of('viewer', e.id)).toBe(e);
    expect(w.manager.owned('viewer')).toEqual([e]);
    expect(w.manager.owned('other')).toEqual([]);
    expect(() => w.manager.of('other', e.id)).toThrow(`Engine "${e.id}" not found.`);
    expect(() => w.manager.of('viewer', 'eng-none')).toThrow('Engine "eng-none" not found.');
    // ルートは誰の持ち物でもない
    expect(() => w.manager.of('viewer', ROOT_ENGINE_ID)).toThrow(/not found/);
  });
});

describe('EngineManager: 作る', () => {
  it('id はホストが振る。役割は sub・取っ手はそのエンジンのもの・設定は OS の設定に上書きを重ねたもの', async () => {
    const w = world();
    w.spawn('viewer', ROOT_ENGINE_ID, 'viewer-app');
    const e = await w.manager.create(OWNER, {
      config: { llm: { model: 'google/small' }, preferences: { maxContinuousTools: 30 } },
    });

    expect(e.id).toMatch(/^eng-[0-9a-z]{12}$/);
    expect(e.ownerPid).toBe('viewer');
    expect(e.ownerApp).toBe('viewer-app');
    expect(e.bundle.id).toBe(e.id);
    expect(e.bundle.role).toBe('sub');
    expect(e.bundle.history).toBe(e.conversation.history);
    expect(e.bundle.engine.extraContext.fs).toEqual({ tag: `fs-${e.id}` });
    expect(e.bundle.engine.extraContext.shell).toEqual({ tag: `shell-${e.id}` });
    expect(e.conversation.mediaDir).toBe(`system/temp/engines/${e.id}`);

    // プロンプトと上流は、このエンジンの設定と役割で差される
    expect(w.equips).toHaveLength(1);
    expect(w.equips[0].engine).toBe(e.bundle.engine);
    expect(w.equips[0].role).toBe('sub');
    const config = w.equips[0].config;
    expect(config.get('llm')).toEqual({ model: 'google/small', temperature: 1 });
    expect(config.get('preferences')).toEqual({ maxContinuousTools: 30, agentName: 'Itera' });
    // エンジン自身（連続実行の上限を毎サイクル読む）も、同じ設定を読む
    expect(e.bundle.engine.state.configManager).toBe(config);
    // 上書きしていない鍵は、OS の設定に追随する
    w.osConfig.llm = { model: 'google/other', temperature: 0.2 };
    expect(config.get('llm')).toEqual({ model: 'google/small', temperature: 0.2 });

    // 状態: 会話は自分のもの・文脈の上限は自分の設定のモデルで引く
    const status = await e.bundle.statusInput();
    expect(status.session).toEqual(await e.conversation.current());
    expect(status.contextLimit).toBe(100);

    expect(w.rows()).toEqual([{ action: 'engine_created', engine: e.id, owner: 'viewer', app: 'viewer-app' }]);
  });

  it('始まりに、見えている道具（ルートの台帳のもの）の定義を会話に置く。起こさない', async () => {
    const w = world();
    w.root.tools.registerDynamicTool('search', 'web', {
      description: 's',
      definition: '<define_tag name="search">S</define_tag>',
    });
    const e = await w.manager.create(OWNER);

    const turns = e.bundle.history.get();
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe('system');
    expect(turns[0].content).toContain('[System: Restored Dynamic Tools]');
    expect(turns[0].content).toContain('<define_tag name="search">S</define_tag>');
    await settle();
    expect(w.equips[0].generateStream).not.toHaveBeenCalled();
    expect(e.bundle.history.get()).toHaveLength(1);
  });

  it('保存された会話から始める。読むのは持ち主の主体・添付はこのエンジンの置き場へ', async () => {
    const w = world();
    seedSaved(w.vfs);
    const e = await w.manager.create(OWNER, { from: 'data/c' });

    const turns = e.bundle.history.get();
    expect(turns.slice(0, 2).map((t) => [t.role, t.content])).toEqual([
      ['user', [media(`system/temp/engines/${e.id}/a.png`)]],
      ['model', 'seen'],
    ]);
    expect(turns[2].meta).toMatchObject({ eventType: 'session_loaded', trigger_llm: false });
    expect(turns).toHaveLength(3);
    expect(w.vfs.files.get(`system/temp/engines/${e.id}/a.png`)).toBe('A');
    expect(w.vfs.reads).toContainEqual({ by: 'app:viewer', path: 'data/c/session.json' });
    expect((await e.bundle.statusInput()).session).toEqual({ id: 's1', title: 'T', createdAt: 5 });
    await settle();
    expect(w.equips[0].generateStream).not.toHaveBeenCalled();
  });

  it('答えていない発言で終わる保存から始めると、その発言で起きる（未読の発言が在れば起きる、というエンジンの規則のまま）', async () => {
    const w = world();
    seedSaved(w.vfs, 'data/c', true);
    const e = await w.manager.create(OWNER, { from: 'data/c' });
    expect(w.equips[0].generateStream).not.toHaveBeenCalled();

    await settle();

    expect(w.equips[0].generateStream).toHaveBeenCalledTimes(1);
    expect(e.bundle.history.get().map((t) => t.role)).toEqual(['user', 'model', 'user', 'system', 'model']);
  });

  it('受け付けないものは、作らずに理由を付けて断る', async () => {
    const w = world();
    const create = (owner: any, spec?: any) => w.manager.create(owner, spec);

    await expect(create({ pid: 'ghost', principal: APP })).rejects.toThrow('Process "ghost" is not running.');
    await expect(create(OWNER, null)).rejects.toThrow('Invalid engine spec: must be an object');
    await expect(create(OWNER, ['x'])).rejects.toThrow('Invalid engine spec: must be an object');
    await expect(create(OWNER, { config: { llm: { model: '' } } })).rejects.toThrow(
      'Invalid engine spec: config.llm.model must be a non-empty string',
    );
    await expect(create(OWNER, { init: 'data/role.md' })).rejects.toThrow(
      'Invalid engine spec: init is not supported (allowed: config, from)',
    );
    await expect(create(OWNER, { from: 5 })).rejects.toThrow('Invalid engine spec: from must be a non-empty path');
    await expect(create(OWNER, { from: '  ' })).rejects.toThrow('Invalid engine spec: from must be a non-empty path');
    await expect(create(OWNER, { config: { network: {} }, from: 5 })).rejects.toThrow(
      'Invalid engine spec: config.network cannot be overridden (allowed: llm, preferences); from must be a non-empty path',
    );

    expect(w.fsFor).not.toHaveBeenCalled();
    expect(w.cognitive.equip).not.toHaveBeenCalled();
    expect(w.manager.owned('viewer')).toEqual([]);
    expect(w.rows()).toEqual([]);
  });

  it('読めない保存は断り、何も残さない', async () => {
    const w = world();
    await expect(w.manager.create(OWNER, { from: 'data/none' })).rejects.toThrow(
      'Cannot load the conversation: File not found: data/none',
    );
    expect(w.manager.owned('viewer')).toEqual([]);
    expect(w.cognitive.equip).not.toHaveBeenCalled();
    expect(w.rows()).toEqual([]);
    // 断ったあとは、数に残らない
    for (let i = 0; i < MAX_SUB_ENGINES; i++) await w.manager.create(OWNER);
  });

  it('保存を読んでいる間に持ち主が終わったら、写した添付も消してやめる（同じ pid で起こし直されていても）', async () => {
    const w = world();
    seedSaved(w.vfs);
    const p = w.manager.create(OWNER, { from: 'data/c' });
    w.processes.kill('viewer');
    w.spawn('viewer');

    await expect(p).rejects.toThrow(/^The owner of engine "eng-[0-9a-z]+" exited while it was being created\.$/);
    expect(w.vfs.writes.some((x) => x.path.startsWith('system/temp/engines/'))).toBe(true);
    expect(w.engineFiles()).toEqual([]);
    expect(w.manager.owned('viewer')).toEqual([]);
    expect(w.cognitive.equip).not.toHaveBeenCalled();
    expect(w.rows()).toEqual([]);
  });

  it(`同時に生きていられるのは ${MAX_SUB_ENGINES} つ。畳めば、また作れる`, async () => {
    const w = world();
    const made = [];
    for (let i = 0; i < MAX_SUB_ENGINES; i++) made.push(await w.manager.create(OWNER));
    expect(new Set(made.map((e) => e.id)).size).toBe(MAX_SUB_ENGINES);

    await expect(w.manager.create(OWNER)).rejects.toThrow('Too many engines (limit 8). Dispose one first.');
    expect(w.manager.owned('viewer')).toHaveLength(MAX_SUB_ENGINES);

    await w.manager.dispose(made[0].id);
    await w.manager.create(OWNER);
    expect(w.manager.owned('viewer')).toHaveLength(MAX_SUB_ENGINES);
  });

  it('作っている途中のものも、上限に数える', async () => {
    const w = world();
    seedSaved(w.vfs);
    for (let i = 0; i < MAX_SUB_ENGINES - 1; i++) await w.manager.create(OWNER);

    const first = w.manager.create(OWNER, { from: 'data/c' });
    const second = w.manager.create(OWNER, { from: 'data/c' });
    await expect(second).rejects.toThrow(/Too many engines/);
    await first;
    expect(w.manager.owned('viewer')).toHaveLength(MAX_SUB_ENGINES);
  });

  it('プロンプトと上流を差している間に持ち主が終わったら、差したものを外してやめる', async () => {
    const w = world();
    const gate = deferred();
    w.gate.wait = gate.wait;
    const p = w.manager.create(OWNER);
    expect(w.cognitive.equip).toHaveBeenCalledTimes(1);

    w.processes.kill('viewer');
    gate.release();

    await expect(p).rejects.toThrow(/exited while it was being created/);
    expect(w.equips[0].unequip).toHaveBeenCalledTimes(1);
    expect(w.manager.owned('viewer')).toEqual([]);
    expect(w.rows().map((r) => [r.action, r.reason])).toEqual([
      ['engine_created', undefined],
      ['engine_disposed', 'owner_exit'],
    ]);
  });

  it('差すのに失敗したら畳んで、その失敗を返す', async () => {
    const w = world();
    w.gate.error = new Error('no key');
    await expect(w.manager.create(OWNER)).rejects.toThrow('no key');

    expect(w.manager.owned('viewer')).toEqual([]);
    expect(w.rows().map((r) => [r.action, r.reason])).toEqual([
      ['engine_created', undefined],
      ['engine_disposed', 'create_failed'],
    ]);
    expect(w.notices.filter((n) => n.event === 'disposed').map((n) => n.data)).toEqual([{ reason: 'create_failed' }]);
  });
});

describe('EngineManager: 2 つ目の束が走る', () => {
  it('サブに置いた発言でサブだけが起き、自分の id を名乗る。知らせは持ち主にだけ・ルートの知らせは混ざらない', async () => {
    const w = world();
    const e = await w.manager.create(OWNER);

    await e.bundle.post('user', 'hi', { trigger_llm: true });
    await settle();

    expect(e.bundle.history.get().map((t) => t.role)).toEqual(['user', 'model']);
    expect(w.equips[0].generateStream).toHaveBeenCalledTimes(1);
    expect(w.equips[0].generateStream.mock.calls[0][3]).toEqual({
      caller: e.id,
      engineTurn: true,
      tag: e.conversation.currentId(),
    });
    expect(w.rootHistory.get()).toEqual([]);
    expect(w.rootStream).not.toHaveBeenCalled();

    const events = w.notices.map((n) => n.event);
    expect(events).toEqual(expect.arrayContaining(['turn_start', 'turn_end', 'loop_stop']));
    expect(events).not.toContain('wake_requested');
    expect(w.notices.every((n) => n.ownerPid === 'viewer' && n.engineId === e.id)).toBe(true);

    // 外から置いた system のターンも、持ち主に届く
    const placed = await e.bundle.post('system', '<event type="x">y</event>', { trigger_llm: false });
    expect(w.notices.at(-1)).toEqual({
      ownerPid: 'viewer',
      engineId: e.id,
      event: 'turn_placed',
      data: { turn: placed },
    });

    // ルートが走っても、サブの持ち主には何も届かず、サブの会話も変わらない
    await settle();
    const count = w.notices.length;
    await w.root.post('user', 'to root', { trigger_llm: true });
    await settle();
    expect(w.rootStream).toHaveBeenCalledTimes(1);
    expect(w.notices).toHaveLength(count);
    expect(e.bundle.history.get()).toHaveLength(3);
  });

  it('知らせには、そのエンジンの持ち主が付く', async () => {
    const w = world();
    w.spawn('other');
    const a = await w.manager.create(OWNER);
    const b = await w.manager.create({ pid: 'other', principal: { type: 'app', id: 'other' } });

    await a.bundle.post('system', 'to a');
    await b.bundle.post('system', 'to b');

    expect(w.notices.map((n) => [n.ownerPid, n.engineId, n.event])).toEqual([
      ['viewer', a.id, 'turn_placed'],
      ['other', b.id, 'turn_placed'],
    ]);
  });

  it('空にすると、消える前の会話が持ち主に届く', async () => {
    const w = world();
    const e = await w.manager.create(OWNER);
    await e.bundle.post('user', 'hi');
    const before = e.conversation.currentId();

    await e.bundle.reset({ summary: 'carry' });

    const resets = w.notices.filter((n) => n.event === 'reset');
    expect(resets).toHaveLength(1);
    expect(resets[0]).toMatchObject({ ownerPid: 'viewer', engineId: e.id });
    expect((resets[0].data as any).session).toMatchObject({ format: 'itera-session/1', id: before, turnCount: 1 });
    expect(e.bundle.history.get().map((t) => t.content)).toEqual([
      '<event type="session_reset">\n[Session Restored & Context Compressed]\n\ncarry\n</event>',
    ]);
    expect(e.conversation.currentId()).not.toBe(before);
  });

  it('聞き手の 1 つが失敗しても、ほかの聞き手には届く', async () => {
    const w = world();
    const late: string[] = [];
    w.manager.onOwnerEvent(() => {
      throw new Error('listener broke');
    });
    w.manager.onOwnerEvent((n) => late.push(n.event));
    const e = await w.manager.create(OWNER);

    await e.bundle.post('system', 'x');
    expect(await w.manager.dispose(e.id)).toBe(true);
    expect(late).toEqual(expect.arrayContaining(['turn_placed', 'disposed']));
  });
});

describe('EngineManager: 畳む', () => {
  it('差したものを外し、エンジンを止め、仕えていたプロセスを終わらせ、添付の置き場を消す', async () => {
    const w = world();
    const e = await w.manager.create(OWNER);
    await e.conversation.putAttachment('a.png', new Blob(['A']));
    w.spawn('helper', e.id);
    w.spawn('bystander');
    // 仕えていたプロセスが終わる時点で、エンジンはもう止まっている（置く口が断る）
    const postsAtKill: Array<Promise<unknown>> = [];
    w.processes.on('process_killed', () => postsAtKill.push(e.bundle.post('system', 'bye')));

    expect(await w.manager.dispose(e.id)).toBe(true);

    expect(w.equips[0].unequip).toHaveBeenCalledTimes(1);
    await expect(e.bundle.post('user', 'x')).rejects.toThrow(/disposed/);
    expect(postsAtKill).toHaveLength(1);
    await expect(postsAtKill[0]).rejects.toThrow(/disposed/);
    expect(w.killed).toEqual(['helper']);
    expect([...w.procs.keys()]).toEqual(['viewer', 'bystander']);
    expect(w.engineFiles()).toEqual([]);
    expect(w.vfs.deletes).toEqual([{ by: 'system:kernel', path: `system/temp/engines/${e.id}`, permanent: true }]);
    expect(w.rows().at(-1)).toEqual({
      action: 'engine_disposed',
      engine: e.id,
      owner: 'viewer',
      app: 'viewer',
      reason: 'owner_request',
    });
    expect(w.notices.at(-1)).toEqual({
      ownerPid: 'viewer',
      engineId: e.id,
      event: 'disposed',
      data: { reason: 'owner_request' },
    });
    expect(() => w.manager.of('viewer', e.id)).toThrow(/not found/);

    // 2 度目は何もしない
    expect(await w.manager.dispose(e.id)).toBe(false);
    expect(w.rows().filter((r) => r.action === 'engine_disposed')).toHaveLength(1);
    expect(w.equips[0].unequip).toHaveBeenCalledTimes(1);
  });

  it('持ち主のプロセスが終わると、その持ち物が畳まれる。ほかの持ち主のものは残る', async () => {
    const w = world();
    w.spawn('other');
    const mine1 = await w.manager.create(OWNER);
    const mine2 = await w.manager.create(OWNER);
    const theirs = await w.manager.create({ pid: 'other', principal: { type: 'app', id: 'other' } });

    w.processes.kill('viewer');
    await flush();

    expect(w.manager.owned('viewer')).toEqual([]);
    expect(w.manager.owned('other')).toEqual([theirs]);
    expect(
      w
        .rows()
        .filter((r) => r.action === 'engine_disposed')
        .map((r) => [r.engine, r.reason]),
    ).toEqual([
      [mine1.id, 'owner_exit'],
      [mine2.id, 'owner_exit'],
    ]);
    await expect(theirs.bundle.post('system', 'still here')).resolves.toBeTruthy();
  });

  it('連鎖: 仕えていたプロセスが持つエンジンも、そのプロセスが終わることで畳まれる', async () => {
    const w = world();
    w.spawn('bystander');
    const a = await w.manager.create(OWNER);
    w.spawn('p2', a.id);
    const b = await w.manager.create({ pid: 'p2', principal: APP });
    w.spawn('p3', b.id);
    const c = await w.manager.create({ pid: 'p3', principal: APP });
    w.spawn('p4', c.id);

    w.processes.kill('viewer');
    await flush();

    expect(w.killed).toEqual(['viewer', 'p2', 'p3', 'p4']);
    expect([...w.procs.keys()]).toEqual(['bystander']);
    for (const pid of ['viewer', 'p2', 'p3']) expect(w.manager.owned(pid)).toEqual([]);
    expect(
      w
        .rows()
        .filter((r) => r.action === 'engine_disposed')
        .map((r) => [r.engine, r.owner, r.reason])
        .sort(),
    ).toEqual(
      [
        [a.id, 'viewer', 'owner_exit'],
        [b.id, 'p2', 'owner_exit'],
        [c.id, 'p3', 'owner_exit'],
      ].sort(),
    );
  });
});

describe('EngineManager: 添付の置き場の掃除', () => {
  it('生きているエンジンに無い id のディレクトリだけを消す', async () => {
    const w = world();
    const e = await w.manager.create(OWNER);
    await e.conversation.putAttachment('a.png', new Blob(['A']));
    w.vfs.files.set('system/temp/engines/eng-dead/x.png', 'X');
    w.vfs.files.set('system/temp/engines/note.txt', 'N');
    w.vfs.files.set('system/temp/sessions/s1/y.png', 'Y');

    await w.manager.sweepLeftovers();

    expect(w.vfs.deletes).toEqual([{ by: 'system:kernel', path: 'system/temp/engines/eng-dead', permanent: true }]);
    expect([...w.vfs.files.keys()].sort()).toEqual([
      `system/temp/engines/${e.id}/a.png`,
      'system/temp/engines/note.txt',
      'system/temp/sessions/s1/y.png',
    ]);
  });

  it('置き場が無ければ、何もしない', async () => {
    const w = world();
    await w.manager.sweepLeftovers();
    expect(w.vfs.deletes).toEqual([]);
  });
});
describe('EngineManager × EngineCalls: 持ち主の口を通す（MetaOS.engine のホストの側）', () => {
  const OTHER = { pid: 'other', principal: { type: 'app', id: 'other' } as Principal };
  /** 束の表は本物。ゲストへ送る所だけ、記録に替える */
  const callsOf = (w: ReturnType<typeof world>) => {
    const sent: Array<{ pid: string; action: string; payload: any }> = [];
    const calls = new EngineCalls({
      engines: w.manager,
      vfs: w.vfs as any,
      send: (pid, action, payload) => sent.push({ pid, action, payload }),
    });
    return { calls, sent };
  };

  it('作る → 置いて起こす → 文字・ターン・止まった理由が、持ち主にだけ届く', async () => {
    const w = world();
    w.spawn('other');
    const { calls, sent } = callsOf(w);

    const { id } = await calls.create(OWNER, {});
    w.equips[0].generateStream.mockImplementationOnce(async (_m: any, onChunk: (c: string) => void) => {
      // 書き留めるだけの出力（道具を投げずに終わる）。2 つの塊で届く
      onChunk('<memo>he');
      onChunk('llo</memo>');
    });
    await calls.append(OWNER, id, { role: 'user', content: 'hi', opts: { wake: true } });
    await settle();

    expect(sent.every((s) => s.pid === 'viewer' && s.action === 'engine:event' && s.payload.id === id)).toBe(true);
    const of = (event: string) => sent.filter((s) => s.payload.event === event).map((s) => s.payload.data);
    expect(of('stream_chunk')).toEqual([{ text: '<memo>he' }, { text: 'llo</memo>' }]);
    expect(of('turn_end').map((d) => [d.role, d.turn.role])).toEqual([
      ['user', 'user'],
      ['model', 'model'],
    ]);
    expect(of('turn_end')[1].turn.content).toBe('<memo>hello</memo>');
    expect(of('turn_start')).toHaveLength(1);
    expect(sent.at(-1)!.payload).toEqual({ id, event: 'loop_stop', data: { reason: 'idle' } });
    // 窓をまたいで運べる形（JSON で往復して同じ）
    for (const s of sent) expect(JSON.parse(JSON.stringify(s.payload))).toEqual(s.payload);

    // 状態・全文・一覧は、持ち主にだけ見える
    expect(await calls.status(OWNER, id)).toMatchObject({ running: false, busy: false, turns: 2 });
    expect((await calls.turns(OWNER, id)).map((t) => t.role)).toEqual(['user', 'model']);
    expect((await calls.list(OWNER)).map((e) => [e.id, e.status.turns])).toEqual([[id, 2]]);
    expect(await calls.list(OTHER)).toEqual([]);
    // ルートの会話には何も置かれない
    expect(w.rootHistory.get()).toEqual([]);
  });

  it('持ち主でない者は、置けない・読めない・畳めない', async () => {
    const w = world();
    w.spawn('other');
    const { calls, sent } = callsOf(w);
    const { id } = await calls.create(OWNER, {});

    await expect(calls.append(OTHER, id, { role: 'user', content: 'x', opts: { wake: true } })).rejects.toThrow(
      'not found',
    );
    await expect(calls.turns(OTHER, id)).rejects.toThrow('not found');
    await expect(calls.save(OTHER, id, 'data/steal')).rejects.toThrow('not found');
    await expect(calls.dispose(OTHER, id)).rejects.toThrow('not found');
    await settle();

    expect(await calls.turns(OWNER, id)).toEqual([]);
    expect(w.vfs.writes).toEqual([]);
    expect(w.equips[0].generateStream).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('受け付けない spec は、束の表の理由のまま断る', async () => {
    const w = world();
    const { calls } = callsOf(w);

    await expect(calls.create(OWNER, { init: 'data/role.md' })).rejects.toThrow('init is not supported');
    await expect(calls.create(OWNER, null)).rejects.toThrow('Invalid engine spec: must be an object');
    await expect(calls.create({ pid: 'ghost', principal: APP }, {})).rejects.toThrow('is not running');
    expect(await calls.list(OWNER)).toEqual([]);
  });

  it('reset: 消える前の会話が知らせで届き、申し送りの頭に呼び手とサブの役割の 1 行が付く', async () => {
    const w = world();
    const { calls, sent } = callsOf(w);
    const { id } = await calls.create(OWNER, {});
    await calls.append(OWNER, id, { role: 'user', content: 'hi' });

    const result = await calls.reset(OWNER, id, { summary: 'carry' });

    expect(result).toMatchObject({ archived: false });
    const resets = sent.filter((s) => s.payload.event === 'reset');
    expect(resets).toHaveLength(1);
    expect(resets[0].payload.data.session).toMatchObject({ format: 'itera-session/1', turnCount: 1 });
    const turns = await calls.turns(OWNER, id);
    expect(turns).toHaveLength(1);
    expect(turns[0].content).toContain('[System: Session reset by viewer]');
    expect(turns[0].content).toContain('[Carried Over Information]\ncarry');
    // サブに起動手順は無い（ルートの 1 行は付かない）
    expect(turns[0].content).not.toContain('Initialization Protocol');
  });

  it('save → create({ from }): 書くのは持ち主の主体。書いた会話から、別のエンジンを始められる', async () => {
    const w = world();
    const { calls } = callsOf(w);
    const { id } = await calls.create(OWNER, {});
    await calls.append(OWNER, id, { role: 'user', content: 'hi', opts: { wake: true } });
    await settle();

    expect(await calls.save(OWNER, id, 'data/out/')).toEqual({ path: 'data/out', media: 0 });
    expect(w.vfs.writes).toEqual([{ by: 'app:viewer', path: 'data/out/session.json', system: false }]);

    const second = await calls.create(OWNER, { from: 'data/out' });
    const turns = await calls.turns(OWNER, second.id);
    expect(turns.slice(0, 2).map((t) => t.role)).toEqual(['user', 'model']);
    expect((await calls.status(OWNER, second.id)).session).toEqual((await calls.status(OWNER, id)).session);
    expect(second.id).not.toBe(id);
  });

  it('dispose: 畳んだ知らせが届き、そのあとは「無い」', async () => {
    const w = world();
    const { calls, sent } = callsOf(w);
    const { id } = await calls.create(OWNER, {});
    w.spawn('helper', id);

    expect(await calls.dispose(OWNER, id)).toBe(true);

    expect(sent.at(-1)).toEqual({
      pid: 'viewer',
      action: 'engine:event',
      payload: { id, event: 'disposed', data: { reason: 'owner_request' } },
    });
    expect(w.killed).toEqual(['helper']);
    await expect(calls.status(OWNER, id)).rejects.toThrow('not found');
    await expect(calls.dispose(OWNER, id)).rejects.toThrow('not found');
    expect(await calls.list(OWNER)).toEqual([]);
  });
});
