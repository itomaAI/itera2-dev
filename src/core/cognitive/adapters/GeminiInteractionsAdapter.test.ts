/**
 * src/core/cognitive/adapters/GeminiInteractionsAdapter.test.ts
 *
 * Interactions API のアダプタ（T-0853）。守りたいこと:
 *   1. generateContent の contents を steps に詰め替える（system は最初の user_input・空の文字は落とす・添付は uri）
 *   2. 本文として流すのは model_output の文字だけ。usage・止まった理由を従来の形に寄せる
 *   3. 鎖: 前回の会話＋応答に続く要求だけ、残りを previous_interaction_id 付きで送る。それ以外は全部を送る
 *   4. 覚えた id が無い（404）なら全部を送り直す。途中で途切れた・中断した生成は覚えない
 * 応答の形は 2026-11-14 の実測（data/01_projects/Itera/OS/LLM基盤/probes/result6.json・result7.json）に合わせた。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GeminiInteractionsAdapter,
  InteractionChains,
  interactionsStopReason,
  toInteractionsGenerationConfig,
  toInteractionsSteps,
} from './GeminiInteractionsAdapter';

type Call = { url: string; body: any };
let calls: Call[] = [];
let replies: Array<() => any> = [];

function sse(events: any[], opts: { done?: boolean } = {}): string {
  const lines = events.map((e) => `event: ${e.event_type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`);
  if (opts.done !== false) lines.push('data: [DONE]\r\n\r\n');
  return lines.join('');
}

function streamResponse(text: string, chunkSize = 37): any {
  const bytes = new TextEncoder().encode(text);
  let pos = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read: async () => {
            if (pos >= bytes.length) return { done: true, value: undefined };
            const value = bytes.slice(pos, pos + chunkSize);
            pos += chunkSize;
            return { done: false, value };
          },
          cancel: async () => {},
          releaseLock() {},
        };
      },
    },
  };
}

function errorResponse(status: number, message: string): any {
  return { ok: false, status, text: async () => JSON.stringify({ error: { message, code: 'x' } }), body: null };
}

/** 実測と同じ並び: created → status → thought（署名だけ）→ model_output（文字）→ completed */
function interaction(id: string, texts: string[], opts: { status?: string; usage?: any; thoughtText?: string } = {}) {
  const events: any[] = [
    { interaction: { id, object: 'interaction', model: 'm' }, event_type: 'interaction.created' },
    { interaction_id: id, status: 'in_progress', event_type: 'interaction.status_update' },
    { index: 0, step: { type: 'thought' }, event_type: 'step.start' },
    { index: 0, delta: { signature: 'SIG', type: 'thought_signature' }, event_type: 'step.delta' },
  ];
  if (opts.thoughtText) {
    events.push({
      index: 0,
      delta: { type: 'thought_summary', content: { type: 'text', text: opts.thoughtText } },
      event_type: 'step.delta',
    });
    // 思考の step の中に text の差分が来ても本文にしない
    events.push({ index: 0, delta: { type: 'text', text: opts.thoughtText }, event_type: 'step.delta' });
  }
  events.push({ index: 0, event_type: 'step.stop' });
  events.push({ index: 1, step: { type: 'model_output' }, event_type: 'step.start' });
  for (const t of texts) events.push({ index: 1, delta: { type: 'text', text: t }, event_type: 'step.delta' });
  events.push({ index: 1, event_type: 'step.stop' });
  events.push({
    interaction: {
      id,
      status: opts.status || 'completed',
      usage: opts.usage || {
        total_tokens: 120,
        total_input_tokens: 100,
        total_cached_tokens: 40,
        total_output_tokens: 15,
        total_thought_tokens: 5,
      },
    },
    event_type: 'interaction.completed',
  });
  return sse(events);
}

