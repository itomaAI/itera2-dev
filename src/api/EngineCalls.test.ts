/**
 * src/api/EngineCalls.test.ts
 * MetaOS.engine のホストの側（T-0908）。束の表は偽物（持ち主を見て断るところまで）。
 * 本物の束の表・エンジンを通した確かめは shell/services/EngineManager.test.ts の「EngineManager × EngineCalls」。
 */
import { describe, expect, it, vi } from 'vitest';
import { EngineCalls, ownerEventData, type EngineTable, type OwnerNotice } from './EngineCalls';
import type { Principal } from '../core/vfs/types';

const APP: Principal = { type: 'app', id: 'viewer' };
const CALLER = { pid: 'viewer', principal: APP };
const OTHER = { pid: 'other', principal: { type: 'app', id: 'other' } as Principal };

function fakeEngine(id: string) {
  const turns: any[] = [];
  const bundle = {
    afterReset: 'Continue as told.',
    post: vi.fn(async (role: string, content: any, meta: any) => {
      const turn = { id: `t${turns.length + 1}`, timestamp: 100 + turns.length, role, content, meta };
      turns.push(turn);
      return turn;
    }),
    wake: vi.fn(),
    stop: vi.fn(),
    reset: vi.fn(async (_options: any) => ({ archived: false, sessionId: 's2' })),
    statusInput: vi.fn(async () => ({
      engine: { running: true, busy: false, outstandingTools: 0, scheduled: false },
      turns,
      session: { id: 's1', title: '', createdAt: 5 },
      contextLimit: 1000,
    })),
  };
  const conversation = {
    history: { get: () => turns },
    save: vi.fn(async (dir: string, _principal: Principal) => ({ path: dir, media: 0 })),
  };
  return { id, bundle, conversation, turns };
}

function world() {
  const engines = new Map<string, { owner: string; engine: ReturnType<typeof fakeEngine> }>();
  const listeners: Array<(notice: OwnerNotice) => void> = [];
  let seq = 0;
  const table = {
    create: vi.fn(async (owner: { pid: string }, _spec: any) => {
      const engine = fakeEngine(`eng-${++seq}`);
      engines.set(engine.id, { owner: owner.pid, engine });
      return engine;
    }),
    of: vi.fn((ownerPid: string, id: string) => {
      const entry = engines.get(id);
      if (!entry || entry.owner !== ownerPid) throw new Error(`Engine "${id}" not found.`);
      return entry.engine;
    }),
    owned: (ownerPid: string) => [...engines.values()].filter((e) => e.owner === ownerPid).map((e) => e.engine),
    dispose: vi.fn(async (id: string, _reason?: string) => engines.delete(id)),
    onOwnerEvent: (callback: (notice: OwnerNotice) => void) => {
      listeners.push(callback);
    },
  };
  const sent: Array<{ pid: string; action: string; payload: any }> = [];
  const vfs = {
    stat: vi.fn(() => {
      throw new Error('no file');
    }),
    withBlob: vi.fn(),
  };
  const calls = new EngineCalls({
    engines: table as unknown as EngineTable,
    vfs: vfs as any,
    send: (pid, action, payload) => sent.push({ pid, action, payload }),
  });
  const notify = (notice: OwnerNotice) => listeners.forEach((cb) => cb(notice));
  const engineOf = (id: string) => engines.get(id)!.engine;
  return { calls, table, engineOf, sent, notify };
}

describe('EngineCalls: 作る', () => {
  it('呼び手と spec をそのまま束の表へ渡し、返すのは id だけ', async () => {
    const w = world();
    const spec = { config: { llm: { model: 'google/small' } }, from: 'data/c' };

    const created = await w.calls.create(CALLER, spec);

    expect(created).toEqual({ id: 'eng-1' });
    expect(w.table.create).toHaveBeenCalledWith(CALLER, spec);
  });

  it('spec の形の検査も、省いたときの既定も、束の表がする（ここでは直さない）', async () => {
    const w = world();
    await w.calls.create(CALLER, undefined);
    expect(w.table.create).toHaveBeenLastCalledWith(CALLER, undefined);
    await w.calls.create(CALLER, null);
    expect(w.table.create).toHaveBeenLastCalledWith(CALLER, null);
  });

  it('束の表が断れば、そのまま断る', async () => {
    const w = world();
    w.table.create.mockRejectedValueOnce(new Error('Too many engines (limit 8). Dispose one first.'));
    await expect(w.calls.create(CALLER, {})).rejects.toThrow('Too many engines');
  });
});

