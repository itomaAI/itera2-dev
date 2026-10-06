/**
 * src/core/cognitive/adapters/RelayFetchFailure.test.ts
 * 中継への送信が応答を返さずに落ちたときに、理由の分かる文言にする（T-0622。ミャク楽 T-0594）
 *
 * 守りたいのは:
 *   1. 中継を通すとき、上限を超える本文は送らずに止め、大きさと次の一手を伝える
 *   2. fetch が落ちたら、本文の大きさ・理由の候補を添えて投げ直す（大きい本文なら添付のことも）
 *   3. 中断（AbortError）はそのまま投げ直す
 *   4. 🔴 中継を通さない（利用者の鍵で直接叩く）ときは **何も変えない** —— 上限で止めず、失敗もそのまま
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AnthropicAdapter } from './AnthropicAdapter';
import { GeminiAdapter } from './GeminiAdapter';
import { OpenAIAdapter } from './OpenAIAdapter';
import { RELAY_MAX_REQUEST_BYTES, RELAY_LARGE_REQUEST_BYTES, type RelayTransport } from './BaseAdapter';

const RELAY = 'https://asia-northeast1-itera2.cloudfunctions.net/llmProxy';

function relay(): RelayTransport {
  return { baseUrl: RELAY, getAuthHeaders: async () => ({ Authorization: 'Bearer T' }), strictOpenAISchema: true };
}

function emptyStream(): any {
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return { read: async () => ({ done: true, value: undefined }), cancel: async () => {}, releaseLock() {} };
      },
    },
  };
}

const anthropicPayload = (bytes: number) => ({
  system: 's',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'a'.repeat(bytes) }] }],
});
const noop = () => {};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => emptyStream());
  globalThis.fetch = fetchMock as any;
});

describe('中継の上限を超える本文', () => {
  it('送らずに止め、大きさと次の一手を伝える（3 形式とも）', async () => {
    const big = 'a'.repeat(RELAY_MAX_REQUEST_BYTES + 1024);
    const runs = [
      () => new AnthropicAdapter('', 'smart', {}, null, relay()).generateStream(anthropicPayload(big.length), noop),
      () =>
        new GeminiAdapter('', 'standard', {}, null, relay()).generateStream(
          [{ role: 'user', parts: [{ text: big }] }],
          noop,
        ),
      () =>
        new OpenAIAdapter('', 'cheap', '', {}, null, relay()).generateStream([{ role: 'user', content: big }], noop),
    ];
    for (const run of runs) {
      await expect(run()).rejects.toThrow(/too large for the LLM relay \(about 32\.\d MB; the limit is 32\.0 MB\)/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('上限の手前なら送る', async () => {
    await new AnthropicAdapter('', 'smart', {}, null, relay()).generateStream(
      anthropicPayload(RELAY_MAX_REQUEST_BYTES - 4096),
      noop,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('中継を通さないときは上限で止めない（直接叩く経路は変えない）', async () => {
    await new AnthropicAdapter('KEY', 'claude-x', {}, null, null).generateStream(
      anthropicPayload(RELAY_MAX_REQUEST_BYTES + 1024),
      noop,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('中継への fetch が応答を返さずに落ちた', () => {
  it('大きさと元の理由を添える（小さい本文: 一時的な不調として）', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const run = new AnthropicAdapter('', 'smart', {}, null, relay()).generateStream(anthropicPayload(1000), noop);
    await expect(run).rejects.toThrow(
      /^Could not reach the LLM relay \(Failed to fetch; the request was about 0\.0 MB\)\. The connection may have dropped/,
    );
  });

  it('大きい本文なら、添付が毎回送り直されることと次の一手を伝える', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const run = new AnthropicAdapter('', 'smart', {}, null, relay()).generateStream(
      anthropicPayload(RELAY_LARGE_REQUEST_BYTES + 1024),
      noop,
    );
    await expect(run).rejects.toThrow(
      /about 16\.0 MB\)\. Large requests \(over 16\.0 MB\) can fail .*Start a new conversation/,
    );
  });

  it('🔴 中継を通さないときは、失敗を包まずそのまま投げる（直接叩く経路は変えない）', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const run = new GeminiAdapter('KEY', 'gemini-x', {}, null, null).generateStream(
      [{ role: 'user', parts: [{ text: 'x' }] }],
      noop,
    );
    await expect(run).rejects.toThrow(/^Failed to fetch$/);
  });

  it('中断（AbortError）はそのまま投げ直す', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));
    const run = new AnthropicAdapter('', 'smart', {}, null, relay()).generateStream(anthropicPayload(10), noop);
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  });
});
