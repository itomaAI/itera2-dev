/**
 * src/core/cognitive/adapters/AnthropicDirect.test.ts
 *
 * 利用者の鍵で Anthropic へ直接つなぐ経路（中継を使わない）の送信内容を固定する（T-0922）。
 *
 * ブラウザから api.anthropic.com を呼ぶには、同意のヘッダ `anthropic-dangerous-direct-browser-access: true` が要る。
 * 名前が違うと CORS で落ち、ブラウザからは一切通らない（itera2-dev #49 の直し）。
 * それまで、ヘッダの名前を前の形に戻しても落ちる試験が無かった。
 *
 * 中継の経路は RelayTransport.test.ts が見る。ここでは直結の経路だけを見る。
 * 添付（Files API）のヘッダの有無は見ない。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AnthropicAdapter } from './AnthropicAdapter';

let calls: { url: string; method: string; headers: Record<string, string>; body: any }[] = [];
const originalFetch = globalThis.fetch;

/** 中身の無い SSE を返す。ここで見たいのは送信側なので、応答は空で足りる。 */
function emptyStream(): any {
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read: async () => ({ done: true, value: undefined }),
          cancel: async () => {},
          releaseLock() {},
        };
      },
    },
  };
}

const noop = () => {};

beforeEach(() => {
  calls = [];
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    calls.push({
      url: String(url),
      method: String(init?.method || 'GET'),
      headers: (init?.headers || {}) as Record<string, string>,
      body: init?.body ? JSON.parse(init.body) : null,
    });
    return emptyStream();
  }) as any;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Anthropic 直結（中継なし・利用者の鍵）', () => {
  it('api.anthropic.com の /v1/messages へ、鍵と直結の同意ヘッダを付けて送る', async () => {
    const adapter = new AnthropicAdapter('sk-ant-user-key', 'claude-sonnet-5', {}, null);
    await adapter.generateStream({ system: 's', messages: [] }, noop);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0].method).toBe('POST');
    const headers = calls[0].headers;
    expect(headers['x-api-key']).toBe('sk-ant-user-key');
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['Authorization']).toBeUndefined();
    expect(calls[0].body.model).toBe('claude-sonnet-5');
  });

  it('前の名前のヘッダ（anthropic-dangerously-allow-browser）は付けない', async () => {
    const adapter = new AnthropicAdapter('sk-ant-user-key', 'claude-sonnet-5', {}, null);
    await adapter.generateStream({ system: 's', messages: [] }, noop);

    expect(calls[0].headers['anthropic-dangerously-allow-browser']).toBeUndefined();
  });
});
