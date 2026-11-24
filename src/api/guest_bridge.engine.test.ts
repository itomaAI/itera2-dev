// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import bridgeSource from './guest_bridge.js?raw';
import { ENGINE_OWNER_EVENTS } from '../shell/services/EngineManager';

/**
 * src/api/guest_bridge.engine.test.ts
 * MetaOS.engine（T-0908）のゲスト側。
 *   - create は engine:create を送り、返った id の取っ手を返す。取っ手の動詞は engine:<動詞> に id を添えて送る
 *   - 知らせ（engine:event）は、id で取っ手の聞き手へ振り分ける。知らない id・畳んだあとの知らせは捨てる
 *   - 知らせの名前は、ホストの側（EngineManager.ts）と同じ並び
 * jsdom では parent === window なので、ホストの代わりに window.postMessage を捕まえる（guest_bridge.llm.test.ts と同じ型）。
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
  const event = (payload: any, target = 'p1') =>
    deliver({
      protocol: PROTOCOL,
      type: 'event',
      id: `e${++seq}`,
      source: 'host',
      target,
      action: 'engine:event',
      payload,
      error: null,
    });
  const engine = (window as any).MetaOS.engine;
  /** エンジンを 1 つ作る（ホストの返事を代わりに返す） */
  const create = async (id: string, spec?: any) => {
    const before = requests('engine:create').length;
    const p = spec === undefined ? engine.create() : engine.create(spec);
    respond(requests('engine:create')[before], { id });
    return p;
  };
  return { engine, requests, respond, event, create };
}

describe('guest_bridge.js: MetaOS.engine の取っ手', () => {
  it('create は spec を送り、返った id の取っ手を返す。省けば空の spec', async () => {
    const b = loadBridge();
    const spec = { config: { llm: { model: 'google/small' } }, from: 'data/c' };

    const e = await b.create('eng-1', spec);
    expect(e.id).toBe('eng-1');
    const [first] = b.requests('engine:create');
    expect(first.source).toBe('p1');
    expect(first.payload).toEqual({ spec });

    await b.create('eng-2');
    expect(b.requests('engine:create')[1].payload).toEqual({ spec: {} });
  });

  it('ホストが断れば、create は失敗する（取っ手は出来ない）', async () => {
    const b = loadBridge();
    const p = b.engine.create({ init: 'x' });
    b.respond(b.requests('engine:create')[0], null, 'Invalid engine spec: init is not supported');
    await expect(p).rejects.toThrow('init is not supported');
  });

  it('動詞は engine:<動詞> に、このエンジンの id を添えて送る', async () => {
    const b = loadBridge();
    const e = await b.create('eng-1');

    const sent = (action: string) => b.requests(action).at(-1).payload;
    void e.append('user', 'hi', { wake: true });
    expect(sent('engine:append')).toEqual({ id: 'eng-1', role: 'user', content: 'hi', opts: { wake: true } });
    void e.append('system', 'note');
    expect(sent('engine:append')).toEqual({ id: 'eng-1', role: 'system', content: 'note', opts: {} });
    void e.wake();
    expect(sent('engine:wake')).toEqual({ id: 'eng-1' });
    void e.stop();
    expect(sent('engine:stop')).toEqual({ id: 'eng-1' });
    void e.reset({ summary: 's' });
    expect(sent('engine:reset')).toEqual({ id: 'eng-1', opts: { summary: 's' } });
    void e.reset();
    expect(sent('engine:reset')).toEqual({ id: 'eng-1', opts: {} });
    void e.status();
    expect(sent('engine:status')).toEqual({ id: 'eng-1' });
    void e.turns();
    expect(sent('engine:turns')).toEqual({ id: 'eng-1' });
    void e.save('data/out');
    expect(sent('engine:save')).toEqual({ id: 'eng-1', path: 'data/out' });
    void e.dispose();
    expect(sent('engine:dispose')).toEqual({ id: 'eng-1' });
  });

  it('返事は、ホストが返したものそのまま', async () => {
    const b = loadBridge();
    const e = await b.create('eng-1');

    const p = e.status();
    b.respond(b.requests('engine:status')[0], { running: false, turns: 3 });
    expect(await p).toEqual({ running: false, turns: 3 });

    const q = e.wake();
    b.respond(b.requests('engine:wake')[0], null, 'Engine "eng-1" not found.');
    await expect(q).rejects.toThrow('Engine "eng-1" not found.');
  });

  it('list は engine:list を送る', async () => {
    const b = loadBridge();
    const p = b.engine.list();
    const [req] = b.requests('engine:list');
    expect(req.payload).toEqual({});
    b.respond(req, [{ id: 'eng-1', status: { turns: 0 } }]);
    expect(await p).toEqual([{ id: 'eng-1', status: { turns: 0 } }]);
  });
});

