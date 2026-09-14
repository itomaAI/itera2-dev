/**
 * src/core/cognitive/adapters/RelayTransport.test.ts
 *
 * 中継（運営の鍵で LLM を呼ぶプロキシ）へ話すときの送信内容を固定する。
 *
 * 守りたいこと:
 *   1. 経路が中継の実装（functions/src/llmRelay.ts）と一致していること
 *   2. 利用者の鍵を中継へ送らないこと（x-api-key / ?key= / 持ち込みの Bearer）
 *   3. 中継の CORS が許可しないヘッダを付けないこと。
 *      許可は Authorization / Content-Type / anthropic-version / anthropic-beta の4つだけで、
 *      余計なヘッダを足すと preflight で落ち、ブラウザからは一切通らなくなる
 *   4. 認証が取れなければ**送信しない**（未認証で投げると 401 が返るだけで理由が伝わらない）
 *   5. ID トークンは失効するので、生成のたびに取り直すこと
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AnthropicAdapter } from './AnthropicAdapter';
import { GeminiAdapter } from './GeminiAdapter';
import { OpenAIAdapter } from './OpenAIAdapter';
import type { RelayTransport } from './BaseAdapter';

const RELAY = 'https://asia-northeast1-itera2.cloudfunctions.net/llmProxy';

let calls: { url: string; headers: Record<string, string>; body: any }[] = [];
let authCalls = 0;

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

function relay(overrides: Partial<RelayTransport> = {}): RelayTransport {
  return {
    baseUrl: RELAY,
    getAuthHeaders: async () => {
      authCalls += 1;
      return { Authorization: `Bearer TOKEN-${authCalls}` };
    },
    strictOpenAISchema: true,
    ...overrides,
  };
}

const noop = () => {};

beforeEach(() => {
  calls = [];
  authCalls = 0;
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    calls.push({
      url: String(url),
      headers: (init?.headers || {}) as Record<string, string>,
      body: init?.body ? JSON.parse(init.body) : null,
    });
    return emptyStream();
  }) as any;
});

describe('Anthropic 形式', () => {
  it('中継の /v1/messages へ送る', async () => {
    const adapter = new AnthropicAdapter('', 'smart', {}, null, relay());
    await adapter.generateStream({ system: 's', messages: [] }, noop);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${RELAY}/v1/messages`);
    expect(calls[0].body.model).toBe('smart');
  });

  it('利用者の鍵を送らず、CORS が許可するヘッダだけを付ける', async () => {
    const adapter = new AnthropicAdapter('sk-ant-user-key', 'smart', {}, null, relay());
    await adapter.generateStream({ system: 's', messages: [] }, noop);

    const headers = calls[0].headers;
    expect(headers['Authorization']).toBe('Bearer TOKEN-1');
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers['anthropic-dangerous-direct-browser-access']).toBeUndefined();
    expect(headers['anthropic-version']).toBe('2023-06-01');
    // itera2-dev の Anthropic アダプタは anthropic-beta（Files API）を送らない（添付は本文に base64 で載せる）
    expect(Object.keys(headers).sort()).toEqual(['Authorization', 'Content-Type', 'anthropic-version'].sort());
  });

  it('中継を使わないときは従来どおり各社へ直接、鍵つきで送る', async () => {
    const adapter = new AnthropicAdapter('sk-ant-user-key', 'claude-sonnet-5', {}, null);
    await adapter.generateStream({ system: 's', messages: [] }, noop);

    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0].headers['x-api-key']).toBe('sk-ant-user-key');
    expect(calls[0].headers['Authorization']).toBeUndefined();
  });
});

describe('Gemini 形式', () => {
  it('中継の /v1beta/models/<別名>:streamGenerateContent へ送る', async () => {
    const adapter = new GeminiAdapter('', 'standard', {}, null, relay());
    await adapter.generateStream([], noop);

    expect(calls[0].url).toBe(`${RELAY}/v1beta/models/standard:streamGenerateContent?alt=sse`);
    expect(calls[0].url).not.toContain('key=');
    expect(calls[0].headers['Authorization']).toBe('Bearer TOKEN-1');
  });

  it('中継を使わないときは従来どおり鍵を URL に載せる', async () => {
    const adapter = new GeminiAdapter('AIzaUSERKEY', 'gemini-3.6-flash', {}, null);
    await adapter.generateStream([], noop);

    expect(calls[0].url).toContain('generativelanguage.googleapis.com');
    expect(calls[0].url).toContain('key=AIzaUSERKEY');
  });

  it('中継を使わず鍵も無ければ送信しない', async () => {
    const adapter = new GeminiAdapter('', 'gemini-3.6-flash', {}, null);
    await expect(adapter.generateStream([], noop)).rejects.toThrow('API Key is missing.');
    expect(calls).toHaveLength(0);
  });
});

describe('OpenAI 形式', () => {
  it('中継の /v1/chat/completions へ送る', async () => {
    const adapter = new OpenAIAdapter('', 'smart-openai', RELAY, {}, null, relay());
    await adapter.generateStream([], noop);

    expect(calls[0].url).toBe(`${RELAY}/v1/chat/completions`);
    expect(calls[0].headers['Authorization']).toBe('Bearer TOKEN-1');
  });

  it('中継では上流が本家なので、未知の設定を素通ししない', async () => {
    const adapter = new OpenAIAdapter('', 'smart-openai', RELAY, { unknown_option: 'x' }, null, relay());
    await adapter.generateStream([], noop);

    expect(calls[0].body.unknown_option).toBeUndefined();
  });

  it('中継を使わない Custom では従来どおり素通しする（対照）', async () => {
    const adapter = new OpenAIAdapter('', 'local-model', 'http://localhost:11434/v1', { unknown_option: 'x' }, null);
    await adapter.generateStream([], noop);

    expect(calls[0].url).toBe('http://localhost:11434/v1/chat/completions');
    expect(calls[0].body.unknown_option).toBe('x');
  });
});

describe('認証の扱い', () => {
  it('認証ヘッダが取れなければ送信しない', async () => {
    const empty = relay({ getAuthHeaders: async () => ({}) });

    await expect(
      new AnthropicAdapter('', 'smart', {}, null, empty).generateStream({ system: '', messages: [] }, noop),
    ).rejects.toThrow('Could not get credentials for the LLM relay');
    await expect(new GeminiAdapter('', 'standard', {}, null, empty).generateStream([], noop)).rejects.toThrow(
      'Could not get credentials for the LLM relay',
    );
    await expect(new OpenAIAdapter('', 'x', RELAY, {}, null, empty).generateStream([], noop)).rejects.toThrow(
      'Could not get credentials for the LLM relay',
    );

    expect(calls).toHaveLength(0);
  });

  it('取得側が失敗したときも送信しない', async () => {
    const failing = relay({
      getAuthHeaders: async () => {
        throw new Error('Sign in to Itera Cloud to use the LLM relay.');
      },
    });

    await expect(new GeminiAdapter('', 'standard', {}, null, failing).generateStream([], noop)).rejects.toThrow(
      'Sign in to Itera Cloud',
    );
    expect(calls).toHaveLength(0);
  });

  it('生成のたびに認証を取り直す（ID トークンは失効する）', async () => {
    const adapter = new GeminiAdapter('', 'standard', {}, null, relay());

    await adapter.generateStream([], noop);
    await adapter.generateStream([], noop);

    expect(authCalls).toBe(2);
    expect(calls[0].headers['Authorization']).toBe('Bearer TOKEN-1');
    expect(calls[1].headers['Authorization']).toBe('Bearer TOKEN-2');
  });
});
