/**
 * src/core/cognitive/adapters/UsageLedger.test.ts
 *
 * 台帳（`system/logs/usage/`）に書かれる行の金型（T-0806）。
 *
 * 台帳はゲストが読む（`billing.html` ほか、利用者が書いたアプリ）。行の**既存の欄と値**は変えない —— 足すだけ。
 * ここでは 3 社の流れ（SSE）を偽物で流し、logger に渡った行を固定する。
 * 「既存の欄と値（金型）」の snapshot は、台帳を書く場所を Adapter から共通の入口へ移す前のコードで採った。
 *
 * 作りに触るのは `generate()` の 1 か所だけ（生成の入口が変わったらここを直す）。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AnthropicAdapter } from './AnthropicAdapter';
import { GeminiAdapter } from './GeminiAdapter';
import { OpenAIAdapter } from './OpenAIAdapter';
import type { BaseLLMAdapter, LlmCallOrigin, LlmResult } from './BaseAdapter';

interface Row {
  category: string;
  payload: any;
}

let rows: Row[] = [];
const logger: any = {
  log: async (category: string, payload: any) => {
    rows.push({ category, payload });
  },
};

/** SSE の本文を 1 塊で返す偽の応答 */
function sse(text: string): any {
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read: async () => {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: bytes };
          },
          cancel: async () => {},
          releaseLock() {},
        };
      },
    },
  };
}

const data = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const event = (name: string, o: unknown) => `event: ${name}\ndata: ${JSON.stringify(o)}\n\n`;

function respondWith(text: string): void {
  globalThis.fetch = vi.fn(async () => sse(text)) as any;
}

let lastResult: LlmResult | null = null;

/** 生成の入口（作りに触るのはここだけ） */
async function generate(adapter: BaseLLMAdapter, body: any, origin?: LlmCallOrigin): Promise<string> {
  let text = '';
  lastResult = await adapter.generateStream(
    body,
    (chunk) => {
      text += chunk;
    },
    undefined,
    origin,
  );
  return text;
}

/** 行のうち、この改修の前から在った欄だけ（社ごとに違う: Gemini の行に cacheWrite は無かった） */
const EXISTING_TOKEN_KEYS: Record<string, string[]> = {
  google: ['input', 'cached', 'output', 'total'],
  openai_compatible: ['input', 'cached', 'cacheWrite', 'output', 'total'],
  anthropic: ['input', 'cached', 'cacheWrite', 'output', 'total'],
};
function existingFields(row: Row): Row {
  const p = row.payload;
  const tokens: Record<string, unknown> = {};
  for (const k of EXISTING_TOKEN_KEYS[p.provider] || []) tokens[k] = p.tokens?.[k];
  return { category: row.category, payload: { provider: p.provider, model: p.model, tokens } };
}

const GEMINI_BODY = [{ role: 'user', parts: [{ text: 'hi' }] }];
const ANTHROPIC_BODY = { system: 'sys', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };
const OPENAI_BODY = [{ role: 'user', content: 'hi' }];

const gemini = () => new GeminiAdapter('KEY', 'gemini-test', {}, logger);
const anthropic = () => new AnthropicAdapter('KEY', 'claude-test', {}, logger);
const openai = () => new OpenAIAdapter('KEY', 'gpt-test', 'https://api.openai.com/v1', {}, logger);

const GEMINI_STREAM =
  data({ candidates: [{ content: { parts: [{ text: 'Hel' }] } }] }) +
  data({
    candidates: [{ content: { parts: [{ text: 'lo' }] }, finishReason: 'STOP' }],
    usageMetadata: {
      promptTokenCount: 1200,
      cachedContentTokenCount: 800,
      candidatesTokenCount: 50,
      totalTokenCount: 1300,
    },
  });

const ANTHROPIC_STREAM =
  event('message_start', {
    message: { usage: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 100 } },
  }) +
  event('content_block_delta', { delta: { type: 'text_delta', text: 'Hel' } }) +
  event('content_block_delta', { delta: { type: 'text_delta', text: 'lo' } }) +
  event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } }) +
  event('message_stop', {});

const OPENAI_STREAM =
  data({ choices: [{ delta: { content: 'Hel' } }] }) +
  data({ choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] }) +
  data({
    choices: [],
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 30,
      total_tokens: 1030,
      prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 100 },
    },
  }) +
  'data: [DONE]\n\n';

beforeEach(() => {
  rows = [];
  lastResult = null;
});

