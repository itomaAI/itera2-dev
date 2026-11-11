// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import bridgeSource from './guest_bridge.js?raw';

/**
 * src/api/guest_bridge.llm.test.ts
 * MetaOS.llm（T-0807）のゲスト側。
 *   - generate は id を自分で採って llm:start を送り、返事はこのプロセス宛ての通知（llm:chunk／llm:end／llm:error）で受ける
 *   - 開始の応答より先に通知が来ても取りこぼさない
 *   - signal で止めたら llm:abort を送り、ホストの返事を待たずに AbortError で終える
 * jsdom では parent === window なので、ホストの代わりに window.postMessage を捕まえる（guest_bridge.test.ts と同じ型）。
 */

const PROTOCOL = 'itera:ipc:v2';

function loadBridge() {
  (window as any).__ITERA_PID__ = 'p1';
  delete (window as any).MetaOS;
  const posted: any[] = [];
  window.postMessage = ((msg: any) => posted.push(msg)) as any;
  new Function(bridgeSource)();
  const deliver = (data: any) => window.dispatchEvent(new MessageEvent('message', { data, source: window }));
  const requests = (action: string) => posted.filter((m) => m.type === 'req' && m.action === action);
  const respond = (req: any, payload: any, error: string | null = null) =>
    deliver({
      protocol: PROTOCOL,
      type: 'res',
      id: req.id,
      source: 'host',
      target: req.source,
      action: req.action,
      payload,
      error,
    });
  let seq = 0;
  const event = (action: string, payload: any, target = 'p1') =>
    deliver({
      protocol: PROTOCOL,
      type: 'event',
      id: `e${++seq}`,
      source: 'host',
      target,
      action,
      payload,
      error: null,
    });
  const llm = (window as any).MetaOS.llm;
  return { llm, requests, respond, event };
}

const REQUEST = { config: { model: 'anthropic/claude-x' }, messages: [{ role: 'user', content: 'hi' }] };
const RESULT = {
  provider: 'anthropic',
  model: 'claude-x',
  usage: { input: 1, cached: 0, cacheWrite: 0, output: 2, total: 3 },
  stopReason: 'end_turn',
};
const settled = async (p: Promise<any>) => {
  let state = 'pending';
  p.then(
    () => (state = 'resolved'),
    () => (state = 'rejected'),
  );
  await new Promise((r) => setTimeout(r, 0));
  return state;
};

