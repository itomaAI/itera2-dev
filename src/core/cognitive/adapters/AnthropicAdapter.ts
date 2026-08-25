/**
 * src/core/cognitive/adapters/AnthropicAdapter.ts
 * Itera OS v2: Anthropic API Adapter
 */

import { BaseLLMAdapter, filterNestedObject, type LlmConfig } from './BaseAdapter';
import type { SystemLogger } from '../../state/SystemLogger';

export class AnthropicAdapter extends BaseLLMAdapter {
  private apiKey: string;
  private modelName: string;

  constructor(
    apiKey: string,
    modelName: string = 'claude-3-5-sonnet-20241022',
    config: LlmConfig = {},
    logger: SystemLogger | null = null,
  ) {
    super(config, logger);
    this.apiKey = apiKey;
    this.modelName = modelName;
  }

  async generateStream(payloadData: any, onChunk: (text: string) => void, signal?: AbortSignal): Promise<void> {
    const { system, messages } = payloadData;
    // ブラウザから直接叩く。プロキシは挟まない（この OS はブラウザ単独で動くことを目指しているため）。
    const url = 'https://api.anthropic.com/v1/messages';

    const ANTHROPIC_ALLOWED_STRUCTURE = {
      temperature: null,
      max_tokens: null,
      top_k: null,
      top_p: null,
      stop_sequences: null,
      thinking: {
        type: null,
        budget_tokens: null,
        display: null,
      },
      output_config: {
        effort: null,
        format: null,
      },
    };

    const payload: any = {
      model: this.modelName,
      max_tokens: this.config.max_tokens ?? this.config.maxOutputTokens ?? 8192,
      cache_control: { type: 'ephemeral' },
      system: system,
      messages: messages,
      stream: true,
      temperature: this.config.temperature ?? 1.0,
    };

    const filteredConfig = filterNestedObject(this.config, ANTHROPIC_ALLOWED_STRUCTURE);
    Object.assign(payload, filteredConfig);

    // 思考モード (thinking / output_config) 有効時は 400 エラー回避のためサンプリングパラメータを自動削除
    if (payload.thinking || payload.output_config) {
      delete payload.temperature;
      delete payload.top_p;
      delete payload.top_k;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        // ブラウザから直接叩くことへの明示的な同意。**この名前でないと CORS が開かない。**
        // 名前が違うと Anthropic は access-control-allow-origin を返さず、
        // ブラウザは応答を見る前に fetch を落とす（TypeError: NetworkError）。
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(payload),
      signal,
    });

    await this.checkError(response, 'Anthropic');

    const reader = response.body!.getReader();
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let cacheWriteTokens = 0;

    try {
      let eventType: string | null = null;

      for await (const line of this.readSSELines(reader, signal)) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;

        if (trimmedLine.startsWith('event: ')) {
          eventType = trimmedLine.substring(7);
          continue;
        }

        if (trimmedLine.startsWith('data: ')) {
          const dataStr = trimmedLine.substring(6);

          // parse だけを try で包む。ここを広く取ると、下の throw を自分の catch が
          // 握り潰して「警告を出して続行」になる（＝エラーが無かったことにされる）。
          let data: any;
          try {
            data = JSON.parse(dataStr);
          } catch (e) {
            console.warn('[AnthropicAdapter] Stream Parse Warning:', e);
            continue;
          }

          // ★ Anthropic のトークン消費量抽出
          if (eventType === 'message_start' && data.message?.usage) {
            const standardInput = data.message.usage.input_tokens || 0;
            const cached = data.message.usage.cache_read_input_tokens || 0;
            const cacheWrite = data.message.usage.cache_creation_input_tokens || 0;
            inputTokens = standardInput;
            cachedTokens = cached;
            cacheWriteTokens = cacheWrite;
          } else if (eventType === 'message_delta' && data.usage) {
            outputTokens = data.usage.output_tokens || 0;
          } else if (eventType === 'content_block_delta') {
            if (data.delta && data.delta.type === 'text_delta') {
              onChunk(data.delta.text);
            }
          } else if (eventType === 'error') {
            // 途中で流れてくるエラー（overloaded_error など）。拾わないと、
            // 本文が 1 文字も来ないまま「正常に終わった」ように見える。
            throw new Error(`Anthropic API Error (stream): ${data.error?.message || dataStr}`);
          } else if (eventType === 'message_stop') {
            break;
          }
        }
      }

      if (this.logger) {
        this.logger.log('usage', {
          provider: 'anthropic',
          model: this.modelName,
          tokens: {
            input: inputTokens,
            cached: cachedTokens,
            cacheWrite: cacheWriteTokens,
            output: outputTokens,
            total: inputTokens + cachedTokens + cacheWriteTokens + outputTokens,
          },
        });
      }
    } finally {
      reader.releaseLock();
    }
  }
}
