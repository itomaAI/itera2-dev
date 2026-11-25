/**
 * src/core/cognitive/adapters/BaseAdapter.abort.test.ts
 *
 * 読んでいる途中の中断（`monitorStream`）を固定する（T-0918）。
 *
 * Chromium では、中断の聞き手が呼ぶ `reader.cancel()` が fetch 自身の中断より先に流れを閉じ、
 * 待っていた `read()` が `{ done: true }` で返る（Node の fetch は逆で、read が AbortError で落ちる）。
 * これを普通の終わりとして読んでいたため、止めた生成が例外なしに終わり、Engine は止まった知らせを出せなかった。
 *
 * 守りたいこと:
 *   1. read が待っている間に中断されたら、cancel が read を done で返しても AbortError を投げる
 *   2. read が塊を返したのと同時に中断されていたら、その塊は渡さずに AbortError を投げる
 *   3. 中断しなければ、done は普通の終わり（いままでどおり）
 *   4. 1 か所の直しが 4 つのアダプタと中継に効く（本文が signal に繋がっていない流れ ＝ Chromium と同じ振る舞い）。
 *      中断した生成は台帳に書かれない（投げたときは結果が無い。T-0806）
 * 無音の見張りは BaseAdapter.idle.test.ts（変えていない）。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import { BaseLLMAdapter, type LlmResult, type RelayTransport } from './BaseAdapter';
import { AnthropicAdapter } from './AnthropicAdapter';
import { OpenAIAdapter } from './OpenAIAdapter';
import { GeminiAdapter } from './GeminiAdapter';
import { GeminiInteractionsAdapter, InteractionChains } from './GeminiInteractionsAdapter';

class Probe extends BaseLLMAdapter {
  protected async stream(): Promise<LlmResult> {
    return { provider: 'probe', model: 'probe', usage: null, stopReason: null };
  }
  async collect(reader: any, signal?: AbortSignal, onValue?: (s: string) => void): Promise<string[]> {
    const out: string[] = [];
    for await (const chunk of this.monitorStream(reader, signal)) {
      const s = new TextDecoder().decode(chunk);
      out.push(s);
      onValue?.(s);
    }
    return out;
  }
}

/**
 * Chromium の振る舞いを写した reader の代役: read は手で返すまで待つ。cancel は待っている read を `{ done: true }` で解決する
 * （fetch 自身の中断は来ない ＝ read は AbortError で落ちない）。
 */
