/**
 * Engine.requestEvaluation / status / injectUserTurn の戻り（MetaOS.chat の実体。T-0634）。
 * 起床の規則（_evaluateWakeUp は履歴だけを見る）を requestEvaluation が破らないことを見る。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Engine, TurnType } from './Engine';

function createHarness() {
  const turns: any[] = [];
  const subscribers: Function[] = [];
  const history = {
    on: (_event: string, cb: Function) => {
      subscribers.push(cb);
      return () => {};
    },
    get: () => turns,
    append: (role: string, content: any, meta: any) => {
      const turn = { id: `t${turns.length}`, timestamp: turns.length, role, content, meta };
      turns.push(turn);
      subscribers.forEach((cb) => cb({ type: 'append', turn }));
      return turn;
    },
    update: () => null,
  };
  // 投影に届いたら「起きた」。先へは番兵の例外で進ませない
  const createContext = vi.fn(async () => {
    throw new Error('reached-projector');
  });
  const configManager = { get: () => ({}) };
  const engine = new Engine(
    { history, vfs: {}, configManager } as any,
    { createContext } as any,
    { generateStream: vi.fn() } as any,
    { parse: () => [] } as any,
    { getRegisteredToolNames: () => [] } as any,
    {},
    'realtime',
    1500,
  );
  const stops: any[] = [];
  engine.on('loop_stop', (d: any) => stops.push(d));
  const flush = () => vi.advanceTimersByTimeAsync(2000);
  const woke = () => createContext.mock.calls.length > 0;
  return { engine, history, turns, stops, flush, woke };
}

describe('Engine.requestEvaluation（chat.wake）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('停止のあとでも、未読の発言があれば起きる', async () => {
    const h = createHarness();
    h.history.append('user', 'hi', { trigger_llm: true });
    h.engine.stop(); // 予約を取り消し、stopRequested を立てる
    await h.flush();
    expect(h.woke()).toBe(false);

    h.engine.requestEvaluation();
    await h.flush();
    expect(h.woke()).toBe(true);
  });

  it('未読が無ければ idle で終わり、空の応答を作らない', async () => {
    const h = createHarness();
    h.history.append('user', 'hi', { trigger_llm: true });
    h.history.append('model', 'done', { type: TurnType.MODEL_THOUGHT });
    await h.flush();
    h.stops.length = 0;

    h.engine.requestEvaluation();
    await h.flush();
    expect(h.woke()).toBe(false);
    expect(h.stops.map((s) => s.reason)).toEqual(['idle']);
    expect(h.turns.length).toBe(2);
  });

  it('連続実行の上限で止まっている間は起こさない（それを解くのは利用者の発言）', async () => {
    const h = createHarness();
    h.history.append('user', 'hi', { trigger_llm: true });
    h.engine.stop();
    (h.engine as any).haltedByToolCap = true;

    h.engine.requestEvaluation();
    await h.flush();
    expect(h.woke()).toBe(false);

    (h.engine as any).haltedByToolCap = false;
    h.engine.requestEvaluation();
    await h.flush();
    expect(h.woke()).toBe(true);
  });
});

describe('Engine.status / injectUserTurn', () => {
  it('status は走っていない・結果待ち 0 から始まる', () => {
    const h = createHarness();
    expect(h.engine.status()).toEqual({ running: false, busy: false, outstandingTools: 0 });
  });

  it('injectUserTurn は積んだターンを返す（chat.append が id を返すため）', async () => {
    vi.useFakeTimers();
    try {
      const h = createHarness();
      const turn = await h.engine.injectUserTurn([{ text: 'x' }], { trigger_llm: false, source: 'p' });
      expect(turn.id).toBe('t0');
      expect(turn.meta).toEqual({ type: TurnType.USER_INPUT, trigger_llm: false, source: 'p' });
      expect(h.turns[0]).toBe(turn);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('停止のあとの履歴の変更（/reset の申し送りが起こさなかった理由）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stop() のあとに trigger_llm: true の system ターンを積んでも起きない。requestEvaluation で起きる', async () => {
    const h = createHarness();
    h.engine.stop();
    h.history.append('system', '<event type="session_reset">carried</event>', { type: 'event_log', trigger_llm: true });
    await h.flush();
    expect(h.woke()).toBe(false);

    h.engine.requestEvaluation();
    await h.flush();
    expect(h.woke()).toBe(true);
  });
});