const KEY = 'TESTKEY';
const SYS = { role: 'user', parts: [{ text: 'SYSTEM PROMPT' }] };
const u = (t: string) => ({ role: 'user', parts: [{ text: t }] });
const m = (t: string) => ({ role: 'model', parts: [{ text: t }] });

async function run(adapter: GeminiInteractionsAdapter, contents: any[], reply: string | any, signal?: AbortSignal) {
  replies.push(() => (typeof reply === 'string' ? streamResponse(reply) : reply));
  let out = '';
  const result = await adapter.generateStream(contents, (c) => (out += c), signal);
  return { out, result };
}

beforeEach(() => {
  calls = [];
  replies = [];
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    const next = replies.shift();
    if (!next) throw new Error('no reply queued');
    return next();
  }) as any;
});

describe('詰め替え', () => {
  it('contents を steps にする（system は最初の user_input・空の文字は落とす・添付は uri）', () => {
    const steps = toInteractionsSteps([
      SYS,
      {
        role: 'user',
        parts: [{ text: 'hi' }, { fileData: { fileUri: 'https://x/files/a', mimeType: 'application/pdf' } }],
      },
      m(''),
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
          { fileData: { fileUri: 'https://x/files/v', mimeType: 'video/mp4' } },
        ],
      },
    ]);
    expect(steps).toEqual([
      { type: 'user_input', content: [{ type: 'text', text: 'SYSTEM PROMPT' }] },
      {
        type: 'user_input',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'document', uri: 'https://x/files/a', mime_type: 'application/pdf' },
        ],
      },
      { type: 'model_output', content: [] },
      {
        type: 'user_input',
        content: [
          { type: 'image', data: 'AAAA', mime_type: 'image/png' },
          { type: 'video', uri: 'https://x/files/v', mime_type: 'video/mp4' },
        ],
      },
    ]);
  });

  it('generation_config は snake_case。既定の上限 65536・thinking_level は小文字・temperature などは送らない', () => {
    expect(toInteractionsGenerationConfig({ temperature: 0.2, topP: 0.9 })).toEqual({
      generation_config: { max_output_tokens: 65536 },
    });
    expect(
      toInteractionsGenerationConfig({
        model: 'google/x',
        generationConfig: {
          maxOutputTokens: 1000,
          stopSequences: ['<yield />'],
          thinkingConfig: { thinkingLevel: 'HIGH', thinkingBudget: 100 },
        },
      }),
    ).toEqual({
      generation_config: { max_output_tokens: 1000, stop_sequences: ['<yield />'], thinking_level: 'high' },
    });
    expect(
      toInteractionsGenerationConfig({
        generationConfig: { responseMimeType: 'application/json', responseSchema: { type: 'object' } },
      }),
    ).toEqual({
      generation_config: { max_output_tokens: 65536 },
      response_format: { type: 'text', mime_type: 'application/json', schema: { type: 'object' } },
    });
  });

  it('止まった理由を従来の語に寄せる', () => {
    expect(interactionsStopReason('completed')).toBe('STOP');
    expect(interactionsStopReason('incomplete')).toBe('MAX_TOKENS');
    expect(interactionsStopReason('requires_action')).toBe('requires_action');
    expect(interactionsStopReason(null)).toBeNull();
  });
});