function chromiumLikeReader() {
  let pending: ((v: { done: boolean; value?: Uint8Array }) => void) | null = null;
  let cancelled = false;
  const reader = {
    read: () =>
      new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
        if (cancelled) return resolve({ done: true });
        pending = resolve;
      }),
    cancel: vi.fn(async () => {
      cancelled = true;
      const p = pending;
      pending = null;
      if (p) p({ done: true });
    }),
    releaseLock() {},
  };
  return {
    reader: reader as any,
    cancel: reader.cancel,
    /** 待っている read に塊を返す */
    push(text: string) {
      const p = pending;
      pending = null;
      p?.({ done: false, value: new TextEncoder().encode(text) });
    },
    end() {
      const p = pending;
      pending = null;
      p?.({ done: true });
    },
    waiting: () => pending !== null,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('monitorStream: 読んでいる途中の中断（Chromium の振る舞い）', () => {
  it('read が待っている間に中断すると、cancel が read を done で返しても AbortError を投げる（本命）', async () => {
    const r = chromiumLikeReader();
    const ac = new AbortController();
    const p = new Probe({}, null, null).collect(r.reader, ac.signal);
    await tick();
    r.push('a');
    await tick();
    expect(r.waiting()).toBe(true);

    ac.abort();
    expect(r.cancel).toHaveBeenCalledTimes(1); // 網は切る（cancel は残す）
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('read が塊を返したのと同時に中断されていたら、その塊は渡さずに AbortError を投げる', async () => {
    const r = chromiumLikeReader();
    const ac = new AbortController();
    const seen: string[] = [];
    const p = new Probe({}, null, null).collect(r.reader, ac.signal, (s) => seen.push(s));
    await tick();
    r.push('a');
    await tick();
    // 塊を返す → 受け手が読む前に中断（同じ同期の中）
    r.push('b');
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen).toEqual(['a']);
  });

  it('塊を受けた聞き手の中で中断しても（次の read の前）、AbortError を投げる', async () => {
    const r = chromiumLikeReader();
    const ac = new AbortController();
    const p = new Probe({}, null, null).collect(r.reader, ac.signal, () => ac.abort());
    await tick();
    r.push('a');
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('（対比）中断しなければ、done は普通の終わり', async () => {
    const r = chromiumLikeReader();
    const ac = new AbortController();
    const p = new Probe({}, null, null).collect(r.reader, ac.signal);
    await tick();
    r.push('a');
    await tick();
    r.end();
    await expect(p).resolves.toEqual(['a']);
    expect(r.cancel).not.toHaveBeenCalled();
  });

  it('（対比）signal を渡さない読み手は、いままでどおり done で終わる', async () => {
    const r = chromiumLikeReader();
    const p = new Probe({}, null, null).collect(r.reader);
    await tick();
    r.push('a');
    await tick();
    r.end();
    await expect(p).resolves.toEqual(['a']);
  });
});

// ---------------------------------------------------------------- 4 つのアダプタと中継

const GAP = 15;
const TEXT = ['<memo>hello', ' world</memo>\n', '<write path="out.txt">', 'probe', '</write>\n', '<yield />'];

type Kind = 'anthropic' | 'openai' | 'gemini' | 'gemini_interactions';

/** 各社の SSE（流れの頭・本文・終わり）。形は実物の上流と同じ */
function sse(kind: Kind) {
  const ev = (name: string, data: any) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  const d = (data: any) => `data: ${JSON.stringify(data)}\n\n`;
  const pre: string[] = [];
  const text: string[] = [];
  const post: string[] = [];
  switch (kind) {
    case 'anthropic':
      pre.push(ev('message_start', { type: 'message_start', message: { usage: { input_tokens: 5 } } }));
      pre.push(
        ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      );
      for (const c of TEXT)
        text.push(
          ev('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: c },
          }),
        );
      post.push(ev('content_block_stop', { type: 'content_block_stop', index: 0 }));
      post.push(
        ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }),
      );
      post.push(ev('message_stop', { type: 'message_stop' }));
      break;
    case 'openai':
      for (const c of TEXT) text.push(d({ choices: [{ index: 0, delta: { content: c } }] }));
      post.push(d({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
      post.push(d({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } }));
      post.push('data: [DONE]\n\n');
      break;
    case 'gemini':
      for (const c of TEXT) text.push(d({ candidates: [{ content: { role: 'model', parts: [{ text: c }] } }] }));
      post.push(
        d({
          candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7, totalTokenCount: 12 },
        }),
      );
      break;
    case 'gemini_interactions':
      pre.push(
        ev('interaction.created', {
          interaction: { id: 'i1', object: 'interaction', model: 'm' },
          event_type: 'interaction.created',
        }),
      );
      pre.push(
        ev('interaction.status_update', {
          interaction_id: 'i1',
          status: 'in_progress',
          event_type: 'interaction.status_update',
        }),
      );
      pre.push(ev('step.start', { index: 0, step: { type: 'model_output' }, event_type: 'step.start' }));
      for (const c of TEXT)
        text.push(ev('step.delta', { index: 0, delta: { type: 'text', text: c }, event_type: 'step.delta' }));
      post.push(ev('step.stop', { index: 0, event_type: 'step.stop' }));
      post.push(
        ev('interaction.completed', {
          interaction: {
            id: 'i1',
            status: 'completed',
            usage: { total_input_tokens: 5, total_output_tokens: 7, total_tokens: 12 },
          },
          event_type: 'interaction.completed',
        }),
      );
      post.push('data: [DONE]\n\n');
      break;
  }
  return { pre, text, post };
}

/**
 * 本文が signal に繋がっていない応答（fetch は中断を本文に伝えない ＝ Chromium で cancel が先に流れを閉じるのと同じ）。
 * 止められるのは monitorStream の cancel だけ。cancel されると待っている read は done で返る（Streams の仕様どおり）。
 * holdAfter を渡すと、本文をその数だけ流したあとは cancel されるまで何も流さない（止める試験を時間に依らせない）。
 */
function detachedResponse(kind: Kind, holdAfter?: number): Response {
  const { pre, text, post } = sse(kind);
  const shown = holdAfter === undefined ? text : text.slice(0, holdAfter);
  const enc = new TextEncoder();
  const timers: ReturnType<typeof setTimeout>[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      pre.forEach((s) => controller.enqueue(enc.encode(s)));
      shown.forEach((s, i) =>
        timers.push(
          setTimeout(
            () => {
              try {
                controller.enqueue(enc.encode(s));
              } catch {
                /* 閉じたあと */
              }
            },
            (i + 1) * GAP,
          ),
        ),
      );
      timers.push(
        setTimeout(
          () => {
            if (holdAfter !== undefined) return;
            try {
              post.forEach((s) => controller.enqueue(enc.encode(s)));
              controller.close();
            } catch {
              /* 閉じたあと */
            }
          },
          (text.length + 1) * GAP,
        ),
      );
    },
    cancel() {
      timers.forEach(clearTimeout);
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const relay: RelayTransport = {
  baseUrl: 'https://relay.invalid/llmProxy',
  getAuthHeaders: async () => ({ Authorization: 'Bearer T' }),
  strictOpenAISchema: true,
};

function adapterFor(kind: Kind, logger: any, viaRelay: boolean): BaseLLMAdapter {
  const r = viaRelay ? relay : null;
  switch (kind) {
    case 'anthropic':
      return new AnthropicAdapter('k', 'claude-x', {}, logger, r);
    case 'openai':
      return new OpenAIAdapter('k', 'custom-x', 'http://upstream.invalid/v1', {}, logger, r);
    case 'gemini':
      return new GeminiAdapter('k', 'gemini-x', {}, logger, r);
    case 'gemini_interactions':
      return new GeminiInteractionsAdapter('k', 'gemini-x', {}, logger, new InteractionChains());
  }
}

function messagesFor(kind: Kind): any {
  if (kind === 'anthropic') return { system: 'sys', messages: [{ role: 'user', content: 'go' }] };
  if (kind === 'openai') return [{ role: 'user', content: 'go' }];
  return [{ role: 'user', parts: [{ text: 'go' }] }];
}

const CASES: Array<[Kind, boolean]> = [
  ['anthropic', false],
  ['openai', false],
  ['gemini', false],
  ['gemini_interactions', false],
  ['anthropic', true],
  ['openai', true],
  ['gemini', true],
];

describe('generateStream: 読んでいる途中の中断は、どのアダプタでも AbortError（Chromium と同じ流れ）', () => {
  for (const [kind, viaRelay] of CASES) {
    const name = `${kind}${viaRelay ? '（中継）' : ''}`;

    it(`${name}: 3 つ目の塊のあと、read を待っている間に止めると AbortError。台帳は書かない`, async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => detachedResponse(kind, 3)),
      );
      const logger = { log: vi.fn(async () => {}) };
      const ac = new AbortController();
      const chunks: string[] = [];
      const p = adapterFor(kind, logger, viaRelay).generateStream(
        messagesFor(kind),
        (c) => {
          chunks.push(c);
          // 実物（ゲストからの停止・停止ボタン）と同じく、聞き手の外から少し遅れて止める（read は待っている）
          if (chunks.join('').includes('<write path="out.txt">')) setTimeout(() => ac.abort(), 0);
        },
        ac.signal,
      );
      await expect(p).rejects.toMatchObject({ name: 'AbortError' });
      expect(chunks.join('')).not.toContain('probe');
      expect(logger.log).not.toHaveBeenCalled();
    });

    it(`${name}:（対比）止めなければ最後まで読み、台帳に 1 行書く`, async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => detachedResponse(kind)),
      );
      const logger = { log: vi.fn(async () => {}) };
      const chunks: string[] = [];
      const result = await adapterFor(kind, logger, viaRelay).generateStream(
        messagesFor(kind),
        (c) => chunks.push(c),
        new AbortController().signal,
      );
      expect(chunks.join('')).toBe(TEXT.join(''));
      expect(result.usage).not.toBeNull();
      expect(logger.log).toHaveBeenCalledTimes(1);
    });
  }
});
