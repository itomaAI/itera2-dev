/**
 * src/core/cognitive/adapters/AnthropicAdapter.ts
 * Itera OS v2: Anthropic API Adapter
 */

import { BaseLLMAdapter, type LlmConfig } from './BaseAdapter';
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

    const ANTHROPIC_SUPPORTED_KEYS = [
      'thinking',
      'output_config',
      'max_tokens',
      'temperature',
      'top_k',
      'top_p',
      'stop_sequences',
    ];

    const payload: any = {
      model: this.modelName,
      max_tokens: this.config.max_tokens ?? this.config.maxOutputTokens ?? 8192,
      system: system,
      messages: messages,
      stream: true,
      temperature: this.config.temperature ?? 1.0,
    };

    for (const key of ANTHROPIC_SUPPORTED_KEYS) {
      if (key in this.config && this.config[key] !== null) {
        payload[key] = this.config[key];
      }
    }

    // 思考モード (thinking / output_config) 有効時は 400 エラー回避のため temperature を自動削除
    if (payload.thinking || payload.output_config) {
      delete payload.temperature;
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

    if (!response.ok) {
      let errText = await response.text();
      try {
        const errJson = JSON.parse(errText);
        errText = errJson.error?.message || errText;
      } catch (e) {}
      throw new Error(`Anthropic API Error (${response.status}): ${errText}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    const onAbort = () => {
      reader.cancel(new DOMException('Aborted', 'AbortError')).catch(() => {});
    };
    if (signal) signal.addEventListener('abort', onAbort);

    let idleTimeout: ReturnType<typeof setTimeout>;
    let isIdleTimeout = false;
    const resetIdleTimeout = () => {
      clearTimeout(idleTimeout);
      idleTimeout = setTimeout(() => {
        isIdleTimeout = true;
        reader.cancel(new Error('Stream Idle Timeout'));
      }, 15000);
    };

    resetIdleTimeout();

    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let cacheWriteTokens = 0;

    try {
      let eventType: string | null = null;

      while (true) {
        if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const { done, value } = await reader.read();

        if (isIdleTimeout) {
          throw new Error('Stream Idle Timeout: No response from API for 15 seconds.');
        }

        resetIdleTimeout();

        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
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
      clearTimeout(idleTimeout!);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
}
