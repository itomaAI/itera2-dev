/**
 * src/core/control/EngineBundle.test.ts
 * 束を作る関数（T-0903）。束を 2 つ作って、互いに独立であること・口の規則を見る。
 */
import { ROLE_PARTS } from '../../config/system_prompts';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createEngineBundle } from './EngineBundle';
import { ROOT_ENGINE_ID, TurnType } from './Engine';
import { ToolRegistry, type ToolGrant } from './ToolRegistry';
import { HistoryManager } from '../state/HistoryManager';
import { Translator } from '../cognitive/Translator';
import { TOOL_ANNOUNCE_DELAY_MS } from '../../config/tool_announce';

function world() {
  /** 道具の記録（tool_events に書かれる行） */
  const records: any[] = [];
  const registry = new ToolRegistry(undefined, { record: (e: any) => records.push(e) } as any);
  /** システムの道具 probe が受け取った文脈 */
  const contexts: any[] = [];
  registry.registerSystemTool('sys', 'System', {
    name: 'probe',
    description: 'p',
    impl: async (_params: any, context: any) => {
      contexts.push(context);
      return { log: 'probed', trigger_llm: false };
    },
  });

  function bundle(id: string, grant?: ToolGrant) {
    const history = new HistoryManager();
    const conversation = {
      reset: vi.fn(async (_options: any) => ({ archived: true, sessionId: 'n' })),
      putAttachment: vi.fn(async (_name: string, _blob: Blob) => 'p'),
      current: vi.fn(async () => ({ id: `s-${id}`, title: 'T', createdAt: 1, extra: 'not exposed' })),
      currentId: () => `s-${id}`,
    };
    const fs = { tag: `fs-${id}` } as any;
    const b = createEngineBundle({
      id,
      role: id === ROOT_ENGINE_ID ? 'root' : 'sub',
      history,
      vfs: {} as any,
      configManager: { get: () => ({}) } as any,
      translator: new Translator(),
      registry,
      grant,
      fs,
      conversation,
      contextLimit: async () => 1000,
      wakePolicy: 'realtime',
      wakeDebounceMs: 1500,
    });
    /** モデルの出力を順に返す（尽きたら空 ＝ 道具を投げずに終わる） */
    const outputs: string[] = [];
    const createContext = vi.fn(async () => []);
    const generateStream = vi.fn(async (_m: any, onChunk: (c: string) => void, _signal: any, _origin: any) => {
      onChunk(outputs.shift() ?? '');
    });
    b.engine.projector = { createContext } as any;
    b.engine.llm = { generateStream } as any;
    const events: Array<[string, any]> = [];
    for (const name of [
      'turn_start',
      'stream_chunk',
      'turn_end',
      'loop_stop',
      'turn_placed',
      'wake_requested',
    ] as const) {
      b.on(name, (data: any) => events.push([name, data]));
    }
    const names = () => events.map((e) => e[0]);
    return { b, history, conversation, fs, outputs, createContext, generateStream, events, names };
  }
  return { registry, records, contexts, bundle };
}

const settle = () => vi.advanceTimersByTimeAsync(2000);

