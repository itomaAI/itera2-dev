// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import bootstrapSource from './guest_bootstrap.js?raw';

/**
 * src/shell/windowing/guest_bootstrap.test.ts
 * 二段起動の 1 段目（T-0770 / T-0784）。ブートストラップは
 *   1. 自分の PID で sys:boot をホストへ頼み、
 *   2. 返ってきた束から後順に object URL を作って（text は先の URL で目印を置換してから）目印を置き換え、
 *   3. 同じ文書に document.open / write / close で本体を書き、
 *   4. 自分の message リスナを外す（以後の応答に反応しない）。
 * jsdom では parent === window なので、ホストの代わりに window.postMessage を捕まえ、応答を MessageEvent で返す。
 */

const PROTOCOL = 'itera:ipc:v2';

function boot(pid: string | undefined) {
  (window as any).__ITERA_PID__ = pid;
  const posted: any[] = [];
  window.postMessage = ((msg: any) => posted.push(msg)) as any;
  const created: Blob[] = [];
  (URL as any).createObjectURL = (b: Blob) => {
    created.push(b);
    return `blob:null/${created.length}`;
  };
  const open = vi.spyOn(document, 'open').mockImplementation((() => document) as any);
  const write = vi.spyOn(document, 'write').mockImplementation(() => {});
  const close = vi.spyOn(document, 'close').mockImplementation(() => {});
  new Function(bootstrapSource)();
  const respond = (payload: any, error: string | null = null) => {
    const req = posted[0];
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          protocol: PROTOCOL,
          type: 'res',
          id: req.id,
          source: 'host',
          target: req.source,
          action: req.action,
          payload,
          error,
        },
        source: window,
      }),
    );
  };
  return { posted, created, open, write, close, respond };
}

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('guest_bootstrap.js', () => {
  it('自分の PID で sys:boot を頼む（IPC v2 の要求の形）', () => {
    const { posted } = boot('p1');
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      protocol: PROTOCOL,
      type: 'req',
      source: 'p1',
      target: 'host',
      action: 'sys:boot',
      payload: {},
      error: null,
    });
    expect(typeof posted[0].id).toBe('string');
  });

  it('PID が無ければ何も頼まず、失敗を表示する', () => {
    const { posted } = boot(undefined);
    expect(posted).toHaveLength(0);
    expect(document.body.textContent).toContain('__ITERA_PID__');
  });

  it('束から後順に URL を作り、目印を置き換えて同じ文書に本体を書く', async () => {
    const { created, open, write, close, respond } = boot('p1');
    const png = new Blob(['PNG'], { type: 'image/png' });
    respond({
      html: '<html><head><link href="M_css"></head><body><img src="M_png#v"></body></html>',
      hash: '',
      assets: [
        { id: 'M_png', path: 'a/bg.png', mime: 'image/png', kind: 'blob', blob: png },
        { id: 'M_css', path: 'a/s.css', mime: 'text/css', kind: 'text', text: 'body{background:url(M_png)}' },
      ],
    });
    expect(created).toHaveLength(2);
    expect(created[0]).toBe(png); // 実体はそのまま（複製しない）
    expect(created[1].type).toBe('text/css');
    expect(await created[1].text()).toBe('body{background:url(blob:null/1)}'); // 先の URL で置換してから Blob に
    expect(open).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      '<html><head><link href="blob:null/2"></head><body><img src="blob:null/1#v"></body></html>',
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('入口の #hash は書く前に location.hash に写す', () => {
    const { respond } = boot('p1');
    respond({ html: '<html></html>', hash: '#sec', assets: [] });
    expect(window.location.hash).toBe('#sec');
    window.location.hash = '';
  });

  it('ホストが断れば本体を書かず、理由を表示する', () => {
    const { write, respond } = boot('p1');
    respond(null, 'Process [p1] not found.');
    expect(write).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Process [p1] not found.');
  });

  it('自分の要求以外の応答・親以外からの応答には反応せず、応答を受けたらリスナを外す', () => {
    const { posted, write, respond } = boot('p1');
    const other = {
      protocol: PROTOCOL,
      type: 'res',
      id: 'someone-else',
      source: 'host',
      target: 'p1',
      action: 'sys:boot',
      payload: { html: 'X', assets: [] },
      error: null,
    };
    window.dispatchEvent(new MessageEvent('message', { data: other, source: window }));
    window.dispatchEvent(new MessageEvent('message', { data: { ...other, id: posted[0].id }, source: null }));
    expect(write).not.toHaveBeenCalled();
    respond({ html: 'A', hash: '', assets: [] });
    respond({ html: 'B', hash: '', assets: [] });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('A');
  });
});
