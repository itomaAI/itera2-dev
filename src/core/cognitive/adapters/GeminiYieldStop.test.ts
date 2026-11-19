/**
 * src/core/cognitive/adapters/GeminiYieldStop.test.ts
 *
 * 応急の手当て（T-0877）: OS のチャットで、Gemini に行頭の yield タグを停止文字列として渡し、止まったあとにタグを戻す。
 *
 * 守りたいこと:
 *   1. 停止文字列を送るのは OS のチャット（caller が root）だけ。ゲストの `MetaOS.llm.generate` と、呼び手の無い生成には送らない
 *   2. 設定の `stopSequences` は残す（足すだけ）。上限（5 本）まで埋まっていたら足さない
 *   3. タグを戻すのは、止まった理由が STOP で、出力に最上位の終端タグが無いときだけ
 *      （Gemini は停止文字列で止まったのか自然に終わったのかを返さない）
 *   4. 戻したあとの出力を Engine と同じ読み方（Translator）で読むと、終端は yield で、後ろに何も残らない
 *   5. 結果（usage・止まった理由）は変えない
 */

import { describe, it, expect, vi } from 'vitest';
import { GeminiAdapter, GEMINI_YIELD_RESTORED, GEMINI_YIELD_STOP } from './GeminiAdapter';
import {
  LLM_CALLER_ROOT,
  type LlmCallOrigin,
  type LlmConfig,
  type LlmResult,
  type RelayTransport,
} from './BaseAdapter';
import { Translator } from '../Translator';

const ROOT: LlmCallOrigin = { caller: LLM_CALLER_ROOT, tag: 'session-1' };
const GUEST: LlmCallOrigin = { caller: 'app_notes', tag: null };
const BODY = [{ role: 'user', parts: [{ text: 'hi' }] }];
const YIELD_TAG = '<yield />';

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

/** 文字の塊と止まった理由から Gemini の流れを作る（最後の塊に finishReason と usage が付く） */
function streamOf(chunks: string[], finishReason: string | null): string {
  const usageMetadata = {
    promptTokenCount: 100,
    cachedContentTokenCount: 0,
    candidatesTokenCount: 20,
    totalTokenCount: 120,
  };
  if (chunks.length === 0) {
    return data({ candidates: [{ content: { parts: [] }, ...(finishReason ? { finishReason } : {}) }], usageMetadata });
  }
  return chunks
    .map((text, i) =>
      i < chunks.length - 1
        ? data({ candidates: [{ content: { parts: [{ text }] } }] })
        : data({
            candidates: [{ content: { parts: [{ text }] }, ...(finishReason ? { finishReason } : {}) }],
            usageMetadata,
          }),
    )
    .join('');
}

let sent: { url: string; body: any }[] = [];

function respond(chunks: string[], finishReason: string | null = 'STOP'): void {
  sent = [];
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return sse(streamOf(chunks, finishReason));
  }) as any;
}

async function run(
  adapter: GeminiAdapter,
  origin?: LlmCallOrigin,
): Promise<{ text: string; chunks: string[]; result: LlmResult }> {
  let text = '';
  const chunks: string[] = [];
  const result = await adapter.generateStream(
    BODY,
    (chunk) => {
      text += chunk;
      chunks.push(chunk);
    },
    undefined,
    origin,
  );
  return { text, chunks, result };
}

const direct = (config: LlmConfig = {}) => new GeminiAdapter('KEY', 'gemini-test', config, null);
const relay: RelayTransport = {
  baseUrl: 'https://relay.example/llmProxy',
  getAuthHeaders: async () => ({ Authorization: 'Bearer TOKEN' }),
};
const relayed = (config: LlmConfig = {}) => new GeminiAdapter('', 'standard', config, null, relay);

const stopsSent = () => sent[0].body.generationConfig.stopSequences;

describe('停止文字列を送るのは OS のチャットだけ', () => {
  it('停止文字列は行頭の yield タグの書き出しで、戻す文字はその完全な形', () => {
    expect(GEMINI_YIELD_STOP).toBe('\n<yield');
    expect(GEMINI_YIELD_RESTORED).toBe('\n' + YIELD_TAG);
    expect(GEMINI_YIELD_RESTORED.startsWith(GEMINI_YIELD_STOP)).toBe(true);
  });

  it('root の生成には付く（自分の鍵・中継とも）', async () => {
    respond(['<memo>m</memo>']);
    await run(direct(), ROOT);
    expect(stopsSent()).toEqual([GEMINI_YIELD_STOP]);

    respond(['<memo>m</memo>']);
    await run(relayed(), ROOT);
    expect(sent[0].url).toContain('https://relay.example/llmProxy/v1beta/models/standard:streamGenerateContent');
    expect(stopsSent()).toEqual([GEMINI_YIELD_STOP]);
  });

  it('ゲストの生成・呼び手の無い生成には付かない', async () => {
    respond(['{"a":1}']);
    await run(direct(), GUEST);
    expect(stopsSent()).toBeUndefined();

    respond(['{"a":1}']);
    await run(direct());
    expect(stopsSent()).toBeUndefined();

    respond(['{"a":1}']);
    await run(relayed(), GUEST);
    expect(stopsSent()).toBeUndefined();
  });

  it('設定の stopSequences は残して足す。ゲストには設定のものだけが渡る', async () => {
    respond(['x']);
    await run(direct({ stopSequences: ['END'] }), ROOT);
    expect(stopsSent()).toEqual(['END', GEMINI_YIELD_STOP]);

    respond(['x']);
    await run(direct({ generationConfig: { stopSequences: ['A', 'B'] } }), ROOT);
    expect(stopsSent()).toEqual(['A', 'B', GEMINI_YIELD_STOP]);

    respond(['x']);
    await run(direct({ stopSequences: ['END'] }), GUEST);
    expect(stopsSent()).toEqual(['END']);
  });

  it('設定に同じ文字列が在れば重ねない', async () => {
    respond(['x']);
    await run(direct({ stopSequences: [GEMINI_YIELD_STOP, 'END'] }), ROOT);
    expect(stopsSent()).toEqual([GEMINI_YIELD_STOP, 'END']);
  });

  it('設定が上限の 5 本まで埋まっていたら足さず、タグも戻さない', async () => {
    const five = ['A', 'B', 'C', 'D', 'E'];
    respond(['<memo>m</memo>\n<read path="a.md" />']);
    const { text } = await run(direct({ stopSequences: five }), ROOT);
    expect(stopsSent()).toEqual(five);
    expect(text).toBe('<memo>m</memo>\n<read path="a.md" />');
  });
});