describe('guest_bridge.js: MetaOS.engine の知らせ', () => {
  it('知らせは、id の合う取っ手の、その名前の聞き手にだけ届く', async () => {
    const b = loadBridge();
    const a = await b.create('eng-a');
    const c = await b.create('eng-c');
    const got: any[] = [];
    a.on('stream_chunk', (d: any) => got.push(['a.chunk', d]));
    a.on('turn_end', (d: any) => got.push(['a.end', d]));
    c.on('stream_chunk', (d: any) => got.push(['c.chunk', d]));

    b.event({ id: 'eng-a', event: 'stream_chunk', data: { text: 'he' } });
    b.event({ id: 'eng-c', event: 'stream_chunk', data: { text: 'yo' } });
    b.event({ id: 'eng-a', event: 'turn_end', data: { role: 'model', turn: { id: 't1' } } });
    // 聞き手の居ない名前・知らない id・ほかのプロセス宛て・形の無い知らせは、何も起こさない
    b.event({ id: 'eng-a', event: 'loop_stop', data: { reason: 'idle' } });
    b.event({ id: 'eng-zzz', event: 'stream_chunk', data: { text: 'lost' } });
    b.event({ id: 'eng-a', event: 'stream_chunk', data: { text: 'not mine' } }, 'p2');
    b.event(null);

    expect(got).toEqual([
      ['a.chunk', { text: 'he' }],
      ['c.chunk', { text: 'yo' }],
      ['a.end', { role: 'model', turn: { id: 't1' } }],
    ]);
  });

  it('同じ名前に聞き手をいくつも置ける。off で外す。1 つが失敗しても、ほかには届く', async () => {
    const b = loadBridge();
    const e = await b.create('eng-1');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const got: string[] = [];
    const first = () => got.push('first');
    e.on('loop_stop', first);
    e.on('loop_stop', () => {
      throw new Error('listener broke');
    });
    e.on('loop_stop', () => got.push('third'));

    b.event({ id: 'eng-1', event: 'loop_stop', data: { reason: 'idle' } });
    expect(got).toEqual(['first', 'third']);
    expect(errors).toHaveBeenCalledTimes(1);

    e.off('loop_stop', first);
    e.off('turn_end', first); // 置いていない名前を外しても、何も起きない
    b.event({ id: 'eng-1', event: 'loop_stop', data: { reason: 'idle' } });
    expect(got).toEqual(['first', 'third', 'third']);
    errors.mockRestore();
  });

  it('知らない名前・関数でない聞き手は断る', async () => {
    const b = loadBridge();
    const e = await b.create('eng-1');
    expect(() => e.on('turn_ended', () => {})).toThrow('MetaOS.engine: unknown event "turn_ended"');
    expect(() => e.on('wake_requested', () => {})).toThrow(TypeError);
    expect(() => e.on('turn_end', 'nope')).toThrow('MetaOS.engine: the listener must be a function');
  });

  it('知らせの名前は、ホストの側（ENGINE_OWNER_EVENTS）と同じ', async () => {
    const b = loadBridge();
    const e = await b.create('eng-1');
    for (const name of ENGINE_OWNER_EVENTS) expect(() => e.on(name, () => {})).not.toThrow();

    let message = '';
    try {
      e.on('?', () => {});
    } catch (err) {
      message = (err as Error).message;
    }
    const listed = message.slice(message.indexOf('(') + 1, message.lastIndexOf(')')).split(', ');
    expect(listed).toEqual([...ENGINE_OWNER_EVENTS]);
  });

  it('畳まれた知らせは聞き手に届き、そのあとの知らせは届かない', async () => {
    const b = loadBridge();
    const e = await b.create('eng-1');
    const got: any[] = [];
    e.on('disposed', (d: any) => got.push(['disposed', d]));
    e.on('stream_chunk', (d: any) => got.push(['chunk', d]));

    b.event({ id: 'eng-1', event: 'disposed', data: { reason: 'owner_request' } });
    b.event({ id: 'eng-1', event: 'stream_chunk', data: { text: 'late' } });
    b.event({ id: 'eng-1', event: 'disposed', data: { reason: 'owner_request' } });

    expect(got).toEqual([['disposed', { reason: 'owner_request' }]]);
  });

  it('作った返事のすぐあとに届く知らせは、返事を受けてすぐ置いた聞き手に届く', async () => {
    const b = loadBridge();
    const p = b.engine.create();
    const got: any[] = [];
    // ホストは、返事 → 知らせ の順に送る
    b.respond(b.requests('engine:create')[0], { id: 'eng-1' });
    const e = await p;
    e.on('turn_start', (d: any) => got.push(d));
    b.event({ id: 'eng-1', event: 'turn_start', data: { role: 'model', turnId: 't1' } });
    expect(got).toEqual([{ role: 'model', turnId: 't1' }]);
  });
});