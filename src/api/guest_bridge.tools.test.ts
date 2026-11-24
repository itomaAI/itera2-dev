// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import bridgeSource from './guest_bridge.js?raw';

/**
 * src/api/guest_bridge.tools.test.ts
 * MetaOS.tools のゲスト側（T-0908 の 4-5）。
 *   - register は、先に自分の表へ入れてから tools:register を送る（返事より先に呼び出しが届いても応えられる）
 *   - ホストが断ったら（同じ名前の道具がもう在る、など）、表を元に戻してから失敗を伝える
 * jsdom では parent === window なので、ホストの代わりに window.postMessage を捕まえる（guest_bridge.llm.test.ts と同じ型）。
 */

const PROTOCOL = 'itera:ipc:v2';

let instances = 0;
function loadBridge() {
  // 試験ごとに別の pid を名乗らせる。同じ window に前の試験が読み込んだ橋の聞き手が残るので、
  // 同じ pid だと、ホストからの呼び出し（execute_tool）に前の橋も答えてしまう
  const pid = `p${++instances}`;
  (window as any).__ITERA_PID__ = pid;
  delete (window as any).MetaOS;
  const posted: any[] = [];
  window.postMessage = ((msg: any) => posted.push(msg)) as any;
  vi.spyOn(console, 'log').mockImplementation(() => {});
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
  /** ホストが道具を呼ぶ。返事（結果か失敗）を返す */
  const invoke = async (name: string, params: any = {}) => {
    const id = `host-${pid}-${++seq}`;
    deliver({
      protocol: PROTOCOL,
      type: 'req',
      id,
      source: 'host',
      target: pid,
      action: 'execute_tool',
      payload: { name, params },
      error: null,
    });
    await new Promise((r) => setTimeout(r, 0));
    const answers = posted.filter((m) => m.type === 'res' && m.id === id);
    expect(answers).toHaveLength(1);
    return { payload: answers[0].payload, error: answers[0].error };
  };
  const tools = (window as any).MetaOS.tools;
  return { pid, tools, requests, respond, invoke };
}

describe('guest_bridge.js: MetaOS.tools.register', () => {
  it('tools:register を送り、ホストからの呼び出しに登録した関数で応える', async () => {
    const b = loadBridge();
    const p = b.tools.register({
      name: 'edit_cell',
      description: 'd',
      definition: '<define_tag name="edit_cell">x</define_tag>',
      handler: async (params: any) => `edited ${params.row}`,
    });
    const [req] = b.requests('tools:register');
    expect(req.source).toBe(b.pid);
    expect(req.payload).toEqual({
      name: 'edit_cell',
      description: 'd',
      definition: '<define_tag name="edit_cell">x</define_tag>',
    });
    // 返事より先に呼び出しが届いても、応えられる
    expect(await b.invoke('edit_cell', { row: 3 })).toEqual({ payload: 'edited 3', error: null });
    b.respond(req, true);
    await expect(p).resolves.toBeUndefined();
  });

  it('ホストが断ったら失敗し、その名前では応えなくなる', async () => {
    const b = loadBridge();
    const p = b.tools.register({ name: 'read', handler: async () => 'mine' });
    b.respond(b.requests('tools:register')[0], null, 'A system tool named "read" already exists.');

    await expect(p).rejects.toThrow('A system tool named "read" already exists.');
    expect((await b.invoke('read')).error).toContain('Tool handler not found: read');
  });

  it('登録し直しが断られたら、前に登録した関数に戻る', async () => {
    const b = loadBridge();
    const first = b.tools.register({ name: 'search', handler: async () => 'first' });
    b.respond(b.requests('tools:register')[0], true);
    await first;

    const second = b.tools.register({ name: 'search', handler: async () => 'second' });
    // 返事を待つ間は、新しい関数で応える
    expect(await b.invoke('search')).toEqual({ payload: 'second', error: null });
    b.respond(b.requests('tools:register')[1], null, 'refused');
    await expect(second).rejects.toThrow('refused');

    expect(await b.invoke('search')).toEqual({ payload: 'first', error: null });
  });

  it('形の無い定義は、送る前に断る', async () => {
    const b = loadBridge();
    await expect(b.tools.register({ name: 'x' })).rejects.toThrow('Invalid tool definition.');
    await expect(b.tools.register(null)).rejects.toThrow('Invalid tool definition.');
    expect(b.requests('tools:register')).toEqual([]);
  });

  it('unregister は tools:unregister を送り、その名前では応えなくなる', async () => {
    const b = loadBridge();
    const p = b.tools.register({ name: 'search', handler: async () => 'ok' });
    b.respond(b.requests('tools:register')[0], true);
    await p;
    expect(await b.invoke('search')).toEqual({ payload: 'ok', error: null });

    const q = b.tools.unregister('search');
    expect(b.requests('tools:unregister')[0].payload).toEqual({ name: 'search' });
    b.respond(b.requests('tools:unregister')[0], true);
    await q;
    expect((await b.invoke('search')).error).toContain('Tool handler not found: search');
  });
});