describe('guest_bridge.js: MetaOS.llm', () => {
  it('generate は llm:start を送り、通知で文字と結果を受ける', async () => {
    const b = loadBridge();
    const chunks: string[] = [];
    const p = b.llm.generate(REQUEST, { onChunk: (t: string) => chunks.push(t), tag: 'conv-1' });
    const [start] = b.requests('llm:start');
    expect(start.source).toBe('p1');
    expect(start.payload.request).toEqual(REQUEST);
    expect(start.payload.tag).toBe('conv-1');
    const id = start.payload.id;
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(8);

    b.respond(start, { id });
    b.event('llm:chunk', { id, text: 'Hel' });
    b.event('llm:chunk', { id, text: 'lo' });
    expect(await settled(p)).toBe('pending');
    b.event('llm:end', { id, result: RESULT });
    expect(await p).toEqual({ text: 'Hello', ...RESULT });
    expect(chunks).toEqual(['Hel', 'lo']);
  });

  it('開始の応答より先に通知が来ても取りこぼさない（応答が来なくても終わる）', async () => {
    const b = loadBridge();
    const p = b.llm.generate(REQUEST);
    const id = b.requests('llm:start')[0].payload.id;
    b.event('llm:chunk', { id, text: 'x' });
    b.event('llm:end', { id, result: RESULT });
    expect((await p).text).toBe('x');
  });

  it('呼び出しごとに id が違い、通知は自分の id にだけ効く。他のプロセス宛ては見ない', async () => {
    const b = loadBridge();
    const p1 = b.llm.generate(REQUEST);
    const p2 = b.llm.generate(REQUEST);
    const [id1, id2] = b.requests('llm:start').map((m) => m.payload.id);
    expect(id1).not.toBe(id2);
    b.event('llm:chunk', { id: id2, text: 'two' });
    b.event('llm:chunk', { id: 'someone-else', text: 'zzz' });
    b.event('llm:chunk', { id: id1, text: 'one' }, 'p2');
    b.event('llm:end', { id: id1, result: RESULT }, 'p2');
    expect(await settled(p1)).toBe('pending');
    b.event('llm:end', { id: id2, result: RESULT });
    expect((await p2).text).toBe('two');
    b.event('llm:end', { id: id1, result: RESULT });
    expect((await p1).text).toBe('');
  });

  it('開始が断られたら、その理由で失敗する（種類は failed）', async () => {
    const b = loadBridge();
    const p = b.llm.generate({ messages: [] });
    b.respond(b.requests('llm:start')[0], null, 'MetaOS.llm.generate: config.model is required');
    const err: any = await p.catch((e: any) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('config.model is required');
    expect(err.code).toBe('failed');
  });

  it('llm:error は種類（code）つきで失敗する。終わったあとの通知は無視する', async () => {
    const b = loadBridge();
    const p = b.llm.generate(REQUEST);
    const id = b.requests('llm:start')[0].payload.id;
    b.event('llm:error', { id, message: 'cannot be sent to this model', code: 'media' });
    const err: any = await p.catch((e: any) => e);
    expect(err.message).toBe('cannot be sent to this model');
    expect(err.code).toBe('media');
    expect(err.name).toBe('Error');
    b.event('llm:end', { id, result: RESULT }); // 何も起きない
  });

  it('ホストが aborted を返したら AbortError', async () => {
    const b = loadBridge();
    const p = b.llm.generate(REQUEST);
    const id = b.requests('llm:start')[0].payload.id;
    b.event('llm:error', { id, message: 'Aborted', code: 'aborted' });
    const err: any = await p.catch((e: any) => e);
    expect(err.name).toBe('AbortError');
    expect(err.code).toBe('aborted');
  });

  it('signal で止めたら llm:abort を送り、ホストの返事を待たずに AbortError で終える', async () => {
    const b = loadBridge();
    const ac = new AbortController();
    const chunks: string[] = [];
    const p = b.llm.generate(REQUEST, { signal: ac.signal, onChunk: (t: string) => chunks.push(t) });
    const id = b.requests('llm:start')[0].payload.id;
    b.event('llm:chunk', { id, text: 'a' });
    ac.abort();
    const err: any = await p.catch((e: any) => e);
    expect(err.name).toBe('AbortError');
    expect(b.requests('llm:abort').map((m) => m.payload)).toEqual([{ id }]);
    // 止めたあとに届いたものは運ばない
    b.event('llm:chunk', { id, text: 'late' });
    b.event('llm:end', { id, result: RESULT });
    expect(chunks).toEqual(['a']);
    // 終わった呼び出しの signal をもう一度鳴らしても何も送らない
    ac.abort();
    expect(b.requests('llm:abort').length).toBe(1);
  });

  it('終わった呼び出しの signal を鳴らしても llm:abort は送らない', async () => {
    const b = loadBridge();
    const ac = new AbortController();
    const p = b.llm.generate(REQUEST, { signal: ac.signal });
    const id = b.requests('llm:start')[0].payload.id;
    b.event('llm:end', { id, result: RESULT });
    await p;
    ac.abort();
    expect(b.requests('llm:abort')).toEqual([]);
  });

  it('終わったら signal から聴き手を外す（長く使い回す signal に聴き手を溜めない）', async () => {
    const b = loadBridge();
    const added: any[] = [];
    const removed: any[] = [];
    const signal = {
      aborted: false,
      addEventListener: (type: string, fn: any) => added.push([type, fn]),
      removeEventListener: (type: string, fn: any) => removed.push([type, fn]),
    };
    const p = b.llm.generate(REQUEST, { signal });
    expect(added.length).toBe(1);
    expect(added[0][0]).toBe('abort');
    expect(removed).toEqual([]);
    b.event('llm:end', { id: b.requests('llm:start')[0].payload.id, result: RESULT });
    await p;
    expect(removed).toEqual(added);
  });

  it('始める前から止まっている signal なら、何も送らずに AbortError', async () => {
    const b = loadBridge();
    const ac = new AbortController();
    ac.abort();
    const err: any = await b.llm.generate(REQUEST, { signal: ac.signal }).catch((e: any) => e);
    expect(err.name).toBe('AbortError');
    expect(b.requests('llm:start')).toEqual([]);
  });

  it('onChunk が投げても生成は続く', async () => {
    const b = loadBridge();
    const errors: any[] = [];
    const orig = console.error;
    console.error = (...a: any[]) => errors.push(a);
    try {
      const p = b.llm.generate(REQUEST, {
        onChunk: () => {
          throw new Error('ui broke');
        },
      });
      const id = b.requests('llm:start')[0].payload.id;
      b.event('llm:chunk', { id, text: 'x' });
      b.event('llm:end', { id, result: RESULT });
      expect((await p).text).toBe('x');
      expect(errors.length).toBe(1);
    } finally {
      console.error = orig;
    }
  });

  it('models は llm:models を訊く', async () => {
    const b = loadBridge();
    const p = b.llm.models();
    const [req] = b.requests('llm:models');
    b.respond(req, [{ id: 'anthropic/claude-x' }]);
    expect(await p).toEqual([{ id: 'anthropic/claude-x' }]);
  });
});
