/**
 * src/core/cognitive/adapters/GeminiAdapter.ts
 * Itera OS v2: Google Gemini API Adapter
 */

import {
  BaseLLMAdapter,
  filterNestedObject,
  LLM_CALLER_ROOT,
  type LlmCallOrigin,
  type LlmConfig,
  type LlmResult,
  type RelayTransport,
} from './BaseAdapter';
import { Translator } from '../Translator';
import type { SystemLogger } from '../../state/SystemLogger';

/**
 * 応急の手当て（T-0877・2026-11-19）—— OS のチャットで、行頭の `<yield` を API の停止文字列にする。
 *
 * Gemini 4 Hydrogen は、終端タグ `<yield />` を書いたあとも思考を挟んで書き続ける（T-0851）。プロンプトでは止まらない
 * （T-0854・T-0858）。そこで Gemini に限り、API が用意している仕組み（`stopSequences`）で生成を終わらせる。
 *
 *   - 掛けるのは OS のチャット（`origin.caller` が `root`）だけ。`MetaOS.llm.generate` の出力は LPML ではない。
 *   - Gemini は停止文字列を出力に含めない。止まったあとに `\n<yield />` を流して、モデルが書いた形に戻す
 *     （履歴のモデルのターンが終端タグを欠かないようにするため。実行には要らない）。
 *     ただし頭の改行だけは出力に残ることがある（Hydrogen の実測で 15 回中 9 回）。そのときは改行を重ねない。
 *   - Gemini は、停止文字列で止まったのか自然に終わったのかを返さない（どちらも `STOP`）。戻すのは、
 *     `STOP` で、かつ出力に最上位の終端タグが無いときだけ（`</ask>` や `<finish />` で終わったターンには足さない）。
 *     終端タグの有無は Translator に訊く（終端タグの定義をここに写さない）。
 *
 * 🔴 分かっていて残している危険: API の停止文字列は場所を見ない。`<write>` などの中身に `<yield` で始まる行があると
 *    そこで切れ、切れた道具がそのまま実行される（T-0859 の実測）。行頭に限ってあるので、文中での言及では切れない。
 *
 * 外す条件: 終端タグでの打ち切りを全アダプタ共通の受け口に置いたとき（T-0859 の B 案）、または Hydrogen が直ったとき。
 * Interactions の経路（GeminiInteractionsAdapter）には掛けていない。
 */
export const GEMINI_YIELD_STOP = '\n<yield';
const GEMINI_YIELD_TAG = '<yield />';
/** 停止文字列で削られた分として流す文字（出力が改行で終わっているときは、タグだけを流す） */
export const GEMINI_YIELD_RESTORED = '\n' + GEMINI_YIELD_TAG;
/** Gemini が受け付ける停止文字列の本数（6 本で 400。T-0859 の実測） */
const GEMINI_MAX_STOP_SEQUENCES = 5;

const terminalReader = new Translator();

export class GeminiAdapter extends BaseLLMAdapter {
  private apiKey: string;
  private modelName: string;
  private baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models';

  constructor(
    apiKey: string,
    modelName: string = 'gemini-3.8-flash',
    config: LlmConfig = {},
    logger: SystemLogger | null = null,
    relay: RelayTransport | null = null,
  ) {
    super(config, logger, relay);
    this.apiKey = apiKey;
    this.modelName = modelName;
  }