describe('createEngineBundle: 束は互いに独立（T-0903）', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('会話は束ごと —— 片方に置いても、もう片方の会話は変わらず、起きもしない', async () => {
    const w = world();
    const root = w.bundle(ROOT_ENGINE_ID);
    const sub = w.bundle('e1');

    await root.b.post('user', 'hi', { trigger_llm: true });
    await settle();

    expect(root.history.get().map((t) => t.role)).toEqual(['user', 'model']);
    expect(root.createContext).toHaveBeenCalledTimes(1);
    expect(sub.history.get()).toEqual([]);
    expect(sub.createContext).not.toHaveBeenCalled();
    expect(sub.events).toEqual([]);
  });

  it('LLM には自分の id を名乗り、自分の会話の id を添える', async () => {
    const w = world();
    const root = w.bundle(ROOT_ENGINE_ID);
    const sub = w.bundle('e1');
    expect(root.b.id).toBe(ROOT_ENGINE_ID);
    expect(sub.b.engine.id).toBe('e1');

    await root.b.post('user', 'hi', { trigger_llm: true });
    await sub.b.post('user', 'hi', { trigger_llm: true });
    await settle();

    expect(root.generateStream.mock.calls[0][3]).toEqual({
      caller: ROOT_ENGINE_ID,
      engineTurn: true,
      tag: `s-${ROOT_ENGINE_ID}`,
    });
    expect(sub.generateStream.mock.calls[0][3]).toEqual({ caller: 'e1', engineTurn: true, tag: 's-e1' });
  });

  it('道具の見え方 —— システムの道具 → 自分の台帳 → 与えられた組。ルートの台帳を並べる継承は無い（T-0912）', () => {
    const w = world();
    const root = w.bundle(ROOT_ENGINE_ID);
    root.b.tools.registerDynamicTool('search', 'web', { description: 's' });
    root.b.tools.registerDynamicTool('mail', 'mailer', { description: 'm' });
    const sub = w.bundle('e1', { from: ROOT_ENGINE_ID, toolsets: ['web'] });
    const other = w.bundle('e2');
    sub.b.tools.registerDynamicTool('draw', 'canvas', { description: 'd' });

    expect(root.b.tools.getRegisteredToolNames()).toEqual(expect.arrayContaining(['probe', 'search', 'mail']));
    expect(root.b.tools.getRegisteredToolNames()).not.toContain('draw');
    expect(sub.b.tools.getRegisteredToolNames()).toEqual(expect.arrayContaining(['probe', 'draw', 'search']));
    expect(sub.b.tools.getRegisteredToolNames()).not.toContain('mail');
    expect(sub.b.tools.listToolSets().map((s) => s.id)).toEqual(['canvas', 'web']);
    // 与えられなかった束に見えるのは、システムの道具だけ
    expect(other.b.tools.listToolSets()).toEqual([]);
    expect(other.b.tools.getRegisteredToolNames()).toEqual(['probe']);
  });

  it('道具には束の取っ手が渡り、記録には呼んだエンジンの id が付く', async () => {
    const w = world();
    const root = w.bundle(ROOT_ENGINE_ID);
    const sub = w.bundle('e1');
    root.outputs.push('<probe />');
    sub.outputs.push('<probe />');

    await root.b.post('user', 'go', { trigger_llm: true });
    await sub.b.post('user', 'go', { trigger_llm: true });
    await settle();

    expect(w.contexts).toHaveLength(2);
    for (const h of [root, sub]) {
      const context = w.contexts.find((c) => c.engine === h.b.engine);
      expect(context.fs).toBe(h.fs);
      expect(context.tools).toBe(h.b.tools);
      // 会話の口は、道具に見せる 2 つだけ（いまの会話を訊く口は渡らない）
      expect(Object.keys(context.conversation).sort()).toEqual(['afterReset', 'putAttachment', 'reset']);
      // リセットのあとの 1 行は、束の役割から（道具にも、外からリセットする口にも同じ文）
      expect(context.conversation.afterReset).toBe(ROLE_PARTS[h.b.role].afterReset);
      expect(h.b.afterReset).toBe(ROLE_PARTS[h.b.role].afterReset);
      await context.conversation.reset({ summary: 'x', triggerLlm: true });
      expect(h.conversation.reset).toHaveBeenCalledWith({ summary: 'x', triggerLlm: true });
      // 画面とプロセスは束のものではない（組み立てが後から差す）
      expect(context.shell).toBeUndefined();
    }
    expect(w.records.map((r) => r.engine).sort()).toEqual(['e1', ROOT_ENGINE_ID].sort());
  });

  it('畳む —— その束だけが止まる。台帳は消え、置く口は断り、もう片方は動き続ける', async () => {
    const w = world();
    const root = w.bundle(ROOT_ENGINE_ID);
    const sub = w.bundle('e1');
    root.b.tools.registerDynamicTool('search', 'web', { description: 's' });
    sub.b.tools.registerDynamicTool('draw', 'canvas', { description: 'd' });
    sub.b.engine.scheduleSystemEvent(1000, 'timer_alert', 'x');

    sub.b.dispose();
    sub.b.dispose();
    sub.events.length = 0;

    await expect(sub.b.post('system', 'x', { trigger_llm: true })).rejects.toThrow(/disposed/);
    await expect(sub.b.post('user', 'x', { trigger_llm: true })).rejects.toThrow(/disposed/);
    await expect(sub.b.reset()).rejects.toThrow(/disposed/);
    sub.b.wake();
    sub.b.stop();
    await vi.advanceTimersByTimeAsync(5000);

    expect(sub.history.get()).toEqual([]);
    expect(sub.createContext).not.toHaveBeenCalled();
    expect(sub.conversation.reset).not.toHaveBeenCalled();
    expect(sub.names().filter((n) => n === 'turn_placed' || n === 'wake_requested')).toEqual([]);
    // 台帳は捨てられている（同じ id で口を作り直しても、前の登録は無い）
    expect(w.registry.viewFor('e1').getRegisteredToolNames()).not.toContain('draw');

    expect(root.b.tools.getRegisteredToolNames()).toContain('search');
    await root.b.post('user', 'hi', { trigger_llm: true });
    await settle();
    expect(root.createContext).toHaveBeenCalledTimes(1);
  });
});