describe('台帳の行: 既存の欄と値（金型）', () => {
  it('Gemini', async () => {
    respondWith(GEMINI_STREAM);
    expect(await generate(gemini(), GEMINI_BODY)).toBe('Hello');
    expect(rows.map(existingFields)).toMatchSnapshot();
  });

  it('Gemini: totalTokenCount が無ければ prompt ＋ 出力', async () => {
    respondWith(
      data({
        candidates: [{ content: { parts: [{ text: 'x' }] } }],
        usageMetadata: { promptTokenCount: 70, candidatesTokenCount: 5 },
      }),
    );
    await generate(gemini(), GEMINI_BODY);
    expect(rows.map(existingFields)).toMatchSnapshot();
  });

  it('Anthropic', async () => {
    respondWith(ANTHROPIC_STREAM);
    expect(await generate(anthropic(), ANTHROPIC_BODY)).toBe('Hello');
    expect(rows.map(existingFields)).toMatchSnapshot();
  });

  it('OpenAI 形式', async () => {
    respondWith(OPENAI_STREAM);
    expect(await generate(openai(), OPENAI_BODY)).toBe('Hello');
    expect(rows.map(existingFields)).toMatchSnapshot();
  });

  it('OpenAI 形式: total_tokens が無ければ prompt ＋ 出力', async () => {
    respondWith(data({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 2 } }) + 'data: [DONE]\n\n');
    await generate(openai(), OPENAI_BODY);
    expect(rows.map(existingFields)).toMatchSnapshot();
  });
});

describe('台帳の行: 書かないとき', () => {
  it('Gemini: usageMetadata が来なければ書かない', async () => {
    respondWith(data({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }));
    await generate(gemini(), GEMINI_BODY);
    expect(rows).toEqual([]);
  });

  // 以前は 0 トークンの行を書いていた（T-0806 で変えた）。usage を受け取っていない生成を 0 として数えない
  it('Anthropic: usage が流れて来なければ書かない', async () => {
    respondWith(event('content_block_delta', { delta: { type: 'text_delta', text: 'x' } }) + event('message_stop', {}));
    await generate(anthropic(), ANTHROPIC_BODY);
    expect(rows).toEqual([]);
    expect(lastResult).toEqual({ provider: 'anthropic', model: 'claude-test', usage: null, stopReason: null });
  });

  it('Anthropic: message_start だけ届いた（出力の usage が無い）なら入力だけの行を書く', async () => {
    respondWith(
      event('message_start', { message: { usage: { input_tokens: 10, cache_read_input_tokens: 5 } } }) +
        event('content_block_delta', { delta: { type: 'text_delta', text: 'x' } }) +
        event('message_stop', {}),
    );
    await generate(anthropic(), ANTHROPIC_BODY);
    expect(rows.map((r) => r.payload.tokens)).toEqual([{ input: 10, cached: 5, cacheWrite: 0, output: 0, total: 15 }]);
  });

  it('OpenAI 形式: usage が来なければ書かない', async () => {
    respondWith(data({ choices: [{ delta: { content: 'x' } }] }) + 'data: [DONE]\n\n');
    await generate(openai(), OPENAI_BODY);
    expect(rows).toEqual([]);
  });

  it('Anthropic: 途中のエラーでは書かない（投げる）', async () => {
    respondWith(
      event('message_start', { message: { usage: { input_tokens: 10 } } }) +
        event('error', { error: { message: 'overloaded' } }),
    );
    await expect(generate(anthropic(), ANTHROPIC_BODY)).rejects.toThrow(/overloaded/);
    expect(rows).toEqual([]);
  });

  it('上流がエラーを返したら書かない（投げる）', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 429, text: async () => 'slow down' })) as any;
    await expect(generate(openai(), OPENAI_BODY)).rejects.toThrow(/429/);
    expect(rows).toEqual([]);
  });
});