describe('EngineCalls: 相手は、呼び手が持っているエンジン', () => {
  it('id が無ければ、束の表を引く前に断る', async () => {
    const w = world();
    for (const id of [undefined, null, '', 7, {}]) {
      await expect(w.calls.wake(CALLER, id)).rejects.toThrow('MetaOS.engine: an engine id is required');
    }
    expect(w.table.of).not.toHaveBeenCalled();
  });

  it('持ち主でない者は、どの口でも「無い」と断られ、エンジンには何も起きない', async () => {
    const w = world();
    const { id } = await w.calls.create(CALLER, {});
    const e = w.engineOf(id);
    const refused = `Engine "${id}" not found.`;

    await expect(w.calls.append(OTHER, id, { role: 'user', content: 'x' })).rejects.toThrow(refused);
    await expect(w.calls.wake(OTHER, id)).rejects.toThrow(refused);
    await expect(w.calls.stop(OTHER, id)).rejects.toThrow(refused);
    await expect(w.calls.reset(OTHER, id, {})).rejects.toThrow(refused);
    await expect(w.calls.status(OTHER, id)).rejects.toThrow(refused);
    await expect(w.calls.turns(OTHER, id)).rejects.toThrow(refused);
    await expect(w.calls.save(OTHER, id, 'data/x')).rejects.toThrow(refused);
    await expect(w.calls.dispose(OTHER, id)).rejects.toThrow(refused);

    expect(e.bundle.post).not.toHaveBeenCalled();
    expect(e.bundle.wake).not.toHaveBeenCalled();
    expect(e.bundle.stop).not.toHaveBeenCalled();
    expect(e.bundle.reset).not.toHaveBeenCalled();
    expect(e.bundle.statusInput).not.toHaveBeenCalled();
    expect(e.conversation.save).not.toHaveBeenCalled();
    expect(w.table.dispose).not.toHaveBeenCalled();
    expect(await w.calls.list(OTHER)).toEqual([]);
  });
});

describe('EngineCalls: MetaOS.chat と同じ動詞', () => {
  it('append は、そのエンジンの束に置く（出どころは呼び手・断るときは engine.append の名前で）', async () => {
    const w = world();
    const { id } = await w.calls.create(CALLER, {});
    const e = w.engineOf(id);

    expect(await w.calls.append(CALLER, id, { role: 'user', content: 'hi', opts: { wake: true } })).toEqual({
      id: 't1',
    });
    expect(e.bundle.post).toHaveBeenCalledWith('user', [{ text: 'hi' }], { trigger_llm: true, source: 'viewer' });

    await expect(w.calls.append(CALLER, id, { role: 'model', content: 'x' })).rejects.toThrow(
      "engine.append: role must be 'user' or 'system'",
    );
    expect(e.bundle.post).toHaveBeenCalledTimes(1);
  });

  it('wake・stop は束の口を呼ぶ', async () => {
    const w = world();
    const { id } = await w.calls.create(CALLER, {});
    const e = w.engineOf(id);

    expect(await w.calls.wake(CALLER, id)).toBe(true);
    expect(e.bundle.wake).toHaveBeenCalledTimes(1);
    expect(e.bundle.stop).not.toHaveBeenCalled();
    expect(await w.calls.stop(CALLER, id)).toBe(true);
    expect(e.bundle.stop).toHaveBeenCalledTimes(1);
  });

  it('reset は、申し送りの頭に呼び手と、そのエンジンの役割の 1 行を付ける', async () => {
    const w = world();
    const { id } = await w.calls.create(CALLER, {});
    const e = w.engineOf(id);

    expect(await w.calls.reset(CALLER, id, { summary: ' carry ' })).toEqual({ archived: false, sessionId: 's2' });
    expect(e.bundle.reset).toHaveBeenLastCalledWith({
      summary: '[System: Session reset by viewer]\nContinue as told.\n\n[Carried Over Information]\ncarry',
      restoreTools: true,
    });

    await w.calls.reset(CALLER, id, { restoreTools: false });
    expect(e.bundle.reset).toHaveBeenLastCalledWith({
      summary: '[System: Session reset by viewer]\nContinue as told.',
      restoreTools: false,
    });
    await w.calls.reset(CALLER, id, undefined);
    expect(e.bundle.reset).toHaveBeenCalledTimes(3);
  });

  it('status は MetaOS.chat.status と同じ形', async () => {
    const w = world();
    const { id } = await w.calls.create(CALLER, {});
    await w.calls.append(CALLER, id, { role: 'user', content: 'hi' });

    expect(await w.calls.status(CALLER, id)).toEqual({
      running: true,
      busy: false,
      outstandingTools: 0,
      scheduled: false,
      turns: 1,
      lastTurnAt: 100,
      session: { id: 's1', title: '', createdAt: 5 },
      context: null,
    });
  });
});

