/**
 * src/core/control/Engine.dispose.test.ts
 * エンジンを畳む口と、エンジンが自分で持つタイマー（T-0903）。
 *
 * エンジンを複数作れるようにする下ごしらえ。畳んだエンジンは:
 *   1. 履歴を聞かない（以後の変更で起きない）
 *   2. 自分が預かったタイマー（set_timer）を鳴らさない
 *   3. 畳んだあとに返った道具の結果を捨てる（枠も新しいターンも書かない）
 * stop() とは違う —— 止めただけのエンジンには、遅い結果が新しいターンとして届く。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Engine, TurnType } from './Engine';
import { Translator } from '../cognitive/Translator';

interface HarnessOptions {
  /** モデルの出力（省けば空 ＝ 道具を投げずに idle で終わる） */
  output?: string;
  /** history.on が「聞くのをやめる口」を返さない偽物にする */
  onReturnsNothing?: boolean;
}

function createHarness(opts: HarnessOptions = {}) {
  const turns: any[] = [];
  /** 履歴が出した知らせ（種類だけ） */
  const changes: string[] = [];
  let subscribers: Function[] = [];
  const notify = (payload: any) => {
    changes.push(payload.type);
    subscribers.forEach((cb) => cb(payload));
  };
  const history = {
    on: (_event: string, cb: Function) => {
      subscribers.push(cb);
      if (opts.onReturnsNothing) return undefined;
      return () => {
        subscribers = subscribers.filter((x) => x !== cb);
      };
    },
    get: () => turns,
    append: (role: string, content: any, meta: any) => {
      const turn = { id: `t${turns.length}`, timestamp: 0, role, content, meta: { ...meta } };
      turns.push(turn);
      notify({ type: 'append', turn });
      return turn;
    },
    update: (id: string, content: any, meta: any) => {
      const turn = turns.find((t) => t.id === id);
      if (!turn) return null;
      if (content !== undefined) turn.content = content;
      turn.meta = { ...turn.meta, ...meta };
      notify({ type: 'update', turn });
      return turn;
    },
  };
  /** 投げられた道具を、試験が返すまで止めておく */
  const pending: Array<(result: any) => void> = [];
  const tools = {
    getRegisteredToolNames: () => ['get_time', 'yield'],
    execute: vi.fn(() => new Promise((resolve) => pending.push(resolve))),
  };
  const createContext = vi.fn(async () => []);
  const llm = {
    generateStream: vi.fn(async (_m: any, onChunk: (c: string) => void) => {
      onChunk(opts.output ?? '');
    }),
  };
  const engine = new Engine(
    { history, vfs: {}, configManager: { get: () => ({}) } } as any,
    { createContext } as any,
    llm as any,
    new Translator(),
    tools as any,
    {},
    'realtime',
    1500,
    'e1',
  );
  /** エンジンが出した知らせ */
  const events: Array<[string, any]> = [];
  for (const name of ['turn_start', 'stream_chunk', 'turn_end', 'loop_stop']) {
    engine.on(name, (data: any) => events.push([name, data]));
  }
  return {
    engine,
    history,
    turns,
    changes,
    events,
    createContext,
    tools,
    subscriberCount: () => subscribers.length,
    /** 止めてある道具を全部返す */
    release: (result: any) => pending.splice(0).forEach((resolve) => resolve(result)),
  };
}

const TOOL_OUTPUT = '<get_time />\n<yield />';

/** 発言 → 起床 → 道具を投げて [Pending] の枠が積まれるところまで進める */
const dispatch = async (h: ReturnType<typeof createHarness>) => {
  await h.engine.injectUserTurn('go');
  await vi.advanceTimersByTimeAsync(1600);
  await vi.advanceTimersByTimeAsync(200);
};

