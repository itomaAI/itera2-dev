/**
 * src/core/cognitive/adapters/BaseAdapter.idle.test.ts
 *
 * ストリームの無音の見張り（`monitorStream`）を固定する。
 * ミャク楽側で先に直したもの（T-0276）を itera2 へ揃えた（T-0492）。
 *
 * 守りたいこと:
 *   1. 本文の最初の 1 文字が来るまでは 30 秒で切らない（推論中の無音でモデルを殺さない）
 *   2. `message_start` や ping のようにバイトは届くが本文が無い間も、1 と同じ扱い
 *      （Anthropic は message_start が先に届く。バイトを基準にすると思考中に 30 秒で落ちる）
 *   3. 本文が流れ始めたあとは 30 秒の無音で切る（途中で通信が切れたことを検出する）
 *   4. 本文が来ないまま長い上限を超えたら、それと分かる文言で切る
 *   （各アダプタが onChunk の直前で markContentStarted を呼ぶことは、型で強制できないので目で見る）
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import { BaseLLMAdapter, STREAM_IDLE_TIMEOUT_MS, STREAM_FIRST_CHUNK_TIMEOUT_MS } from './BaseAdapter';

/** 本文の印: 塊の文字列に `TEXT` を含むものを「本文」とみなして markContentStarted を呼ぶ（実アダプタの onChunk の直前に相当） */
class Probe extends BaseLLMAdapter {
  async generateStream(): Promise<void> {}
  async collect(reader: any, signal?: AbortSignal): Promise<string[]> {
    const out: string[] = [];
    for await (const chunk of this.monitorStream(reader, signal)) {
      const s = new TextDecoder().decode(chunk);
      if (s.includes('TEXT')) this.markContentStarted();
      out.push(s);
    }
    return out;
  }
}

/** 「次の read が解決する時刻」を手で決められる reader の代役。cancel は待っている read を done で解決する（本物と同じ）。 */
function scriptedReader(steps: Array<{ at: number; text?: string; done?: boolean }>) {
  let i = 0;
  let cancelled = false;
  let pending: ((v: { done: boolean; value?: Uint8Array }) => void) | null = null;
  const start = Date.now();
  return {
    read: () =>
      new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
        if (cancelled || i >= steps.length) return resolve({ done: true });
        const s = steps[i++];
        const wait = Math.max(0, start + s.at - Date.now());
        pending = resolve;
        setTimeout(() => {
          if (pending !== resolve) return; // cancel で先に解決済み
          pending = null;
          resolve(s.done ? { done: true } : { done: false, value: new TextEncoder().encode(s.text || '') });
        }, wait);
      }),
    cancel: async () => {
      cancelled = true;
      const p = pending;
      pending = null;
      if (p) p({ done: true });
    },
    releaseLock() {},
  } as any;
}

function probe() {
  return new Probe({}, null, null);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('本文の最初の 1 文字まで', () => {
  it('30 秒を超えて無音でも切らない（3 分後に本文が来れば読める）', async () => {
    vi.useFakeTimers();
    const r = scriptedReader([
      { at: 180_000, text: 'TEXT a' },
      { at: 180_010, done: true },
    ]);
    const p = probe().collect(r);
    await vi.advanceTimersByTimeAsync(180_020);
    await expect(p).resolves.toEqual(['TEXT a']);
    expect(STREAM_FIRST_CHUNK_TIMEOUT_MS).toBeGreaterThan(180_000);
  });

  it('message_start や ping（本文でないバイト）が届いても、本文が来るまでは長い上限のまま', async () => {
    vi.useFakeTimers();
    const r = scriptedReader([
      { at: 100, text: 'event: message_start' },
      { at: 20_000, text: 'event: ping' },
      { at: 20_000 + 120_000, text: 'TEXT a' }, // ping のあと 2 分の無音（思考中）
      { at: 20_000 + 120_010, done: true },
    ]);
    const p = probe().collect(r);
    await vi.advanceTimersByTimeAsync(20_000 + 120_020);
    await expect(p).resolves.toEqual(['event: message_start', 'event: ping', 'TEXT a']);
  });

  it('長い上限を超えたら、本文が来ていないことが分かる文言で切る', async () => {
    vi.useFakeTimers();
    const r = scriptedReader([{ at: STREAM_FIRST_CHUNK_TIMEOUT_MS + 60_000, text: 'TEXT late' }]);
    const p = probe().collect(r);
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(STREAM_FIRST_CHUNK_TIMEOUT_MS + 10);
    await expect(p).rejects.toThrow('before the first chunk');
  });
});

describe('本文が流れ始めたあと', () => {
  it('30 秒の無音で切る（途中で通信が切れた）', async () => {
    vi.useFakeTimers();
    const r = scriptedReader([
      { at: 10, text: 'TEXT a' },
      { at: 10 + STREAM_IDLE_TIMEOUT_MS + 5_000, text: 'TEXT b' },
    ]);
    const p = probe().collect(r);
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(10 + STREAM_IDLE_TIMEOUT_MS + 10);
    await expect(p).rejects.toThrow(`${STREAM_IDLE_TIMEOUT_MS / 1000} seconds.`);
  });

  it('30 秒以内に届き続ける限り読める', async () => {
    vi.useFakeTimers();
    const r = scriptedReader([
      { at: 10, text: 'TEXT a' },
      { at: 25_000, text: 'TEXT b' },
      { at: 50_000, text: 'TEXT c' },
      { at: 50_010, done: true },
    ]);
    const p = probe().collect(r);
    await vi.advanceTimersByTimeAsync(50_020);
    await expect(p).resolves.toEqual(['TEXT a', 'TEXT b', 'TEXT c']);
  });
});
