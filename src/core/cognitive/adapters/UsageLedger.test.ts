/**
 * src/core/cognitive/adapters/UsageLedger.test.ts
 *
 * 台帳（`system/logs/usage/`）に書かれる行の金型（T-0806）。
 *
 * 台帳はゲストが読む（`billing.html` ほか、利用者が書いたアプリ）。行の**既存の欄と値**は変えない —— 足すだけ。
 * ここでは 3 社の流れ（SSE）を偽物で流し、logger に渡った行を固定する。
 *
 * 作りに触るのは `generate()` の 1 か所だけ（生成の入口が変わったらここを直す）。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AnthropicAdapter } from './AnthropicAdapter';
import { GeminiAdapter } from './GeminiAdapter';
import { OpenAIAdapter } from './OpenAIAdapter';
import type { BaseLLMAdapter } from './BaseAdapter';

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

/** 生成の入口（作りに触るのはここだけ） */
async function generate(adapter: BaseLLMAdapter, body: any): Promise<string> {
  let text = '';
  await adapter.generateStream(body, (chunk) => {
    text += chunk;
  });
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

  it('Anthropic: usage が流れて来なくても 0 の行を書く', async () => {
    respondWith(event('content_block_delta', { delta: { type: 'text_delta', text: 'x' } }) + event('message_stop', {}));
    await generate(anthropic(), ANTHROPIC_BODY);
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

describe('台帳の行: いまの形そのもの（改修で足す欄はここに現れる）', () => {
  it('行にあるのは provider・model・tokens だけ', async () => {
    respondWith(GEMINI_STREAM);
    await generate(gemini(), GEMINI_BODY);
    respondWith(ANTHROPIC_STREAM);
    await generate(anthropic(), ANTHROPIC_BODY);
    respondWith(OPENAI_STREAM);
    await generate(openai(), OPENAI_BODY);
    expect(rows).toEqual(rows.map(existingFields));
    expect(rows.map((r) => r.category)).toEqual(['usage', 'usage', 'usage']);
  });

  it('OpenAI 形式: usage の塊が 2 回来ると 2 行書く', async () => {
    const usage = (n: number) =>
      data({ choices: [], usage: { prompt_tokens: 10, completion_tokens: n, total_tokens: 10 + n } });
    respondWith(usage(1) + usage(2) + 'data: [DONE]\n\n');
    await generate(openai(), OPENAI_BODY);
    expect(rows.map((r) => r.payload.tokens.output)).toEqual([1, 2]);
  });
});