describe('Engine.dispose（T-0903）', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('履歴を聞くのをやめる —— 以後の発言では起きない', async () => {
    const h = createHarness();
    expect(h.subscriberCount()).toBe(1);

    h.engine.dispose();
    expect(h.subscriberCount()).toBe(0);

    h.history.append('user', 'hi', { trigger_llm: true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.createContext).not.toHaveBeenCalled();
  });

  it('予約済みの評価を取り消す', async () => {
    const h = createHarness();
    h.history.append('user', 'hi', { trigger_llm: true }); // 1.5 秒後の評価が予約される
    h.engine.dispose();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(5000);
    expect(h.createContext).not.toHaveBeenCalled();
  });

  it('履歴の on が何も返さなくても投げない。聞こえてしまった変更でも、頼まれても、起きない', async () => {
    const h = createHarness({ onReturnsNothing: true });
    expect(() => h.engine.dispose()).not.toThrow();
    expect(h.subscriberCount()).toBe(1); // 偽物はやめる口を持たない

    h.history.append('user', 'hi', { trigger_llm: true });
    h.engine.requestEvaluation();
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.createContext).not.toHaveBeenCalled();
  });

  it('2 度畳んでも、止まった知らせは 1 度だけ', () => {
    const h = createHarness();
    h.engine.dispose();
    h.engine.dispose();
    expect(h.events).toEqual([['loop_stop', { reason: 'abort' }]]);
  });

  it('畳んだあとに返った道具の結果は捨てる（枠も新しいターンも書かない）', async () => {
    const h = createHarness({ output: TOOL_OUTPUT });
    await dispatch(h);
    expect(h.tools.execute).toHaveBeenCalled();
    expect(h.turns.map((t) => t.role)).toEqual(['user', 'model', 'system']);

    h.engine.dispose();
    const turnsBefore = JSON.stringify(h.turns);
    const changesBefore = h.changes.length;
    const eventsBefore = h.events.length;

    h.release({ log: '12:00', trigger_llm: true });
    await vi.advanceTimersByTimeAsync(5000);

    expect(JSON.stringify(h.turns)).toBe(turnsBefore);
    expect(h.changes.length).toBe(changesBefore);
    expect(h.events.length).toBe(eventsBefore);
    expect(h.createContext).toHaveBeenCalledTimes(1);
  });

  it('畳んだあとは、順番待ちだった道具を走らせない（そのあと発言が置かれても）', async () => {
    const h = createHarness({ output: '<get_time />\n<get_time />\n<yield />' });
    await h.engine.injectUserTurn('go');
    await vi.advanceTimersByTimeAsync(1500);
    // 束の 1 本目だけが走り出している（2 本目以降は 50 ms ずつ遅れて始まる）
    expect(h.tools.execute).toHaveBeenCalledTimes(1);

    h.engine.dispose();
    await h.engine.injectUserTurn('again'); // 停止要求を解く口。畳んだことは解けない
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.tools.execute).toHaveBeenCalledTimes(1);
  });

  it('（対比）止めただけなら、遅い結果は新しいターンとして届く', async () => {
    const h = createHarness({ output: TOOL_OUTPUT });
    await dispatch(h);
    h.engine.stop();
    const countBefore = h.turns.length;

    h.release({ log: '12:00', trigger_llm: true });
    await vi.advanceTimersByTimeAsync(200);

    expect(h.turns.length).toBeGreaterThan(countBefore);
    const late = h.turns[h.turns.length - 1];
    expect(late.role).toBe('system');
    expect(late.content[0].output.log).toContain('[Late result of the tool dispatched in an earlier turn]');
  });
});

describe('Engine.scheduleSystemEvent（set_timer の実体。T-0903）', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('時間が来たら system のターンを積み、知らせ、起こす', async () => {
    const h = createHarness();
    h.engine.scheduleSystemEvent(30_000, 'timer_alert', 'tea');

    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.turns).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(h.turns).toHaveLength(1);
    expect(h.turns[0].role).toBe('system');
    expect(h.turns[0].meta).toEqual({ type: TurnType.TOOL_EXECUTION, trigger_llm: true });
    expect(h.turns[0].content).toEqual([
      { actionType: 'timer_alert', output: { ui: '⏰ tea', log: '[ASYNC EVENT: timer_alert] tea' } },
    ]);
    expect(h.events.map((e) => e[0])).toEqual(['turn_end']);

    await vi.advanceTimersByTimeAsync(1600);
    expect(h.createContext).toHaveBeenCalledTimes(1);
  });

  it('止めたあとでも鳴り、起こす（停止はタイマーを消さない）', async () => {
    const h = createHarness();
    h.engine.scheduleSystemEvent(1000, 'timer_alert', 'tea');
    h.engine.stop();

    await vi.advanceTimersByTimeAsync(1000);
    expect(h.turns).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1600);
    expect(h.createContext).toHaveBeenCalledTimes(1);
  });

  it('畳むと、預かっていたタイマーは鳴らない。畳んだあとの頼みは何もしない', async () => {
    const h = createHarness();
    h.engine.scheduleSystemEvent(1000, 'timer_alert', 'a');
    h.engine.scheduleSystemEvent(2000, 'timer_alert', 'b');
    h.engine.dispose();
    expect(vi.getTimerCount()).toBe(0);

    h.engine.scheduleSystemEvent(500, 'timer_alert', 'c');
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.turns).toHaveLength(0);
  });

  it('畳んだエンジンに直接知らせても、何も積まない', () => {
    const h = createHarness();
    h.engine.dispose();
    h.engine.injectSystemEvent('timer_alert', 'late');
    expect(h.turns).toHaveLength(0);
    expect(h.events.map((e) => e[0])).toEqual(['loop_stop']);
  });

  it('別のエンジンを畳んでも、自分のタイマーは鳴る', async () => {
    const a = createHarness();
    const b = createHarness();
    a.engine.scheduleSystemEvent(1000, 'timer_alert', 'a');
    b.engine.scheduleSystemEvent(1000, 'timer_alert', 'b');
    a.engine.dispose();

    await vi.advanceTimersByTimeAsync(1000);
    expect(a.turns).toHaveLength(0);
    expect(b.turns).toHaveLength(1);
  });
});
