/**
 * src/core/control/Engine.usage.test.ts
 * 生成の結果（使ったトークン・止まった理由）を、その生成が作った model ターンに置く（T-0806）。
 *
 * 守りたいこと:
 *   1. エンジンは生成を呼ぶとき、台帳に書く名乗り（caller: 'root'・tag: いまの会話の id）を渡す
 *   2. 返ってきた結果は model ターンの meta（usage・model・stopReason）に入る
 *   3. 結果が無い（失敗・中断・古い偽物）ときは何も置かない。usage が null なら usage の欄を作らない
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Engine } from './Engine';
import { Translator } from '../cognitive/Translator';

const USAGE = { input: 10, cached: 900, cacheWrite: 100, output: 42, total: 1052 };

function run(generate: (onChunk: (c: string) => void) => Promise<any>) {
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
      if (content !== undefined) turn.content = content;
      turn.meta = { ...turn.meta, ...meta };
      notify({ type: 'update', turn });
      return turn;
    },
  };
  const llm = { generateStream: vi.fn(async (_m: any, onChunk: (c: string) => void) => generate(onChunk)) };
  const engine = new Engine(
    { history, vfs: {}, configManager: { get: () => ({}) } } as any,
    { createContext: async () => ['BODY'] } as any,
    llm as any,
    new Translator(),
    {
      getRegisteredToolNames: () => ['finish'],
      execute: vi.fn(async () => ({ log: 'ok', trigger_llm: false })),
    } as any,
    {},
    'realtime',
    1500,
  );
  return { engine, turns, llm };
}

const go = async (h: ReturnType<typeof run>) => {
  await h.engine.injectUserTurn('go');
  await vi.advanceTimersByTimeAsync(1600);
  await vi.advanceTimersByTimeAsync(500);
};
const modelTurn = (h: ReturnType<typeof run>) => h.turns.find((t) => t.role === 'model');

describe('Engine: 生成の結果を model ターンに置く（T-0806）', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('usage・model・stopReason が meta に入る', async () => {
    const h = run(async (onChunk) => {
      onChunk('<finish />');
      return { provider: 'anthropic', model: 'claude-test', usage: USAGE, stopReason: 'end_turn' };
    });
    await go(h);
    const t = modelTurn(h);
    expect(t.content).toBe('<finish />');
    expect(t.meta.status).toBe('completed');
    expect(t.meta.usage).toEqual(USAGE);
    expect(t.meta.model).toBe('claude-test');
    expect(t.meta.stopReason).toBe('end_turn');
  });

  it('生成を呼ぶとき、root といまの会話の id を名乗る', async () => {
    const h = run(async (onChunk) => {
      onChunk('<finish />');
      return { provider: 'google', model: 'm', usage: null, stopReason: null };
    });
    let session = 'session-1';
    h.engine.sessionTag = () => session;
    await go(h);
    expect(h.llm.generateStream.mock.calls[0][0]).toEqual(['BODY']);
    expect((h.llm.generateStream.mock.calls[0] as any[])[3]).toEqual({ caller: 'root', tag: 'session-1' });

    // id は呼ぶたびに訊く（会話を切り替えたら次の生成から新しい id）
    session = 'session-2';
    await go(h);
    expect((h.llm.generateStream.mock.calls[1] as any[])[3]).toEqual({ caller: 'root', tag: 'session-2' });
  });

  it('会話の id の取り方が差されていなければ tag は null', async () => {
    const h = run(async (onChunk) => {
      onChunk('<finish />');
      return { provider: 'google', model: 'm', usage: null, stopReason: null };
    });
    await go(h);
    expect((h.llm.generateStream.mock.calls[0] as any[])[3]).toEqual({ caller: 'root', tag: null });
  });

  it('usage が null なら usage の欄を作らない（0 を置かない）。model と stopReason は置く', async () => {
    const h = run(async (onChunk) => {
      onChunk('<finish />');
      return { provider: 'google', model: 'gemini-test', usage: null, stopReason: 'MAX_TOKENS' };
    });
    await go(h);
    const t = modelTurn(h);
    expect('usage' in t.meta).toBe(false);
    expect(t.meta.model).toBe('gemini-test');
    expect(t.meta.stopReason).toBe('MAX_TOKENS');
  });

  it('結果を返さない生成（何も返さない偽物）では何も置かない', async () => {
    const h = run(async (onChunk) => {
      onChunk('<finish />');
    });
    await go(h);
    const t = modelTurn(h);
    expect(t.meta.status).toBe('completed');
    for (const k of ['usage', 'model', 'stopReason']) expect(k in t.meta).toBe(false);
  });

  it('生成が失敗したら何も置かない（status は error）', async () => {
    const h = run(async (onChunk) => {
      onChunk('partial');
      throw new Error('upstream down');
    });
    await go(h);
    const t = modelTurn(h);
    expect(t.content).toBe('partial');
    expect(t.meta.status).toBe('error');
    for (const k of ['usage', 'model', 'stopReason']) expect(k in t.meta).toBe(false);
  });
});