describe('台帳の行: 足した欄', () => {
  const keysOf = (r: Row) => Object.keys(r.payload).sort();

  it('呼び手を渡さなければ、増えるのは stopReason と Gemini の cacheWrite: 0 だけ', async () => {
    respondWith(GEMINI_STREAM);
    await generate(gemini(), GEMINI_BODY);
    respondWith(ANTHROPIC_STREAM);
    await generate(anthropic(), ANTHROPIC_BODY);
    respondWith(OPENAI_STREAM);
    await generate(openai(), OPENAI_BODY);

    expect(rows.map((r) => r.category)).toEqual(['usage', 'usage', 'usage']);
    for (const r of rows) expect(keysOf(r)).toEqual(['model', 'provider', 'stopReason', 'tokens']);
    // 止まった理由は各社の値そのまま
    expect(rows.map((r) => r.payload.stopReason)).toEqual(['STOP', 'end_turn', 'stop']);
    // tokens の欄は 3 社とも同じ 5 つ
    for (const r of rows) {
      expect(Object.keys(r.payload.tokens)).toEqual(['input', 'cached', 'cacheWrite', 'output', 'total']);
    }
    expect(rows[0].payload.tokens.cacheWrite).toBe(0);
  });

  it('呼び手を渡すと caller と tag を書く', async () => {
    respondWith(ANTHROPIC_STREAM);
    await generate(anthropic(), ANTHROPIC_BODY, { caller: 'root', tag: 'session-1' });
    expect(keysOf(rows[0])).toEqual(['caller', 'model', 'provider', 'stopReason', 'tag', 'tokens']);
    expect(rows[0].payload.caller).toBe('root');
    expect(rows[0].payload.tag).toBe('session-1');
    // 既存の欄は呼び手を渡しても同じ
    expect(existingFields(rows[0]).payload.tokens).toEqual({
      input: 10,
      cached: 900,
      cacheWrite: 100,
      output: 42,
      total: 1052,
    });
  });

  it('tag が無ければ欄ごと書かない', async () => {
    respondWith(OPENAI_STREAM);
    await generate(openai(), OPENAI_BODY, { caller: 'my_app' });
    respondWith(OPENAI_STREAM);
    await generate(openai(), OPENAI_BODY, { caller: 'my_app', tag: null });
    respondWith(OPENAI_STREAM);
    await generate(openai(), OPENAI_BODY, { caller: 'my_app', tag: '' });
    for (const r of rows) {
      expect(r.payload.caller).toBe('my_app');
      expect('tag' in r.payload).toBe(false);
    }
  });

  it('止まった理由が拾えなければ null', async () => {
    respondWith(data({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 2 } }) + 'data: [DONE]\n\n');
    await generate(openai(), OPENAI_BODY);
    expect(rows[0].payload.stopReason).toBeNull();
  });

  it('OpenAI 形式: usage の塊が 2 回来ても 1 行（最後の値）', async () => {
    const usage = (n: number) =>
      data({ choices: [], usage: { prompt_tokens: 10, completion_tokens: n, total_tokens: 10 + n } });
    respondWith(usage(1) + usage(2) + 'data: [DONE]\n\n');
    await generate(openai(), OPENAI_BODY);
    expect(rows.map((r) => r.payload.tokens.output)).toEqual([2]);
  });
});

describe('生成の結果', () => {
  it('usage と止まった理由を返す（台帳の行と同じ値）', async () => {
    respondWith(GEMINI_STREAM);
    await generate(gemini(), GEMINI_BODY);
    expect(lastResult).toEqual({
      provider: 'google',
      model: 'gemini-test',
      usage: { input: 400, cached: 800, cacheWrite: 0, output: 50, total: 1300 },
      stopReason: 'STOP',
    });

    respondWith(ANTHROPIC_STREAM);
    await generate(anthropic(), ANTHROPIC_BODY);
    expect(lastResult).toEqual({
      provider: 'anthropic',
      model: 'claude-test',
      usage: { input: 10, cached: 900, cacheWrite: 100, output: 42, total: 1052 },
      stopReason: 'end_turn',
    });

    respondWith(OPENAI_STREAM);
    await generate(openai(), OPENAI_BODY);
    expect(lastResult).toEqual({
      provider: 'openai_compatible',
      model: 'gpt-test',
      usage: { input: 300, cached: 600, cacheWrite: 100, output: 30, total: 1030 },
      stopReason: 'stop',
    });
  });

  it('上流が usage を返さなければ usage は null（0 にしない）', async () => {
    respondWith(data({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'MAX_TOKENS' }] }));
    await generate(gemini(), GEMINI_BODY);
    expect(lastResult).toEqual({ provider: 'google', model: 'gemini-test', usage: null, stopReason: 'MAX_TOKENS' });
  });

  it('logger が無くても結果は返る', async () => {
    respondWith(OPENAI_STREAM);
    const r = await new OpenAIAdapter('KEY', 'gpt-test', 'https://api.openai.com/v1', {}, null).generateStream(
      OPENAI_BODY,
      () => {},
    );
    expect(r.usage?.total).toBe(1030);
    expect(rows).toEqual([]);
  });
});
