/**
 * src/core/cognitive/adapters/AnthropicStream.test.ts
 *
 * Anthropic のストリームを読むときの振る舞いを固定する。
 *
 * 守りたいこと:
 *   1. 途中で流れてくる `event: error` を黙って捨てないこと。
 *      捨てると、本文が1文字も来ないまま「正常に終わった」ように見える
 *   2. それでも壊れた行（JSON にならない断片）では止まらないこと。
 *      1 の実装で try を広く取ると、自分の catch が自分の throw を握り潰す
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AnthropicAdapter } from './AnthropicAdapter';

/** SSE のテキストをそのまま返す応答の代役。 */
function sse(text: string): any {
  const chunks = [new TextEncoder().encode(text)];
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read: async () =>
            i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined },
          cancel: async () => {},
          releaseLock() {},
        };
      },
    },
  };
}

const noop = () => {};

function adapter() {
  return new AnthropicAdapter('sk-ant-test', 'claude-sonnet-5', {}, null);
}

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => sse(CURRENT)) as any;
});

let CURRENT = '';

describe('ストリーム中のエラー', () => {
  /**
   * 事前条件: 本文が来る前に `event: error` が流れる（overloaded_error など）。
   * 事後条件: 例外になること。黙って終わらないこと。
   */
  it('event: error を例外にすること', async () => {
    CURRENT =
      'event: error\n' + 'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n';

    await expect(adapter().generateStream({ system: 's', messages: [] }, noop)).rejects.toThrow('Overloaded');
  });

  /**
   * 事前条件: 正常な本文。
   * 事後条件: 受け取れること（1 の修正で正常系を壊していないことの対照）。
   */
  it('正常な本文はそのまま受け取れること', async () => {
    CURRENT =
      'event: content_block_delta\n' +
      'data: {"delta":{"type":"text_delta","text":"こんにちは"}}\n\n' +
      'event: message_stop\n' +
      'data: {}\n\n';

    const got: string[] = [];
    await adapter().generateStream({ system: 's', messages: [] }, (t) => got.push(t));
    expect(got.join('')).toBe('こんにちは');
  });

  /**
   * 事前条件: JSON にならない行が混ざる。
   * 事後条件: そこで止まらず、後続の本文を受け取れること。
   */
  it('壊れた行では止まらないこと', async () => {
    CURRENT =
      'event: content_block_delta\n' +
      'data: {壊れている\n\n' +
      'event: content_block_delta\n' +
      'data: {"delta":{"type":"text_delta","text":"続き"}}\n\n';

    const got: string[] = [];
    await adapter().generateStream({ system: 's', messages: [] }, (t) => got.push(t));
    expect(got.join('')).toBe('続き');
  });
});
