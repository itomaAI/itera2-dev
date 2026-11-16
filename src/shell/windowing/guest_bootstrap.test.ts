// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import bootstrapSource from './guest_bootstrap.js?raw';

/**
 * src/shell/windowing/guest_bootstrap.test.ts
 * 二段起動の 1 段目（T-0770 / T-0784 / T-0827）。ブートストラップは
 *   1. 自分の本体（束）を親の窓に頼み —— 入口は PID で sys:boot をホストへ、入れ子の文書は目印で親の文書へ（itera:doc:v1）、
 *   2. 返ってきた束から後順に object URL を作って（text は先の URL で目印を置換してから）目印を置き換え、
 *   3. 同じ文書に document.open / write / close で本体を書き、
 *   4. 自分の応答待ちのリスナを外す（以後の応答に反応しない）。
 *   5. 束の中の入れ子の文書（kind: 'doc'）は 1 段目の文書を URL にして束を預かり、起きてきた子に渡す。
 * jsdom では parent === window なので、親の代わりに window.postMessage を捕まえ、応答を message イベントで返す。
 */

const PROTOCOL = 'itera:ipc:v2';
const DOC_PROTOCOL = 'itera:doc:v1';

/** この試験の間に足された message のリスナ（window は試験をまたいで残るので、終わりに外す） */
const listeners: EventListenerOrEventListenerObject[] = [];

/** message イベントを届ける。source は窓でなくてよい（子の窓の代わりに postMessage を持つ物を渡す） */
function deliver(data: unknown, source: unknown) {
  const ev = new Event('message');
  Object.defineProperty(ev, 'data', { value: data });
  Object.defineProperty(ev, 'source', { value: source });
  window.dispatchEvent(ev);
}

function boot(pid: string | undefined, docId?: string) {
  (window as any).__ITERA_PID__ = pid;
  (window as any).__ITERA_DOC__ = docId;
  const posted: any[] = [];
  window.postMessage = ((msg: any) => posted.push(msg)) as any;
  const created: Blob[] = [];
  (URL as any).createObjectURL = (b: Blob) => {
    created.push(b);
    return `blob:null/${created.length}`;
  };
  const realAdd = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation(((type: string, fn: any, opts: any) => {
    if (type === 'message') listeners.push(fn);
    realAdd(type, fn, opts);
  }) as any);
  const open = vi.spyOn(document, 'open').mockImplementation((() => document) as any);
  const write = vi.spyOn(document, 'write').mockImplementation(() => {});
  const close = vi.spyOn(document, 'close').mockImplementation(() => {});
  new Function(bootstrapSource)();
  const respond = (payload: any, error: string | null = null) => {
    const req = posted[0];
    deliver(
      {
        protocol: req.protocol,
        type: 'res',
        id: req.id,
        source: 'host',
        target: req.source,
        action: req.action,
        payload,
        error,
      },
      window,
    );
  };
  return { posted, created, open, write, close, respond };
}

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  for (const fn of listeners.splice(0)) window.removeEventListener('message', fn);
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
    deliver(other, window);
    deliver({ ...other, id: posted[0].id }, null);
    // 入口の応答は IPC の合図で来る。入れ子の文書の合図では受けない
    deliver({ ...other, id: posted[0].id, protocol: DOC_PROTOCOL }, window);
    expect(write).not.toHaveBeenCalled();
    respond({ html: 'A', hash: '', assets: [] });
    respond({ html: 'B', hash: '', assets: [] });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('A');
  });
});

