/**
 * src/core/control/Engine.stop.test.ts
 * 生成の回（_ping）の中の stop()（T-0918）。
 *
 * 守りたいこと:
 *   1. 回の中で止めたら、その回の終わりに loop_stop(abort) がちょうど 1 度出る。
 *      アダプタが中断を AbortError にしても（throw）、黙って普通の終わりにしても（silent。Chromium で起きていた形）同じ。2 度押しても 1 度
 *   2. 止めた回では道具の束を作らない（[Pending] の枠を積まない・道具を走らせない）。流れた文は model のターンに status: 'error' で残る
 *   3. 投影の中で止めたら、空の model のターンを積まず、アダプタを呼ばない（理由は abort）
 *   4. 流れのあと〜回の終わりの前の同期の窓（turn_end(model)・警告の turn_end(system)・枠の turn_end(system)・最初の道具の execute）で止めても 1 度
 *   5. 止めた直後の発言は取りこぼさない: turn_end(model) → loop_stop(abort) → 次の回の turn_start
 *   6. 回の外の stop()（道具の段・止まっているとき）は、いままでどおりその場で 1 度
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Engine, PENDING_LOG, STOPPED_EVENT_TYPE } from './Engine';
import { Translator } from '../cognitive/Translator';

const GAP = 25;
const FIRST = ['<memo>hello', ' world</memo>\n', '<write path="out.txt">', 'probe', '</write>\n', '<yield />'];
const SECOND = ['<memo>again</memo>'];

type AdapterKind = 'throw' | 'silent';

/** 塊を GAP ms おきに流す偽のアダプタ。中断されたら、throw は AbortError を投げ、silent はそこまでで普通に返す */
function fakeAdapter(kind: AdapterKind, script: (cycle: number) => string[]) {
  let cycle = 0;
  const generateStream = vi.fn(async (_m: any, onChunk: (c: string) => void, signal?: AbortSignal) => {
    const chunks = script(++cycle);
    const wait = (ms: number) =>
      new Promise<boolean>((resolve) => {
        if (signal?.aborted) return resolve(false);
        const onAbort = () => {
          clearTimeout(timer);
          resolve(false);
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve(true);
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    const aborted = () => {
      if (kind === 'throw') throw new DOMException('Aborted', 'AbortError');
      return { provider: 'fake', model: 'fake', usage: null, stopReason: null };
    };
    for (const c of chunks) {
      if (!(await wait(GAP))) return aborted();
      onChunk(c);
    }
    if (!(await wait(GAP))) return aborted();
    return { provider: 'fake', model: 'fake', usage: null, stopReason: 'end_turn' };
  });
  return { generateStream };
}

interface HarnessOptions {
  adapter: AdapterKind;
  /** 1 回目の生成の塊（省けば FIRST） */
  first?: string[];
  debounceMs?: number;
}

function createHarness(opts: HarnessOptions) {
  const turns: any[] = [];
  const subscribers: Function[] = [];
  const notify = (payload: any) => subscribers.forEach((cb) => cb(payload));
  const history = {
    on: (_event: string, cb: Function) => {
      subscribers.push(cb);
      return () => {};
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
      turn.content = content;
      turn.meta = { ...turn.meta, ...meta };
      notify({ type: 'update', turn });
      return turn;
    },
  };
  /** 投影の中で呼ぶ口（試験が差す） */
  let inProjection: (() => void) | null = null;
  const createContext = vi.fn(async () => {
    inProjection?.();
    await new Promise((r) => setTimeout(r, 5));
    return [];
  });
  const first = opts.first ?? FIRST;
  const llm = fakeAdapter(opts.adapter, (cycle) => (cycle === 1 ? first : SECOND));
  /** 道具の execute の中で呼ぶ口（試験が差す） */
  let inExecute: ((action: any) => void) | null = null;
  const tools = {
    getRegisteredToolNames: () => ['write', 'yield', 'report'],
    execute: vi.fn(async (action: any) => {
      inExecute?.(action);
      await new Promise((r) => setTimeout(r, 60));
      return { log: `ok ${action.type}`, ui: `ok ${action.type}`, trigger_llm: false };
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
    opts.debounceMs ?? 10,
    'e1',
  );
  /** 知らせの並び（STOP は試験が stop() を呼んだ所） */
  const seq: string[] = [];
  const listeners: Record<string, Array<(d: any) => void>> = { turn_start: [], stream_chunk: [], turn_end: [] };
  engine.on('turn_start', (d: any) => {
    seq.push(`turn_start(${d.role})`);
    listeners.turn_start.forEach((cb) => cb(d));
  });
  engine.on('stream_chunk', (c: string) => listeners.stream_chunk.forEach((cb) => cb(c)));
  engine.on('turn_end', (d: any) => {
    const kind = d.role === 'model' ? `model:${d.turn?.meta?.status}` : d.role;
    seq.push(`turn_end(${kind})`);
    listeners.turn_end.forEach((cb) => cb(d));
  });
  engine.on('loop_stop', (d: any) => seq.push(`loop_stop(${d?.reason})`));

  const stop = (options?: any) => {
    seq.push('STOP');
    engine.stop(options);
  };
  const afterStop = () => seq.slice(seq.indexOf('STOP') + 1);
  return {
    engine,
    turns,
    seq,
    tools,
    llm,
    createContext,
    stop,
    afterStop,
    loopStopsAfterStop: () => afterStop().filter((e) => e.startsWith('loop_stop')),
    onChunk: (cb: (c: string, i: number) => void) => {
      let i = -1;
      listeners.stream_chunk.push((c) => cb(c, ++i));
    },
    onTurnEnd: (cb: (d: any) => void) => listeners.turn_end.push(cb),
    setInProjection: (cb: () => void) => (inProjection = cb),
    setInExecute: (cb: (a: any) => void) => (inExecute = cb),
    modelTurn: () => turns.find((t) => t.role === 'model'),
    frames: () => turns.filter((t) => t.meta?.type === 'tool_execution'),
    /** 発言 → 回を最後まで進める */
    go: async () => {
      await engine.injectUserTurn('go');
      await vi.advanceTimersByTimeAsync(1000);
    },
    /** 次の発言で起きるか（生成が 1 回増えるか） */
    wakesAgain: async () => {
      const before = createContext.mock.calls.length;
      await engine.injectUserTurn('again');
      await vi.advanceTimersByTimeAsync(1000);
      return createContext.mock.calls.length > before;
    },
  };
}

const idle = { running: false, busy: false, outstandingTools: 0, scheduled: false };

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const POSITIONS: Array<[string, number]> = [
  ['mid_text', 0],
  ['open_tag', 2],
  ['closed_tag', 4],
  ['after_terminal', 5],
];

describe('流れの途中の stop()', () => {
  for (const adapter of ['silent', 'throw'] as AdapterKind[])
    for (const [position, index] of POSITIONS)
      for (const mode of ['sync', 'async'] as const) {
        it(`${adapter} × ${position} × ${mode}: loop_stop(abort) が 1 度。束は作らない。文は error のターンに残る`, async () => {
          const h = createHarness({ adapter });
          h.onChunk((_c, i) => {
            if (i !== index) return;
            if (mode === 'sync') h.stop();
            else setTimeout(h.stop, 0);
          });
          await h.go();

          expect(h.loopStopsAfterStop()).toEqual(['loop_stop(abort)']);
          expect(h.afterStop()).toEqual(['turn_end(system)', 'turn_end(model:error)', 'loop_stop(abort)']);
          expect(h.frames()).toHaveLength(0);
          expect(h.tools.execute).not.toHaveBeenCalled();
          expect(h.modelTurn().content).toBe(FIRST.slice(0, index + 1).join(''));
          expect(h.modelTurn().meta.status).toBe('error');
          expect(h.modelTurn().meta.stopReason).toBeUndefined();
          expect(h.engine.status()).toEqual(idle);
          expect(await h.wakesAgain()).toBe(true);
        });
      }

  it('2 度押しても loop_stop(abort) は 1 度', async () => {
    const h = createHarness({ adapter: 'silent' });
    h.onChunk((_c, i) => {
      if (i !== 2) return;
      h.stop();
      h.stop();
    });
    await h.go();
    expect(h.loopStopsAfterStop()).toEqual(['loop_stop(abort)']);
  });

  it('（対比）回が終わったあとにもう 1 度押せば、その場で 1 度出る（止まっているときと同じ）', async () => {
    const h = createHarness({ adapter: 'silent' });
    h.onChunk((_c, i) => {
      if (i === 2) h.stop();
    });
    await h.go();
    h.stop();
    expect(h.seq.filter((e) => e === 'loop_stop(abort)')).toHaveLength(2);
  });
});

describe('投影の中の stop()', () => {
  for (const adapter of ['silent', 'throw'] as AdapterKind[])
    for (const mode of ['sync', 'async'] as const) {
      it(`${adapter} × ${mode}: 空の model のターンを積まず、アダプタを呼ばない。理由は abort`, async () => {
        const h = createHarness({ adapter });
        h.setInProjection(() => {
          h.setInProjection(() => {});
          if (mode === 'sync') h.stop();
          else setTimeout(h.stop, 0);
        });
        await h.go();
        expect(h.afterStop()).toEqual(['loop_stop(abort)']);
        expect(h.seq).not.toContain('turn_start(model)');
        expect(h.modelTurn()).toBeUndefined();
        expect(h.llm.generateStream).not.toHaveBeenCalled();
        expect(h.engine.status()).toEqual(idle);
        expect(await h.wakesAgain()).toBe(true);
      });
    }
});

describe('流れのあと〜回の終わりの前の同期の窓での stop()', () => {
  for (const adapter of ['silent', 'throw'] as AdapterKind[]) {
    it(`${adapter} × turn_end(model) の聞き手の中: 1 度。束は作らない`, async () => {
      const h = createHarness({ adapter });
      h.onTurnEnd((d) => {
        if (d.role === 'model' && h.seq.indexOf('STOP') < 0) h.stop();
      });
      await h.go();
      expect(h.afterStop()).toEqual(['turn_end(system)', 'loop_stop(abort)']);
      expect(h.frames()).toHaveLength(0);
      expect(h.tools.execute).not.toHaveBeenCalled();
      expect(await h.wakesAgain()).toBe(true);
    });

    it(`${adapter} × 警告（終端タグの後ろ）の turn_end(system) の聞き手の中: 1 度。束は作らない`, async () => {
      const h = createHarness({ adapter, first: [...FIRST, '\ntrailing words'] });
      h.onTurnEnd((d) => {
        if (d.role === 'system' && String(d.turn?.content).includes('syntax_warning') && h.seq.indexOf('STOP') < 0)
          h.stop();
      });
      await h.go();
      expect(h.afterStop()).toEqual(['turn_end(system)', 'loop_stop(abort)']);
      expect(h.frames()).toHaveLength(0);
      expect(h.tools.execute).not.toHaveBeenCalled();
    });

    it(`${adapter} × [Pending] の枠の turn_end(system) の聞き手の中: 1 度。道具は走らない。枠は積んだまま`, async () => {
      const h = createHarness({ adapter });
      h.onTurnEnd((d) => {
        const isFrame =
          Array.isArray(d.turn?.content) && d.turn.content.some((e: any) => e.output?.log === PENDING_LOG);
        if (d.role === 'system' && isFrame && h.seq.indexOf('STOP') < 0) h.stop();
      });
      await h.go();
      expect(h.loopStopsAfterStop()).toEqual(['loop_stop(abort)']);
      expect(h.tools.execute).not.toHaveBeenCalled();
      expect(h.frames()).toHaveLength(1);
      // 枠は書き換えない（モデルが読む文は積んだときのまま）
      expect(h.frames()[0].content.map((e: any) => e.output.log)).toEqual([PENDING_LOG, PENDING_LOG]);
      expect(h.engine.status()).toEqual(idle);
      expect(await h.wakesAgain()).toBe(true);
    });

    it(`${adapter} × 最初の道具の execute の中: 1 度。2 本目は走らない`, async () => {
      const h = createHarness({ adapter });
      h.setInExecute(() => {
        if (h.seq.indexOf('STOP') < 0) h.stop();
      });
      await h.go();
      expect(h.loopStopsAfterStop()).toEqual(['loop_stop(abort)']);
      expect(h.tools.execute).toHaveBeenCalledTimes(1);
      expect(h.tools.execute.mock.calls[0][0].type).toBe('write');
      expect(h.engine.status()).toEqual(idle);
    });
  }
});

describe('止めた直後の発言', () => {
  for (const debounceMs of [0, 10])
    for (const mode of ['sync', 'async'] as const)
      it(`待ち ${debounceMs}ms × ${mode}: turn_end(model) → loop_stop(abort) → 次の回の turn_start。取りこぼさない`, async () => {
        const h = createHarness({ adapter: 'silent', debounceMs });
        const stopAndSpeak = () => {
          h.stop();
          void h.engine.injectUserTurn('next');
        };
        h.onChunk((_c, i) => {
          if (i !== 2) return;
          if (mode === 'sync') stopAndSpeak();
          else setTimeout(stopAndSpeak, 0);
        });
        await h.go();
        const after = h.afterStop().filter((e) => e !== 'turn_end(user)');
        expect(after.slice(0, 4)).toEqual([
          'turn_end(system)',
          'turn_end(model:error)',
          'loop_stop(abort)',
          'turn_start(model)',
        ]);
        expect(h.loopStopsAfterStop()).toEqual(['loop_stop(abort)', 'loop_stop(idle)']);
        expect(h.llm.generateStream).toHaveBeenCalledTimes(2);
      });
});

describe('（対比）回の外の stop() は、いままでどおりその場で 1 度', () => {
  it('道具の段: その場で loop_stop(abort)。枠は書き換えない', async () => {
    const h = createHarness({ adapter: 'silent' });
    h.setInExecute(() => {});
    await h.engine.injectUserTurn('go');
    // 生成が終わり、1 本目の道具が走っている（回は終わっている）
    await vi.advanceTimersByTimeAsync(10 + 5 + GAP * 7 + 5);
    expect(h.tools.execute).toHaveBeenCalledTimes(1);
    expect(h.engine.status().running).toBe(false);
    h.stop();
    expect(h.afterStop().slice(0, 2)).toEqual(['turn_end(system)', 'loop_stop(abort)']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.loopStopsAfterStop()).toEqual(['loop_stop(abort)']);
    expect(h.tools.execute).toHaveBeenCalledTimes(1);
    const logs = h.frames()[0].content.map((e: any) => e.output.log);
    expect(logs).toEqual([PENDING_LOG, PENDING_LOG]);
  });

  it('止まっているとき: 押すたびにその場で 1 度', () => {
    const h = createHarness({ adapter: 'silent' });
    h.stop();
    h.stop();
    expect(h.seq).toEqual(['STOP', 'loop_stop(abort)', 'STOP', 'loop_stop(abort)']);
  });
});
describe('止めた束の、まだ始まっていない道具', () => {
  it('道具の段で止めた直後に発言が来ても、見捨てた束の 2・3 本目は始めない', async () => {
    const h = createHarness({ adapter: 'silent', first: ['<write path="a">x</write>\n<report>r</report>\n<yield />'] });
    let calls = 0;
    h.setInExecute(() => {
      if (++calls !== 1) return;
      // 回が終わってから（道具の段）止め、すぐ発言する
      setTimeout(() => {
        h.stop();
        void h.engine.injectUserTurn('next');
      }, 0);
    });
    await h.go();
    expect(h.tools.execute.mock.calls.map((c: any) => c[0].type)).toEqual(['write']);
    // 発言では起きる（2 回目の生成は道具を投げない）
    expect(h.llm.generateStream).toHaveBeenCalledTimes(2);
  });

  it('止めた直後にタイマーの知らせが来ても、見捨てた束の道具は始めない', async () => {
    const h = createHarness({ adapter: 'silent', first: ['<write path="a">x</write>\n<report>r</report>\n<yield />'] });
    let calls = 0;
    h.setInExecute(() => {
      if (++calls !== 1) return;
      setTimeout(() => {
        h.stop();
        h.engine.injectSystemEvent('timer_alert', 'tea');
      }, 0);
    });
    await h.go();
    expect(h.tools.execute.mock.calls.map((c: any) => c[0].type)).toEqual(['write']);
  });
});
describe('生成の回の中の dispose', () => {
  for (const adapter of ['silent', 'throw'] as AdapterKind[])
    for (const mode of ['sync', 'async'] as const)
      it(`${adapter} × ${mode}: loop_stop(abort) をその場で 1 度。回の残りは何も書かず、何も知らせない。2 度畳んでも 1 度`, async () => {
        const h = createHarness({ adapter });
        h.onChunk((_c, i) => {
          if (i !== 2) return;
          const f = () => {
            h.seq.push('DISPOSE');
            h.engine.dispose();
            h.seq.push('RETURNED');
            h.engine.dispose();
          };
          if (mode === 'sync') f();
          else setTimeout(f, 0);
        });
        await h.go();
        expect(h.seq.slice(h.seq.indexOf('DISPOSE') + 1)).toEqual(['loop_stop(abort)', 'RETURNED']);
        // model のターンは積んだときのまま（更新しない）。束も作らない
        expect(h.modelTurn().content).toBe('');
        expect(h.modelTurn().meta.status).toBeUndefined();
        expect(h.frames()).toHaveLength(0);
        expect(h.tools.execute).not.toHaveBeenCalled();
        expect(h.engine.status()).toEqual(idle);
      });

  it('投影の中で畳む: その場で 1 度。model のターンを積まず、アダプタを呼ばない', async () => {
    const h = createHarness({ adapter: 'silent' });
    h.setInProjection(() => {
      h.seq.push('DISPOSE');
      h.engine.dispose();
      h.seq.push('RETURNED');
    });
    await h.go();
    expect(h.seq.slice(h.seq.indexOf('DISPOSE') + 1)).toEqual(['loop_stop(abort)', 'RETURNED']);
    expect(h.modelTurn()).toBeUndefined();
    expect(h.llm.generateStream).not.toHaveBeenCalled();
  });
});

describe('settled（止まりきるのを待つ口）', () => {
  it('回の外ではすぐ解決する', async () => {
    const h = createHarness({ adapter: 'silent' });
    let done = false;
    void h.engine.settled().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
  });

  for (const adapter of ['silent', 'throw'] as AdapterKind[])
    it(`${adapter}: 生成中に止めたら、model のターンの更新と loop_stop(abort) のあとに解決する`, async () => {
      const h = createHarness({ adapter });
      h.onChunk((_c, i) => {
        if (i !== 2) return;
        h.stop();
        void h.engine.settled().then(() => h.seq.push('SETTLED'));
      });
      await h.go();
      expect(h.afterStop().slice(0, 4)).toEqual([
        'turn_end(system)',
        'turn_end(model:error)',
        'loop_stop(abort)',
        'SETTLED',
      ]);
    });
});
describe('止めた知らせ（新しい 1 ターン）', () => {
  const notices = (h: any) => h.turns.filter((t: any) => t.meta?.eventType === STOPPED_EVENT_TYPE);
  const wrap = (text: string) => `<event type="stopped">\n${text}\n</event>`;

  for (const [by, text] of [
    [{ kind: 'user' }, 'Generation stopped by the user. Nothing in that turn was run.'],
    [{ kind: 'app', pid: 'home' }, 'Generation stopped by an app (home). Nothing in that turn was run.'],
    [{ kind: 'owner' }, 'Generation stopped by the owner. Nothing in that turn was run.'],
    [undefined, 'Generation stopped. Nothing in that turn was run.'],
  ] as const)
    it(`生成の途中（${by ? by.kind : '呼び手なし'}）: ${text}`, async () => {
      const h = createHarness({ adapter: 'silent' });
      h.onChunk((_c, i) => {
        if (i === 2) {
          h.stop(by ? { by } : undefined);
          h.stop(by ? { by } : undefined); // 2 度押しても 1 つ
        }
      });
      await h.go();
      expect(notices(h)).toHaveLength(1);
      const n = notices(h)[0];
      expect(n.role).toBe('system');
      expect(n.content).toBe(wrap(text));
      expect(n.meta).toEqual({ type: 'event_log', eventType: 'stopped', trigger_llm: false });
      // 置く順: 止めた model のターンの後ろ、loop_stop(abort) の前
      expect(h.turns.indexOf(n)).toBeGreaterThan(h.turns.indexOf(h.modelTurn()));
      expect(h.afterStop().indexOf('turn_end(system)')).toBeLessThan(h.afterStop().indexOf('loop_stop(abort)'));
      // 起こさない
      expect(h.createContext).toHaveBeenCalledTimes(1);
    });

  it('止めた直後の発言: 会話の順は model → 知らせ → 発言 で、次の投影に入る', async () => {
    const h = createHarness({ adapter: 'silent' });
    h.onChunk((_c, i) => {
      if (i === 2) {
        h.stop({ by: { kind: 'user' } });
        void h.engine.injectUserTurn('next');
      }
    });
    await h.go();
    expect(h.turns.map((t: any) => t.meta?.eventType ?? t.role)).toEqual(['user', 'model', 'stopped', 'user', 'model']);
  });

  it('道具の段（始まっていない道具が在る）: Tool execution stopped by the user. Not run: report, yield.', async () => {
    const h = createHarness({ adapter: 'silent', first: ['<write path="a">x</write>\n<report>r</report>\n<yield />'] });
    let calls = 0;
    h.setInExecute(() => {
      if (++calls === 1) setTimeout(() => h.stop({ by: { kind: 'user' } }), 0);
    });
    await h.go();
    expect(notices(h).map((t: any) => t.content)).toEqual([
      wrap('Tool execution stopped by the user. Not run: report, yield.'),
    ]);
    // 枠の後ろ
    expect(h.turns.indexOf(notices(h)[0])).toBeGreaterThan(h.turns.indexOf(h.frames()[0]));
    // 並べた道具は、あとから走らない
    expect(h.tools.execute.mock.calls.map((c: any) => c[0].type)).toEqual(['write']);
  });

  it('道具の段（全部もう始まっていた）: Tool execution stopped by the user.', async () => {
    const h = createHarness({ adapter: 'silent', first: ['<write path="a">x</write>\n<yield />'] });
    let calls = 0;
    h.setInExecute(() => {
      if (++calls === 2) setTimeout(() => h.stop({ by: { kind: 'user' } }), 0);
    });
    await h.go();
    expect(notices(h).map((t: any) => t.content)).toEqual([wrap('Tool execution stopped by the user.')]);
  });

  it('[Pending] の枠の turn_end の聞き手の中: Not run: write, yield.', async () => {
    const h = createHarness({ adapter: 'silent' });
    h.onTurnEnd((d) => {
      if (d.turn?.meta?.type === 'tool_execution' && h.seq.indexOf('STOP') < 0) h.stop({ by: { kind: 'owner' } });
    });
    await h.go();
    expect(notices(h).map((t: any) => t.content)).toEqual([
      wrap('Tool execution stopped by the owner. Not run: write, yield.'),
    ]);
  });

  it('最初の道具の execute の中: Not run: yield.', async () => {
    const h = createHarness({ adapter: 'silent' });
    h.setInExecute(() => {
      if (h.seq.indexOf('STOP') < 0) h.stop({ by: { kind: 'app', pid: 'home' } });
    });
    await h.go();
    expect(notices(h).map((t: any) => t.content)).toEqual([
      wrap('Tool execution stopped by an app (home). Not run: yield.'),
    ]);
  });

  it('積まない: 止まっているとき・起床の待ちだけを取り消したとき・投影の中', async () => {
    const h = createHarness({ adapter: 'silent', debounceMs: 1500 });
    h.stop({ by: { kind: 'user' } });
    await h.engine.injectUserTurn('go');
    h.stop({ by: { kind: 'user' } });
    expect(notices(h)).toHaveLength(0);

    const p = createHarness({ adapter: 'silent' });
    p.setInProjection(() => {
      p.setInProjection(() => {});
      p.stop({ by: { kind: 'user' } });
    });
    await p.go();
    expect(notices(p)).toHaveLength(0);
  });

  it('積まない: dispose・quiet（reset）', async () => {
    const h = createHarness({ adapter: 'silent' });
    h.onChunk((_c, i) => {
      if (i === 2) h.engine.dispose();
    });
    await h.go();
    expect(notices(h)).toHaveLength(0);

    const r = createHarness({ adapter: 'silent' });
    r.onChunk((_c, i) => {
      if (i === 2) r.stop({ quiet: true });
    });
    await r.go();
    expect(notices(r)).toHaveLength(0);
    expect(r.loopStopsAfterStop()).toEqual(['loop_stop(abort)']);
  });
});