describe('createEngineBundle: 束の口（T-0903）', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('post(user) —— エンジンが置く。知らせは turn_end、起こすときだけ wake_requested', async () => {
    const h = world().bundle(ROOT_ENGINE_ID);

    const turn = await h.b.post('user', [{ text: 'hi' }], { trigger_llm: true, source: 'app1' });
    expect(turn.role).toBe('user');
    expect(turn.meta).toMatchObject({ type: TurnType.USER_INPUT, trigger_llm: true, source: 'app1' });
    expect(h.events).toEqual([
      ['turn_end', { role: 'user', turn }],
      ['wake_requested', undefined],
    ]);
    await settle();
    expect(h.createContext).toHaveBeenCalledTimes(1);
  });

  it('post(user) —— trigger_llm が true でなければ置くだけ（省いても起こさない）', async () => {
    const h = world().bundle(ROOT_ENGINE_ID);

    const quiet = await h.b.post('user', 'memo', { trigger_llm: false });
    const omitted = await h.b.post('user', 'memo 2');
    expect(quiet.meta?.trigger_llm).toBe(false);
    expect(omitted.meta?.trigger_llm).toBe(false);
    expect(h.names()).toEqual(['turn_end', 'turn_end']);

    await settle();
    expect(h.createContext).not.toHaveBeenCalled();
    expect(h.names()).toEqual(['turn_end', 'turn_end', 'loop_stop']);
  });

  it('post(system) —— 置いて turn_placed。turn_end には相乗りしない', async () => {
    const h = world().bundle(ROOT_ENGINE_ID);

    const meta = { type: 'event_log', trigger_llm: false };
    const turn = await h.b.post('system', '<event type="file_edited">\nx\n</event>', meta);
    expect(h.history.get()).toEqual([turn]);
    // 履歴は meta に既定の visible: true を足す（渡した欄はそのまま）
    expect(turn.meta).toMatchObject(meta);
    expect(h.events).toEqual([['turn_placed', { turn }]]);

    await settle();
    expect(h.createContext).not.toHaveBeenCalled();
  });

  it('post(system) —— trigger_llm: true なら、停止のあとでも起こす。知らせは turn_placed → wake_requested', async () => {
    const h = world().bundle(ROOT_ENGINE_ID);
    h.b.stop();
    h.events.length = 0;

    await h.b.post('system', 'task', { type: 'event_log', eventType: 'system_task', trigger_llm: true });
    expect(h.names()).toEqual(['turn_placed', 'wake_requested']);

    await settle();
    expect(h.createContext).toHaveBeenCalledTimes(1);
  });

  it('wake —— 評価を頼んで wake_requested。未読が無ければ idle で終わる', async () => {
    const h = world().bundle(ROOT_ENGINE_ID);

    h.b.wake();
    expect(h.names()).toEqual(['wake_requested']);

    await settle();
    expect(h.events).toEqual([
      ['wake_requested', undefined],
      ['loop_stop', { reason: 'idle' }],
    ]);
    expect(h.createContext).not.toHaveBeenCalled();
  });

  it('reset —— 止めてから会話を空にする（起こさない）', async () => {
    const h = world().bundle(ROOT_ENGINE_ID);
    const stop = vi.spyOn(h.b.engine, 'stop');

    const result = await h.b.reset({ summary: 'S', restoreTools: false });

    expect(stop).toHaveBeenCalledTimes(1);
    expect(h.conversation.reset).toHaveBeenCalledTimes(1);
    expect(h.conversation.reset).toHaveBeenCalledWith({ summary: 'S', triggerLlm: false, restoreTools: false });
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(h.conversation.reset.mock.invocationCallOrder[0]);
    expect(result).toEqual({ archived: true, sessionId: 'n' });
  });

  it('statusInput —— エンジン・会話・上限。会話の名前は 3 つの欄だけ、取れなければ null', async () => {
    const h = world().bundle(ROOT_ENGINE_ID);
    await h.b.post('system', 'x', { trigger_llm: false });

    expect(await h.b.statusInput()).toEqual({
      // 置いた直後なので、評価の予約が在る（起こさない変更でも評価はする。T-0910）
      engine: { running: false, busy: false, outstandingTools: 0, scheduled: true },
      turns: h.history.get(),
      session: { id: `s-${ROOT_ENGINE_ID}`, title: 'T', createdAt: 1 },
      contextLimit: 1000,
    });

    h.conversation.current.mockRejectedValueOnce(new Error('no session'));
    expect((await h.b.statusInput()).session).toBeNull();
  });
});