describe('止まったあとにタグを戻す', () => {
  const translator = new Translator();
  const CUT = ['<memo>read it</memo>\n', '<read path="a.md" />'];

  it('root・STOP・終端タグなし → 最後の塊としてタグが流れ、Engine の読み方で終端は yield になる', async () => {
    respond(CUT);
    const { text, chunks, result } = await run(direct(), ROOT);
    expect(chunks).toEqual([...CUT, GEMINI_YIELD_RESTORED]);
    expect(text).toBe('<memo>read it</memo>\n<read path="a.md" />\n' + YIELD_TAG);

    const actions = translator.parse(text);
    expect(actions.terminalTag).toBe('yield');
    expect(actions.trailingText).toBe('');
    expect(actions.map((a) => a.type)).toEqual(['memo', 'read', 'yield']);

    // 結果は変えない
    expect(result.stopReason).toBe('STOP');
    expect(result.usage).toEqual({ input: 100, cached: 0, cacheWrite: 0, output: 20, total: 120 });
  });

  it('中継の経路でも同じ', async () => {
    respond(CUT);
    const { text } = await run(relayed(), ROOT);
    expect(text.endsWith(GEMINI_YIELD_RESTORED)).toBe(true);
  });

  it('停止文字列の頭の改行が出力に残っていたら、改行を重ねずにタグだけを流す', async () => {
    // Hydrogen の実測（T-0877 の probe23）: 15 回のうち 9 回、返った文字は改行で終わっていた
    respond(['<memo>read it</memo>\n', '<read path="a.md" />\n']);
    const { text, chunks } = await run(direct(), ROOT);
    expect(chunks[chunks.length - 1]).toBe(YIELD_TAG);
    expect(text).toBe('<memo>read it</memo>\n<read path="a.md" />\n' + YIELD_TAG);
    expect(translator.parse(text).terminalTag).toBe('yield');
  });

  it.each([
    ['finish', '<report>done</report>\n<finish />'],
    ['breathe', '<memo>next</memo>\n<breathe />'],
    ['ask', '<ask>which one?</ask>'],
    ['同じ行に書かれた yield', '<read path="a.md" />' + YIELD_TAG],
    ['終端のあとに改行だけ', '<report>done</report>\n<finish />\n'],
    ['ask のあとに書き越してから切れた', '<ask>which one?</ask>\n<memo>and then</memo>'],
  ])('終端タグの在る出力には足さない（%s）', async (_label, output) => {
    respond([output]);
    const { text } = await run(direct(), ROOT);
    expect(text).toBe(output);
    // 足していれば、終端の後ろに文字が残って Engine が書き越しの警告を出す
    expect(translator.parse(text).trailingText.trim()).toBe(output.includes('and then') ? '<memo>and then</memo>' : '');
  });

  it('道具の中身に書かれた終端タグは終端に数えない（最上位に無ければ足す）', async () => {
    respond(['<memo>call <finish /> when everything is done</memo>\n<read path="a.md" />']);
    const { text } = await run(direct(), ROOT);
    expect(text.endsWith(GEMINI_YIELD_RESTORED)).toBe(true);
    expect(translator.parse(text).terminalTag).toBe('yield');
  });

  it.each([['MAX_TOKENS'], ['MALFORMED_FUNCTION_CALL'], ['SAFETY'], [null]])(
    'STOP 以外で止まったら足さない（%s）',
    async (finishReason) => {
      respond(CUT, finishReason);
      const { text, result } = await run(direct(), ROOT);
      expect(text).toBe(CUT.join(''));
      expect(result.stopReason).toBe(finishReason);
    },
  );

  it('ゲストの生成・呼び手の無い生成には足さない', async () => {
    respond(CUT);
    expect((await run(direct(), GUEST)).text).toBe(CUT.join(''));
    respond(CUT);
    expect((await run(direct())).text).toBe(CUT.join(''));
  });

  it('何も書かずに STOP で終わった（出力の先頭が停止文字列だった）ときも同じ規則で足す', async () => {
    respond([]);
    const { text } = await run(direct(), ROOT);
    expect(text).toBe(GEMINI_YIELD_RESTORED);
    expect(translator.parse(text).terminalTag).toBe('yield');
  });
});

describe('分かっていて残している制約（特別な扱いをしない）', () => {
  it('道具の中身の行頭で切れたときも同じ規則で足す。切れた道具は閉じていない要素として読まれ、実行されない（T-0878）', async () => {
    // モデルは write の中身に yield タグで始まる行を書こうとし、API がその直前で止めた
    const cut = '<write path="doc.md">\n# Turn\nEnd each turn with:';
    respond([cut]);
    const { text } = await run(direct(), ROOT);
    expect(text).toBe(cut + GEMINI_YIELD_RESTORED);

    const actions = new Translator().parse(text);
    expect(actions.terminalTag).toBeNull();
    expect(actions.map((a) => [a.type, a.closed])).toEqual([['write', false]]);
  });
});
