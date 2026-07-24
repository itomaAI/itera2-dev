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
    const baseUrl = 'https://api.anthropic.com/v1/messages';
    let targetUrl = baseUrl;

    const proxyUrl = this.config.network?.proxyUrl;
    if (proxyUrl) {
      targetUrl = `${proxyUrl}${encodeURIComponent(baseUrl)}`;
    }

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

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'files-api-2025-04-14',
        'anthropic-dangerously-allow-browser': 'true',
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

          try {
            const data = JSON.parse(dataStr);

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
            } else if (eventType === 'message_stop') {
              break;
            }
          } catch (e) {
            console.warn('[AnthropicAdapter] Stream Parse Warning:', e);
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