describe('createEngineBundle: 道具の定義を会話に置く（T-0912 段 3）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const def = (name: string, body = name) => `<define_tag name="${name}">${body}</define_tag>`;
  const reg = (h: any, pid: string, name: string, body?: string) =>
    h.b.tools.registerDynamicTool(name, pid, { description: name, definition: def(name, body) });
  /** その束の会話に置かれた、定義のターン */
  const placed = (h: any) => h.history.get().filter((t: any) => t.meta?.eventType === 'tool_available');

  it('登録されると、少し待ってから 1 つのターンにまとめて置く。起こさない・turn_placed を知らせる', async () => {
    const w = world();
    const root = w.bundle(ROOT_ENGINE_ID);
    reg(root, 'web', 'search');
    await vi.advanceTimersByTimeAsync(TOOL_ANNOUNCE_DELAY_MS - 1);
    reg(root, 'web', 'fetch');
    expect(placed(root)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    const turns = placed(root);
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe('system');
    expect(turns[0].content).toBe(
      `<event type="tool_available">\n[System: Dynamic Tools Registered]\nThe following tools are now available from running processes:\n` +
        `<toolset name="Process: web" pid="web" description="Dynamic tools exposed by web">\n  ${def('search')}\n  ${def('fetch')}\n</toolset>\n</event>`,
    );
    expect(turns[0].meta).toMatchObject({ type: 'tool_available', eventType: 'tool_available', trigger_llm: false });
    expect(root.events.filter(([n]) => n === 'turn_placed').map(([, d]) => d.turn.id)).toEqual([turns[0].id]);

    await settle();
    expect(root.generateStream).not.toHaveBeenCalled();
    expect(root.history.get()).toHaveLength(1);
  });

  it('同じ定義の登録し直し（プロセスの起こし直し）では置かない。定義が変われば置く', async () => {
    const w = world();
    const root = w.bundle(ROOT_ENGINE_ID);
    reg(root, 'web', 'search');
    await settle();
    expect(placed(root)).toHaveLength(1);

    w.registry.removeToolsByPid('web');
    reg(root, 'web', 'search');
    await settle();
    expect(placed(root)).toHaveLength(1);

    reg(root, 'web', 'search', 'v2');
    await settle();
    expect(placed(root)).toHaveLength(2);
    expect(placed(root)[1].content).toContain(def('search', 'v2'));
  });

  it('会話が空になる・入れ替わると控えを捨てる: そのあとの登録し直しは置く。会話の口が全部引いたあとは置かない', async () => {
    const w = world();
    const root = w.bundle(ROOT_ENGINE_ID);
    reg(root, 'web', 'search');
    await settle();

    // 空にして、積み直さない（定義は会話に無い）→ 起こし直しで入る
    root.history.clear();
    w.registry.removeToolsByPid('web');
    reg(root, 'web', 'search');
    await settle();
    expect(placed(root)).toHaveLength(1);

    // 入れ替えて、積み直さない → 起こし直しで入る
    root.history.load([]);
    w.registry.removeToolsByPid('web');
    reg(root, 'web', 'search');
    await settle();
    expect(placed(root)).toHaveLength(1);

    // 入れ替えて、会話の口が全部引いた（積み直した）→ 起こし直しでは入らない
    root.history.load([]);
    expect(root.b.tools.restoreDefinitions()).toHaveLength(1);
    w.registry.removeToolsByPid('web');
    reg(root, 'web', 'search');
    await settle();
    expect(placed(root)).toEqual([]);
  });

  it('与えられた組に入った道具は、与えられた束の会話にも置く。与えられていない束には置かない', async () => {
    const w = world();
    const root = w.bundle(ROOT_ENGINE_ID);
    reg(root, 'web', 'search');
    reg(root, 'mailer', 'mail');
    await settle();
    const sub = w.bundle('e1', { from: ROOT_ENGINE_ID, toolsets: ['web'] });
    const other = w.bundle('e2');
    sub.b.tools.restoreDefinitions(); // 始まりに、会話の口が全部引く

    reg(root, 'web', 'fetch');
    reg(root, 'mailer', 'send');
    await settle();
    expect(placed(sub)).toHaveLength(1);
    expect(placed(sub)[0].content).toContain(def('fetch'));
    expect(placed(sub)[0].content).not.toContain('name="search"');
    expect(placed(sub)[0].content).not.toContain('name="send"');
    expect(sub.events.filter(([n]) => n === 'turn_placed')).toHaveLength(1);
    expect(sub.generateStream).not.toHaveBeenCalled();
    expect(placed(other)).toEqual([]);
    expect(placed(root)).toHaveLength(2);
  });

  it('畳むと、待っていた知らせは置かれない', async () => {
    const w = world();
    const root = w.bundle(ROOT_ENGINE_ID);
    const sub = w.bundle('e1', { from: ROOT_ENGINE_ID, toolsets: ['web'] });
    reg(root, 'web', 'search');
    sub.b.dispose();
    await settle();
    expect(sub.history.get()).toEqual([]);
    expect(placed(root)).toHaveLength(1);
  });
});
