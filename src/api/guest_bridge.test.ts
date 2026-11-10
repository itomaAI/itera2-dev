// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import bridgeSource from './guest_bridge.js?raw';

/**
 * src/api/guest_bridge.test.ts
 * resolveUrl の URL と、ホストの保持（T-0798）。
 *   - resolveUrl は fs:read_blob の Blob から自分の窓で object URL を作り、URL → 券（hold）を覚える
 *   - URL.revokeObjectURL(url) は元の revoke を呼んだうえで、その券を fs:release_blob で返す（1 回だけ）
 *   - resolveUrl が作っていない URL・券の無い URL（中身の無いファイル）には何も送らない
 * jsdom では parent === window なので、ホストの代わりに window.postMessage を捕まえ、応答を MessageEvent で返す
 * （guest_bootstrap.test.ts と同じ型）。
 */

const PROTOCOL = 'itera:ipc:v2';

function loadBridge() {
  (window as any).__ITERA_PID__ = 'p1';
  delete (window as any).MetaOS;
  const posted: any[] = [];
  window.postMessage = ((msg: any) => posted.push(msg)) as any;
  const created: Blob[] = [];
  const revoked: string[] = [];
  (URL as any).createObjectURL = (b: Blob) => {
    created.push(b);
    return `blob:null/${created.length}`;
  };
  (URL as any).revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
  new Function(bridgeSource)();
  const requests = (action: string) => posted.filter((m) => m.type === 'req' && m.action === action);
  const respond = (req: any, payload: any) =>
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
          error: null,
        },
        source: window,
      }),
    );
  const resolveUrl = async (path: string, payload: any) => {
    const before = requests('fs:read_blob').length;
    const p = (window as any).MetaOS.fs.resolveUrl(path);
    const req = requests('fs:read_blob')[before];
    expect(req.payload).toEqual({ path });
    respond(req, payload);
    return (await p) as string;
  };
  return { requests, respond, resolveUrl, revoked };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('guest_bridge.js: resolveUrl の URL を revoke すると、ホストの保持を手放す', () => {
  it('revoke で元の revoke が呼ばれ、券が fs:release_blob で返る。2 度目は何も送らない', async () => {
    const b = loadBridge();
    const url = await b.resolveUrl('a.png', { blob: new Blob(['x']), mime: 'image/png', hold: 'n@1' });
    expect(url).toBe('blob:null/1');
    expect(b.requests('fs:release_blob')).toEqual([]);

    URL.revokeObjectURL(url);
    expect(b.revoked).toEqual([url]);
    const sent = b.requests('fs:release_blob');
    expect(sent.length).toBe(1);
    expect(sent[0].payload).toEqual({ hold: 'n@1' });
    expect(sent[0].source).toBe('p1');

    URL.revokeObjectURL(url);
    expect(b.revoked).toEqual([url, url]);
    expect(b.requests('fs:release_blob').length).toBe(1);
  });

  it('同じファイルを 2 回 resolveUrl したら URL も券も別々に数える', async () => {
    const b = loadBridge();
    const u1 = await b.resolveUrl('a.png', { blob: new Blob(['x']), mime: 'image/png', hold: 'n@1' });
    const u2 = await b.resolveUrl('a.png', { blob: new Blob(['x']), mime: 'image/png', hold: 'n@1' });
    expect(u1).not.toBe(u2);
    URL.revokeObjectURL(u1);
    expect(b.requests('fs:release_blob').map((m) => m.payload)).toEqual([{ hold: 'n@1' }]);
    URL.revokeObjectURL(u2);
    expect(b.requests('fs:release_blob').map((m) => m.payload)).toEqual([{ hold: 'n@1' }, { hold: 'n@1' }]);
  });

  it('resolveUrl が作っていない URL には、元の revoke だけ', () => {
    const b = loadBridge();
    URL.revokeObjectURL('blob:null/made-by-the-app');
    expect(b.revoked).toEqual(['blob:null/made-by-the-app']);
    expect(b.requests('fs:release_blob')).toEqual([]);
  });

  it('券の無い URL（中身の無いファイル）は何も送らない', async () => {
    const b = loadBridge();
    const url = await b.resolveUrl('empty.txt', { blob: new Blob([]), mime: 'text/plain', hold: null });
    URL.revokeObjectURL(url);
    expect(b.revoked).toEqual([url]);
    expect(b.requests('fs:release_blob')).toEqual([]);
  });
});