describe('送信と流れの読み取り', () => {
  it('はじめは全部を送る。本文は model_output の文字だけ。usage を従来の形に寄せる', async () => {
    const adapter = new GeminiInteractionsAdapter(
      KEY,
      'gemini-4-hydrogen',
      { thinkingConfig: { thinkingLevel: 'high' } },
      null,
      new InteractionChains(),
    );
    const { out, result } = await run(
      adapter,
      [SYS, u('hello')],
      interaction('int_1', ['<memo>a</memo>', '\n<yield />'], { thoughtText: 'secret thinking' }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions?key=TESTKEY');
    expect(calls[0].body).toEqual({
      model: 'gemini-4-hydrogen',
      generation_config: { max_output_tokens: 65536, thinking_level: 'high' },
      stream: true,
      input: [
        { type: 'user_input', content: [{ type: 'text', text: 'SYSTEM PROMPT' }] },
        { type: 'user_input', content: [{ type: 'text', text: 'hello' }] },
      ],
    });
    expect(out).toBe('<memo>a</memo>\n<yield />');
    expect(result).toEqual({
      provider: 'google',
      model: 'gemini-4-hydrogen',
      usage: { input: 60, cached: 40, cacheWrite: 0, output: 15, total: 120 },
      stopReason: 'STOP',
    });
  });

  it('出力の上限（incomplete）は MAX_TOKENS', async () => {
    const adapter = new GeminiInteractionsAdapter(KEY, 'g', {}, null, new InteractionChains());
    const { result } = await run(adapter, [SYS, u('count')], interaction('int_1', ['1 2 3'], { status: 'incomplete' }));
    expect(result.stopReason).toBe('MAX_TOKENS');
  });

  it('上流のエラーはそのまま投げる（鎖が無いとき 404 を送り直さない）', async () => {
    const adapter = new GeminiInteractionsAdapter(KEY, 'g', {}, null, new InteractionChains());
    await expect(
      run(adapter, [SYS, u('x')], errorResponse(400, 'Missing text in content of type text.')),
    ).rejects.toThrow('Gemini API Error (400): Missing text in content of type text.');
    expect(calls).toHaveLength(1);
  });

  it('文字が流れたあとの failed は普通に返し（止まった理由 failed）、鎖として覚えない。何も流れていなければ投げる', async () => {
    const chains = new InteractionChains();
    const adapter = new GeminiInteractionsAdapter(KEY, 'g', {}, null, chains);
    const { out, result } = await run(
      adapter,
      [SYS, u('one')],
      interaction('int_1', ['<memo>x</memo>\n<yield />\n'], {
        status: 'failed',
        usage: { total_tokens: 10, total_input_tokens: 10, total_cached_tokens: 0, total_output_tokens: 0 },
      }),
    );
    expect(out).toBe('<memo>x</memo>\n<yield />\n');
    expect(result.stopReason).toBe('failed');
    expect(chains.size).toBe(0);

    await expect(run(adapter, [SYS, u('one')], interaction('int_2', [], { status: 'failed' }))).rejects.toThrow(
      'Gemini API Error (interaction failed).',
    );
  });

  it('鍵が無ければ送らない', async () => {
    const adapter = new GeminiInteractionsAdapter('', 'g', {}, null, new InteractionChains());
    await expect(adapter.generateStream([SYS, u('x')], () => {})).rejects.toThrow('API Key is missing.');
    expect(calls).toHaveLength(0);
  });
});

describe('会話の鎖', () => {
  it('前回の会話＋応答に続く要求は、新しいターンだけを previous_interaction_id 付きで送る', async () => {
    const adapter = new GeminiInteractionsAdapter(KEY, 'g', {}, null, new InteractionChains());
    await run(adapter, [SYS, u('one')], interaction('int_1', ['r', '1']));
    await run(adapter, [SYS, u('one'), m('r1'), u('tool result'), u('<event/>')], interaction('int_2', ['r2']));
    await run(
      adapter,
      [SYS, u('one'), m('r1'), u('tool result'), u('<event/>'), m('r2'), u('three')],
      interaction('int_3', ['r3']),
    );

    expect(calls[1].body.previous_interaction_id).toBe('int_1');
    expect(calls[1].body.input).toEqual([
      { type: 'user_input', content: [{ type: 'text', text: 'tool result' }] },
      { type: 'user_input', content: [{ type: 'text', text: '<event/>' }] },
    ]);
    // 鎖でも generation_config は毎回送る（上流は引き継がない）
    expect(calls[1].body.generation_config).toEqual({ max_output_tokens: 65536 });
    expect(calls[2].body.previous_interaction_id).toBe('int_2');
    expect(calls[2].body.input).toEqual([{ type: 'user_input', content: [{ type: 'text', text: 'three' }] }]);
  });

  it('先頭が変わったら（圧縮・履歴の削除・応答の書き換え）全部を送る', async () => {
    const adapter = new GeminiInteractionsAdapter(KEY, 'g', {}, null, new InteractionChains());
    await run(adapter, [SYS, u('one')], interaction('int_1', ['r1']));
    // 履歴のモデルのターンが返した応答と違う
    await run(adapter, [SYS, u('one'), m('r1 (edited)'), u('two')], interaction('int_2', ['x']));
    // 古いターンが消えた
    await run(adapter, [SYS, u('two')], interaction('int_3', ['y']));

    expect(calls[1].body.previous_interaction_id).toBeUndefined();
    expect(calls[1].body.input).toHaveLength(4);
    expect(calls[2].body.previous_interaction_id).toBeUndefined();
    expect(calls[2].body.input).toHaveLength(2);
  });

  it('中断した生成のあと（履歴に途中のモデルのターンとエラーが入る）は、その前の鎖から続け、途中のターンも送る', async () => {
    const chains = new InteractionChains();
    const adapter = new GeminiInteractionsAdapter(KEY, 'g', {}, null, chains);
    await run(adapter, [SYS, u('one')], interaction('int_1', ['r1']));
    const ctrl = new AbortController();
    const broken = {
      ok: true,
      status: 200,
      body: {
        getReader() {
          let n = 0;
          return {
            read: async () => {
              n += 1;
              if (n === 1)
                return {
                  done: false,
                  value: new TextEncoder().encode(
                    sse(
                      [
                        { interaction: { id: 'int_x' }, event_type: 'interaction.created' },
                        { index: 0, step: { type: 'model_output' }, event_type: 'step.start' },
                        { index: 0, delta: { type: 'text', text: 'part' }, event_type: 'step.delta' },
                      ],
                      { done: false },
                    ),
                  ),
                };
              ctrl.abort();
              throw new DOMException('Aborted', 'AbortError');
            },
            cancel: async () => {},
            releaseLock() {},
          };
        },
      },
    };
    await expect(run(adapter, [SYS, u('one'), m('r1'), u('two')], broken, ctrl.signal)).rejects.toThrow();
    expect(chains.size).toBe(2 - 1); // int_1 の 1 本だけ（中断した int_x は覚えない）

    await run(
      adapter,
      [SYS, u('one'), m('r1'), u('two'), m('part'), u('<event type="system_error">Aborted</event>'), u('again')],
      interaction('int_3', ['ok']),
    );
    expect(calls[2].body.previous_interaction_id).toBe('int_1');
    expect(calls[2].body.input.map((s: any) => s.type)).toEqual([
      'user_input',
      'model_output',
      'user_input',
      'user_input',
    ]);
  });

  it('interaction.completed が来ずに流れが終わった生成は覚えない', async () => {
    const chains = new InteractionChains();
    const adapter = new GeminiInteractionsAdapter(KEY, 'g', {}, null, chains);
    const truncated = sse(
      [
        { interaction: { id: 'int_1' }, event_type: 'interaction.created' },
        { index: 0, step: { type: 'model_output' }, event_type: 'step.start' },
        { index: 0, delta: { type: 'text', text: 'half' }, event_type: 'step.delta' },
      ],
      { done: false },
    );
    const { out, result } = await run(adapter, [SYS, u('one')], truncated);
    expect(out).toBe('half');
    expect(result.usage).toBeNull();
    expect(chains.size).toBe(0);
  });

  it('覚えた id が上流に無い（404）なら、全部を送り直して新しい鎖にする', async () => {
    const chains = new InteractionChains();
    const adapter = new GeminiInteractionsAdapter(KEY, 'g', {}, null, chains);
    await run(adapter, [SYS, u('one')], interaction('int_1', ['r1']));
    replies.push(() => errorResponse(404, 'Requested entity was not found.'));
    const { out } = await run(adapter, [SYS, u('one'), m('r1'), u('two')], interaction('int_2', ['r2']));

    expect(out).toBe('r2');
    expect(calls).toHaveLength(3);
    expect(calls[1].body.previous_interaction_id).toBe('int_1');
    expect(calls[2].body.previous_interaction_id).toBeUndefined();
    expect(calls[2].body.input).toHaveLength(4);

    // 次は送り直した生成（int_2）から続く
    await run(adapter, [SYS, u('one'), m('r1'), u('two'), m('r2'), u('three')], interaction('int_3', ['r3']));
    expect(calls[3].body.previous_interaction_id).toBe('int_2');
  });

  it('枝分かれ（最後のやりとりを消して別のことを言う）は、一致するいちばん長い鎖から続ける', async () => {
    const adapter = new GeminiInteractionsAdapter(KEY, 'g', {}, null, new InteractionChains());
    await run(adapter, [SYS, u('one')], interaction('int_1', ['r1']));
    await run(adapter, [SYS, u('one'), m('r1'), u('two')], interaction('int_2', ['r2']));
    await run(adapter, [SYS, u('one'), m('r1'), u('two (rewritten)')], interaction('int_3', ['r3']));
    expect(calls[2].body.previous_interaction_id).toBe('int_1');
    expect(calls[2].body.input).toEqual([{ type: 'user_input', content: [{ type: 'text', text: 'two (rewritten)' }] }]);
  });

  it('モデルや鍵が違えば鎖を使わない', async () => {
    const chains = new InteractionChains();
    await run(
      new GeminiInteractionsAdapter(KEY, 'g1', {}, null, chains),
      [SYS, u('one')],
      interaction('int_1', ['r1']),
    );
    await run(
      new GeminiInteractionsAdapter(KEY, 'g2', {}, null, chains),
      [SYS, u('one'), m('r1'), u('two')],
      interaction('int_2', ['r2']),
    );
    await run(
      new GeminiInteractionsAdapter('OTHER', 'g1', {}, null, chains),
      [SYS, u('one'), m('r1'), u('two')],
      interaction('int_3', ['r3']),
    );
    // アダプタを作り直しても（設定の変更）同じ表を使えば続く
    await run(
      new GeminiInteractionsAdapter(KEY, 'g1', {}, null, chains),
      [SYS, u('one'), m('r1'), u('two')],
      interaction('int_4', ['r4']),
    );
    expect(calls[1].body.previous_interaction_id).toBeUndefined();
    expect(calls[2].body.previous_interaction_id).toBeUndefined();
    expect(calls[3].body.previous_interaction_id).toBe('int_1');
  });

  it('中身の無い応答も鎖として覚える（履歴には空のモデルのターン { text: "" } が入る）', async () => {
    const adapter = new GeminiInteractionsAdapter(KEY, 'g', {}, null, new InteractionChains());
    await run(adapter, [SYS, u('one')], interaction('int_1', []));
    await run(adapter, [SYS, u('one'), m(''), u('two')], interaction('int_2', ['r2']));
    expect(calls[1].body.previous_interaction_id).toBe('int_1');
    expect(calls[1].body.input).toEqual([{ type: 'user_input', content: [{ type: 'text', text: 'two' }] }]);
  });

  it('表は上限を超えたら古いものから捨てる', () => {
    const chains = new InteractionChains(2);
    chains.remember({ scope: 's', length: 1, digest: 'a', interactionId: '1' });
    chains.remember({ scope: 's', length: 1, digest: 'b', interactionId: '2' });
    chains.remember({ scope: 's', length: 1, digest: 'c', interactionId: '3' });
    expect(chains.size).toBe(2);
    expect(chains.find('s', ['a', 'x'])).toBeNull();
    expect(chains.find('s', ['c', 'x'])?.interactionId).toBe('3');
  });
});