  protected async stream(
    messages: any,
    onChunk: (text: string) => void,
    signal?: AbortSignal,
    origin?: LlmCallOrigin,
  ): Promise<LlmResult> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    let url: string;
    if (this.relay) {
      // 中継では鍵を送らない（中継が運営の鍵を付け直す）。Gemini はモデル名（別名）が URL に載る。
      // 経路は functions/src/llmRelay.ts の GOOGLE_PATH_RE と対。
      url = this.relayUrl(`/v1beta/models/${encodeURIComponent(this.modelName)}:streamGenerateContent?alt=sse`);
      Object.assign(headers, await this.relayAuthHeaders());
    } else {
      if (!this.apiKey) throw new Error('API Key is missing.');
      url = `${this.baseUrl}/${this.modelName}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
    }

    // Gemini に送ってよい generationConfig の鍵。
    // 2026-10-07 の Google の告知（[Action Required] Update thinking_budget and sampling parameters）:
    //   - temperature / topP / topK は 3.6 Flash 以降、既定に固定されて効いていない。次のモデルからは付いているとエラー
    //   - thinkingBudget は次のモデルから 400 INVALID_ARGUMENT（thinkingLevel に置き換え）
    // 設定（llm.json・各アプリの generationConfig）にあっても送らない。思考の深さは thinkingLevel だけ。
    const GEMINI_ALLOWED_STRUCTURE = {
      maxOutputTokens: null,
      stopSequences: null,
      responseMimeType: null,
      responseSchema: null,
      candidateCount: null,
      thinkingConfig: {
        thinkingLevel: null,
        includeThoughts: null,
      },
    };

    const userGenConfig =
      typeof this.config.generationConfig === 'object' && this.config.generationConfig !== null
        ? this.config.generationConfig
        : {};

    const combinedInput = {
      ...this.config,
      ...userGenConfig,
    };

    const generationConfig = filterNestedObject(combinedInput, GEMINI_ALLOWED_STRUCTURE);

    if (generationConfig.maxOutputTokens === undefined) generationConfig.maxOutputTokens = 65536;

    // 行頭の `<yield` で止める（OS のチャットだけ。上の GEMINI_YIELD_STOP の説明）。
    // 設定の停止文字列が上限まで埋まっていたら足さず、戻すこともしない。
    let yieldStop = false;
    if (origin?.caller === LLM_CALLER_ROOT) {
      const own: string[] = Array.isArray(generationConfig.stopSequences)
        ? generationConfig.stopSequences.filter((s: unknown): s is string => typeof s === 'string')
        : [];
      if (own.includes(GEMINI_YIELD_STOP)) {
        yieldStop = true;
      } else if (own.length < GEMINI_MAX_STOP_SEQUENCES) {
        generationConfig.stopSequences = [...own, GEMINI_YIELD_STOP];
        yieldStop = true;
      }
    }
    let written = '';

    const payload = {
      contents: messages,
      generationConfig: generationConfig,
    };

    const response = await this.postForStream(url, headers, payload, signal);

    await this.checkError(response, 'Gemini');

    const reader = response.body!.getReader();
    let finalUsageMetadata: any = null;
    let stopReason: string | null = null;

    try {
      for await (const line of this.readSSELines(reader, signal)) {
        const trimmedLine = line.trim();
        if (!trimmedLine || !trimmedLine.startsWith('data: ')) continue;

        const dataStr = trimmedLine.substring(6);

        try {
          const data = JSON.parse(dataStr);

          const parts = data.candidates?.[0]?.content?.parts;
          if (Array.isArray(parts)) {
            for (const part of parts) {
              if (part.text) {
                this.markContentStarted();
                onChunk(part.text);
                if (yieldStop) written += part.text;
              }
            }
          }

          if (data.usageMetadata) {
            finalUsageMetadata = data.usageMetadata;
          }
          const finishReason = data.candidates?.[0]?.finishReason;
          if (typeof finishReason === 'string' && finishReason) stopReason = finishReason;
        } catch (e) {
          console.warn('[GeminiAdapter] Stream JSON parse warning:', e);
        }
      }

      // 停止文字列で削られた分を戻す。終端タグの在るターン（自然に終わった）と、ほかの理由で止まったターンには足さない
      if (yieldStop && stopReason === 'STOP' && terminalReader.parse(written).terminalTag === null) {
        onChunk(written.endsWith('\n') ? GEMINI_YIELD_TAG : GEMINI_YIELD_RESTORED);
      }

      const result: LlmResult = { provider: 'google', model: this.modelName, usage: null, stopReason };
      if (finalUsageMetadata) {
        const cached = finalUsageMetadata.cachedContentTokenCount || 0;
        const promptTotal = finalUsageMetadata.promptTokenCount || 0;
        const input = Math.max(0, promptTotal - cached);
        const output = finalUsageMetadata.candidatesTokenCount || 0;

        result.usage = {
          input: input,
          cached: cached,
          // Gemini はキャッシュへの書き込みを別に報告しない
          cacheWrite: 0,
          output: output,
          total: finalUsageMetadata.totalTokenCount || promptTotal + output,
        };
      }
      return result;
    } finally {
      reader.releaseLock();
    }
  }
}
