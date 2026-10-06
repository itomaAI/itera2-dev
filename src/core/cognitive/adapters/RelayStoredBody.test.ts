/**
 * src/core/cognitive/adapters/RelayStoredBody.test.ts
 * 大きな本文は Storage に置き、中継には在り処だけを送る（T-0622。ミャク楽 T-0600）
 *
 * 守りたいのは:
 *   1. 閾値（24 MiB）を超えたら置いて、印だけを同じ宛先へ送る（3 形式とも同じ口）
 *   2. 閾値以下は今のまま送る（置かない）
 *   3. 置ける上限（64 MiB）を超えたら、置かずに理由を伝える
 *   4. 置く口が無ければ（バケットの分からない配布物）、従来どおり 32 MiB で止める
 *   5. 置くのに失敗したら理由を伝える。中断は中断のまま
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AnthropicAdapter } from './AnthropicAdapter';
import { GeminiAdapter } from './GeminiAdapter';
import {
  RELAY_MAX_REQUEST_BYTES,
  RELAY_STASH_THRESHOLD_BYTES,
  RELAY_STORED_MAX_BYTES,
  type RelayTransport,
} from './BaseAdapter';

const RELAY = 'https://asia-northeast1-itera2.cloudfunctions.net/llmProxy';

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
let stashed: string[];
type Stash = (body: string, signal?: AbortSignal) => Promise<string>;
let stashBody: ReturnType<typeof vi.fn<Stash>>;

function relay(withStash = true): RelayTransport {
  return {
    baseUrl: RELAY,
    getAuthHeaders: async () => ({ Authorization: 'Bearer T' }),
    ...(withStash ? { stashBody } : {}),
  };
}

beforeEach(() => {
  fetchMock = vi.fn(async () => emptyStream());
  globalThis.fetch = fetchMock as any;
  stashed = [];
  stashBody = vi.fn<Stash>(async (body: string) => {
    stashed.push(body);
    return 'llmRelayBodies/u1/abcdefgh-1234.json';
  });
});

describe('大きな本文は Storage に置いて在り処だけを送る', () => {
  it('Anthropic: 閾値を超えたら置き、印だけを同じ宛先へ送る', async () => {
    await new AnthropicAdapter('', 'smart', {}, null, relay()).generateStream(
      anthropicPayload(RELAY_STASH_THRESHOLD_BYTES + 1024),
      noop,
    );
    expect(stashBody).toHaveBeenCalledTimes(1);
    // 置いたのは送るはずだった本文そのもの（モデル名なども含む）
    expect(JSON.parse(stashed[0]).model).toBe('smart');
    expect(stashed[0].length).toBeGreaterThan(RELAY_STASH_THRESHOLD_BYTES);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${RELAY}/v1/messages`);
    expect(JSON.parse(init.body)).toEqual({ relayStoredBody: { path: 'llmRelayBodies/u1/abcdefgh-1234.json' } });
    expect(init.headers.Authorization).toBe('Bearer T');
  });

  it('Gemini: 同じ口を通る（宛先はモデル名つきの URL のまま）', async () => {
    const big = 'a'.repeat(RELAY_STASH_THRESHOLD_BYTES + 1024);
    await new GeminiAdapter('', 'standard', {}, null, relay()).generateStream(
      [{ role: 'user', parts: [{ text: big }] }],
      noop,
    );
    expect(stashBody).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1beta/models/standard:streamGenerateContent');
    expect(Object.keys(JSON.parse(init.body))).toEqual(['relayStoredBody']);
  });

  it('閾値以下は置かずに今のまま送る', async () => {
    await new AnthropicAdapter('', 'smart', {}, null, relay()).generateStream(anthropicPayload(1024), noop);
    expect(stashBody).not.toHaveBeenCalled();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages).toBeTruthy();
  });

  it('置ける上限を超えたら、置かずに理由を伝える', async () => {
    await expect(
      new AnthropicAdapter('', 'smart', {}, null, relay()).generateStream(
        anthropicPayload(RELAY_STORED_MAX_BYTES + 1024),
        noop,
      ),
    ).rejects.toThrow(/too large for the LLM relay \(about 64\.\d MB; the limit is 64\.0 MB\)/);
    expect(stashBody).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('置く口が無ければ、従来どおり 32 MiB で止める', async () => {
    await expect(
      new AnthropicAdapter('', 'smart', {}, null, relay(false)).generateStream(
        anthropicPayload(RELAY_MAX_REQUEST_BYTES + 1024),
        noop,
      ),
    ).rejects.toThrow(/the limit is 32\.0 MB/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('置くのに失敗したら理由を伝え、中継へは送らない', async () => {
    stashBody.mockRejectedValueOnce(new Error('storage upload failed: HTTP 403'));
    await expect(
      new AnthropicAdapter('', 'smart', {}, null, relay()).generateStream(
        anthropicPayload(RELAY_STASH_THRESHOLD_BYTES + 1024),
        noop,
      ),
    ).rejects.toThrow(/Could not hand the request .* to the LLM relay \(storage upload failed: HTTP 403\)/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('置いている途中の中断は、中断として投げ直す', async () => {
    const controller = new AbortController();
    stashBody.mockImplementationOnce(async () => {
      controller.abort();
      throw new Error('canceled');
    });
    await expect(
      new AnthropicAdapter('', 'smart', {}, null, relay()).generateStream(
        anthropicPayload(RELAY_STASH_THRESHOLD_BYTES + 1024),
        noop,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