describe('guest_bootstrap.js: 入れ子の文書を持つ束（T-0827）', () => {
  const png = new Blob(['PNG'], { type: 'image/png' });
  const inner = {
    html: '<img src="C_png">',
    assets: [{ id: 'C_png', path: 'a/sub/x.png', mime: 'image/png', kind: 'blob', blob: png }],
  };
  const outer = () => ({
    html: '<iframe src="M_doc#h"></iframe><iframe src="M_doc"></iframe>',
    hash: '',
    assets: [
      { id: 'M_doc', path: 'a/sub.html', mime: 'text/html', kind: 'doc', boot: '<html>BOOT M_doc</html>', doc: inner },
    ],
  });
  const child = () => ({ postMessage: vi.fn() });

  it('入れ子の文書は 1 段目の文書だけを URL にして枠に入れる（子の束の資源の URL は作らない）', async () => {
    const { created, write, respond } = boot('p1');
    respond(outer());
    expect(created).toHaveLength(1);
    expect(created[0].type).toBe('text/html');
    expect(await created[0].text()).toBe('<html>BOOT M_doc</html>'); // 1 段目の中の目印は置き換えない（子が親に名乗る名前）
    expect(write).toHaveBeenCalledWith('<iframe src="blob:null/1#h"></iframe><iframe src="blob:null/1"></iframe>');
  });

  it('起きてきた子（itera:doc:v1 の要求）に、その文書の束を渡す。同じ文書を何度頼まれても渡す', () => {
    const { respond } = boot('p1');
    respond(outer());
    const c1 = child();
    const c2 = child();
    deliver({ protocol: DOC_PROTOCOL, type: 'req', id: 'r1', doc: 'M_doc' }, c1);
    deliver({ protocol: DOC_PROTOCOL, type: 'req', id: 'r2', doc: 'M_doc' }, c2);
    expect(c1.postMessage).toHaveBeenCalledTimes(1);
    expect(c1.postMessage).toHaveBeenCalledWith(
      { protocol: DOC_PROTOCOL, type: 'res', id: 'r1', payload: inner, error: null },
      '*',
    );
    expect(c2.postMessage).toHaveBeenCalledWith(
      { protocol: DOC_PROTOCOL, type: 'res', id: 'r2', payload: inner, error: null },
      '*',
    );
  });

  it('知らない文書には誤りを返す。合図の違うもの・要求でないもの・送り主の無いものには答えない', () => {
    const { respond } = boot('p1');
    respond(outer());
    const c = child();
    deliver({ protocol: DOC_PROTOCOL, type: 'req', id: 'r1', doc: 'toString' }, c);
    expect(c.postMessage).toHaveBeenCalledTimes(1);
    expect(c.postMessage).toHaveBeenCalledWith(
      { protocol: DOC_PROTOCOL, type: 'res', id: 'r1', payload: null, error: 'Unknown document' },
      '*',
    );
    c.postMessage.mockClear();
    deliver({ protocol: PROTOCOL, type: 'req', id: 'r2', doc: 'M_doc', action: 'sys:boot' }, c);
    deliver({ protocol: DOC_PROTOCOL, type: 'res', id: 'r3', doc: 'M_doc' }, c);
    deliver(null, c);
    deliver({ protocol: DOC_PROTOCOL, type: 'req', id: 'r4', doc: 'M_doc' }, null);
    expect(c.postMessage).not.toHaveBeenCalled();
  });

  it('子に答えるリスナは document.open() の後、本体を書く前に足す（前に足すと open() が外す）', () => {
    const order: string[] = [];
    const { open, write, respond } = boot('p1');
    open.mockImplementation((() => (order.push('open'), document)) as any);
    write.mockImplementation(() => void order.push('write'));
    vi.mocked(window.addEventListener).mockImplementation(((type: string) => {
      if (type === 'message') order.push('listen');
    }) as any);
    respond(outer());
    expect(order).toEqual(['open', 'listen', 'write']);
  });

  it('入れ子の文書の無い束では、リスナを足さない', () => {
    const { respond } = boot('p1');
    const count = listeners.length;
    respond({ html: '<p>plain</p>', hash: '', assets: [] });
    expect(listeners.length).toBe(count);
  });
});

describe('guest_bootstrap.js: 入れ子の文書の 1 段目（T-0827）', () => {
  it('親の文書に、自分の目印で束を頼む（itera:doc:v1。IPC の要求ではない）', () => {
    const { posted } = boot(undefined, 'D1');
    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({ protocol: DOC_PROTOCOL, type: 'req', id: expect.any(String), doc: 'D1' });
  });

  it('受け取った束を、入口と同じ手順で同じ文書に書く', async () => {
    const { created, open, write, close, respond } = boot(undefined, 'D1');
    const png = new Blob(['PNG'], { type: 'image/png' });
    respond({
      html: '<link href="M_css"><img src="M_png">',
      assets: [
        { id: 'M_png', path: 'a/bg.png', mime: 'image/png', kind: 'blob', blob: png },
        { id: 'M_css', path: 'a/s.css', mime: 'text/css', kind: 'text', text: 'body{background:url(M_png)}' },
      ],
    });
    expect(created[0]).toBe(png);
    expect(await created[1].text()).toBe('body{background:url(blob:null/1)}');
    expect(open).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('<link href="blob:null/2"><img src="blob:null/1">');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('親が断れば本体を書かず、理由を表示する', () => {
    const { write, respond } = boot(undefined, 'D1');
    respond(null, 'Unknown document');
    expect(write).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('nested document');
    expect(document.body.textContent).toContain('Unknown document');
  });

  it('IPC の合図の応答・親以外からの応答には反応しない', () => {
    const { posted, write, respond } = boot(undefined, 'D1');
    const res = {
      protocol: DOC_PROTOCOL,
      type: 'res',
      id: posted[0].id,
      payload: { html: 'X', assets: [] },
      error: null,
    };
    deliver({ ...res, protocol: PROTOCOL }, window);
    deliver(res, { postMessage() {} });
    expect(write).not.toHaveBeenCalled();
    respond({ html: 'A', assets: [] });
    expect(write).toHaveBeenCalledWith('A');
  });
});