describe('EngineCalls: 持ち主にだけ在るもの', () => {
  it('turns は会話の全文', async () => {
    const w = world();
    const { id } = await w.calls.create(CALLER, {});
    await w.calls.append(CALLER, id, { role: 'user', content: 'a' });
    await w.calls.append(CALLER, id, { role: 'system', content: 'b' });

    const turns = await w.calls.turns(CALLER, id);
    expect(turns.map((t) => [t.role, t.content])).toEqual([
      ['user', [{ text: 'a' }]],
      ['system', [{ text: 'b' }]],
    ]);
  });

  it('save は、呼び手の主体で書かせる。場所が無ければ断る', async () => {
    const w = world();
    const { id } = await w.calls.create(CALLER, {});
    const e = w.engineOf(id);

    expect(await w.calls.save(CALLER, id, 'data/out')).toEqual({ path: 'data/out', media: 0 });
    expect(e.conversation.save).toHaveBeenCalledWith('data/out', APP);

    for (const path of [undefined, '', '   ', 3]) {
      await expect(w.calls.save(CALLER, id, path)).rejects.toThrow('engine.save: path is required');
    }
    expect(e.conversation.save).toHaveBeenCalledTimes(1);
  });

  it('dispose は、持ち主が畳んだ、として束の表に畳ませる', async () => {
    const w = world();
    const { id } = await w.calls.create(CALLER, {});

    expect(await w.calls.dispose(CALLER, id)).toBe(true);
    expect(w.table.dispose).toHaveBeenCalledWith(id, 'owner_request');
    await expect(w.calls.status(CALLER, id)).rejects.toThrow('not found');
  });

  it('list は、呼び手が持っているエンジンだけ（id と状態）', async () => {
    const w = world();
    const a = await w.calls.create(CALLER, {});
    await w.calls.create(OTHER, {});
    const c = await w.calls.create(CALLER, {});
    await w.calls.append(CALLER, c.id, { role: 'user', content: 'x' });

    const list = await w.calls.list(CALLER);
    expect(list.map((e) => [e.id, e.status.turns])).toEqual([
      [a.id, 0],
      [c.id, 1],
    ]);
    expect(list[0].status).toMatchObject({ running: true, session: { id: 's1' } });
  });
});

describe('EngineCalls: 持ち主への知らせ', () => {
  it('束の表の知らせを、持ち主のプロセスにだけ engine:event で送る', () => {
    const w = world();
    const turn = { id: 't1', timestamp: 1, role: 'model', content: 'ok', meta: { type: 'model_thought' } };

    w.notify({ ownerPid: 'viewer', engineId: 'eng-1', event: 'turn_end', data: { role: 'model', turn } });
    w.notify({ ownerPid: 'other', engineId: 'eng-2', event: 'disposed', data: { reason: 'owner_request' } });

    expect(w.sent).toEqual([
      {
        pid: 'viewer',
        action: 'engine:event',
        payload: { id: 'eng-1', event: 'turn_end', data: { role: 'model', turn } },
      },
      {
        pid: 'other',
        action: 'engine:event',
        payload: { id: 'eng-2', event: 'disposed', data: { reason: 'owner_request' } },
      },
    ]);
  });

  it('ホストの中の形（裸の文字列・Error）は、欄を持つ素の値にして送る', () => {
    const w = world();
    const base = { ownerPid: 'viewer', engineId: 'eng-1' };

    w.notify({ ...base, event: 'stream_chunk', data: 'he' });
    w.notify({ ...base, event: 'loop_stop', data: { reason: 'error', error: new Error('upstream 500') } });
    w.notify({ ...base, event: 'loop_stop', data: { reason: 'idle' } });

    expect(w.sent.map((s) => s.payload.data)).toEqual([
      { text: 'he' },
      { reason: 'error', message: 'upstream 500' },
      { reason: 'idle' },
    ]);
    // どれも JSON で往復して同じ（窓をまたいで運べる）
    for (const s of w.sent) expect(JSON.parse(JSON.stringify(s.payload))).toEqual(s.payload);
  });
});

describe('ownerEventData', () => {
  it('stream_chunk は { text }。文字列でなければ空', () => {
    expect(ownerEventData('stream_chunk', 'abc')).toEqual({ text: 'abc' });
    expect(ownerEventData('stream_chunk', '')).toEqual({ text: '' });
    expect(ownerEventData('stream_chunk', undefined)).toEqual({ text: '' });
  });

  it('loop_stop は { reason, message? }。Error でない失敗も文字にする', () => {
    expect(ownerEventData('loop_stop', { reason: 'abort' })).toEqual({ reason: 'abort' });
    expect(ownerEventData('loop_stop', { reason: 'error', error: 'boom' })).toEqual({
      reason: 'error',
      message: 'boom',
    });
    expect(ownerEventData('loop_stop', { reason: 'error', error: { message: 'm' } })).toEqual({
      reason: 'error',
      message: 'm',
    });
    expect(ownerEventData('loop_stop', { reason: 'max_tools', error: null })).toEqual({ reason: 'max_tools' });
    expect(ownerEventData('loop_stop', undefined)).toEqual({ reason: 'unknown' });
  });

  it('ほかの知らせは、そのまま。中身が無ければ空の値', () => {
    const data = { role: 'model', turnId: 't1' };
    expect(ownerEventData('turn_start', data)).toBe(data);
    expect(ownerEventData('disposed', undefined)).toEqual({});
  });
});
