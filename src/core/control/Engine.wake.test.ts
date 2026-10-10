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

/** ai.task の実体（chat.append が system ロールで積む形）。本文は常に [{ text }] に正規化されている */
function systemTask(h: ReturnType<typeof createHarness>, text = 'do it') {
  return h.history.append('system', [{ text: `<event type="system_task">\n${text}\n</event>` }], {
    type: 'event_log',
    eventType: 'system_task',
    trigger_llm: true,
    source: 'daemon',
  });
}

describe('system_task（ai.task）の扱い — T-0638', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('本文が [{ text }] に正規化されていても、連続実行の上限と回数を解く', async () => {
    const h = createHarness();
    (h.engine as any).haltedByToolCap = true;
    (h.engine as any).continuousToolCount = 7;

    systemTask(h);
    expect((h.engine as any).haltedByToolCap).toBe(false);
    expect((h.engine as any).continuousToolCount).toBe(0);
    await h.flush();
    expect(h.woke()).toBe(true);
  });

  it('eventType の無い古い形（本文が文字列）も解く', () => {
    const h = createHarness();
    (h.engine as any).haltedByToolCap = true;
    h.history.append('system', '<event type="system_task">\nx\n</event>', { type: 'event_log', trigger_llm: true });
    expect((h.engine as any).haltedByToolCap).toBe(false);
  });

  it('普通の event_log（ai.log）は解かない', () => {
    const h = createHarness();
    (h.engine as any).haltedByToolCap = true;
    h.history.append('system', [{ text: '<event type="app_event">\nx\n</event>' }], {
      type: 'event_log',
      eventType: 'app_event',
      trigger_llm: true,
    });
    expect((h.engine as any).haltedByToolCap).toBe(true);
  });

  it('isSystemTask は meta.type が event_log でなければ偽（本文に文字列があっても）', () => {
    expect(
      Engine.isSystemTask({
        role: 'user',
        content: '<event type="system_task">x</event>',
        meta: { type: 'message' },
      } as any),
    ).toBe(false);
  });

  it('停止（chat.reset）のあとに積んだだけでは起きない —— chat:append は wake なら requestEvaluation を呼ぶ', async () => {
    const h = createHarness();
    h.engine.stop(); // chat.reset はアイドル中でも stop() を呼ぶので stopRequested が残る
    systemTask(h);
    await h.flush();
    expect(h.woke()).toBe(false); // 積むだけの経路（旧 chat:append）は予約が捨てられる

    h.engine.requestEvaluation(); // 直した chat:append が wake のときに呼ぶ
    await h.flush();
    expect(h.woke()).toBe(true);
  });
});
