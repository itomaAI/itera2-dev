/**
 * src/core/cognitive/adapters/OpenAIAdapter.ts
 * Itera OS v2: OpenAI / Local (Ollama, LM Studio) API Adapter
 */

import { BaseLLMAdapter, filterNestedObject, type LlmConfig } from './BaseAdapter';
import type { SystemLogger } from '../../state/SystemLogger';

export class OpenAIAdapter extends BaseLLMAdapter {
  private apiKey: string;
  private modelName: string;
  private baseUrl: string;

  constructor(
    apiKey: string,
    modelName: string = 'gpt-4o',
    baseUrl: string = 'https://api.openai.com/v1',
    config: LlmConfig = {},
    logger: SystemLogger | null = null,
  ) {
    super(config, logger);
    this.apiKey = apiKey;
    this.modelName = modelName;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async generateStream(messages: any, onChunk: (text: string) => void, signal?: AbortSignal): Promise<void> {
    const url = `${this.baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    if (this.baseUrl.includes('openrouter.ai')) {
      headers['HTTP-Referer'] = window.location.href;
      headers['X-Title'] = 'Itera OS v2';
    }

    const isOpenRouterOrCustom = this.baseUrl.includes('openrouter.ai') || !this.baseUrl.includes('api.openai.com');

    const OPENAI_ALLOWED_STRUCTURE = {
      temperature: null,
      max_tokens: null,
      max_completion_tokens: null,
      reasoning_effort: null,
      reasoning: {
        effort: null,
      },
      text: {
        verbosity: null,
      },
      response_format: null,
      seed: null,
      top_p: null,
      frequency_penalty: null,
      presence_penalty: null,
      stop: null,
      user: null,
    };

    const RESERVED_INTERNAL_KEYS = ['model', 'generationConfig', 'providerOptions', 'network'];

    const payload: any = {
      model: this.modelName,
      messages: messages,
      stream: true,
      // ★ OpenAI最新仕様: ストリームの最後に usage を含めるオプション
      stream_options: { include_usage: true },
      temperature: this.config.temperature ?? 1.0,
    };

    if (this.config.maxOutputTokens) {
      payload.max_tokens = this.config.maxOutputTokens;
    }

    if (isOpenRouterOrCustom) {
      // OpenRouter / Custom: 予約キー以外を完全パススルー
      for (const [key, val] of Object.entries(this.config)) {
        if (!RESERVED_INTERNAL_KEYS.includes(key) && val !== null) {
          payload[key] = val;
        }
      }
    } else {
      // 本家 OpenAI: 階層テンプレートによるネストフィルタリング＆マージ
      const filteredConfig = filterNestedObject(this.config, OPENAI_ALLOWED_STRUCTURE);
      Object.assign(payload, filteredConfig);

      // 思考モデル / reasoning 有効時は 400 エラー回避のためサンプリングパラメータを自動削除
      const hasReasoning = Boolean(
        payload.reasoning_effort ||
        payload.reasoning ||
        this.modelName.startsWith('o1') ||
        this.modelName.startsWith('o3')
      );
      if (hasReasoning) {
        delete payload.temperature;
        delete payload.top_p;
        delete payload.frequency_penalty;
        delete payload.presence_penalty;
      }
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload),
      signal,
    });

    if (!response.ok) {
      let errText = await response.text();
      try {
        const errJson = JSON.parse(errText);
        errText = errJson.error?.message || errText;
      } catch (e) {}
      throw new Error(`OpenAI API Error (${response.status}): ${errText}`);
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

    try {
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
          if (!trimmedLine || !trimmedLine.startsWith('data: ')) continue;

          const dataStr = trimmedLine.substring(6);

          if (dataStr === '[DONE]') break;

          try {
            const data = JSON.parse(dataStr);

            // ★ OpenAIの include_usage: true 時のトークン消費量抽出
            if (data.usage && this.logger) {
              const grossPrompt = data.usage.prompt_tokens || 0;
              const promptDetails = data.usage.prompt_tokens_details || {};
              const cached = promptDetails.cached_tokens || 0;
              const cacheWrite = promptDetails.cache_write_tokens || 0;
              this.logger.log('usage', {
                provider: 'openai_compatible',
                model: this.modelName,
                tokens: {
                  input: Math.max(0, grossPrompt - cached - cacheWrite),
                  cached: cached,
                  cacheWrite: cacheWrite,
                  output: data.usage.completion_tokens || 0,
                  total: data.usage.total_tokens || grossPrompt + (data.usage.completion_tokens || 0),
                },
              });
            }

            const delta = data.choices?.[0]?.delta;
            if (delta && delta.content) {
              onChunk(delta.content);
            }
          } catch (e) {
            console.warn('[OpenAIAdapter] Stream Parse Warning:', e, dataStr);
          }
        }
      }
    } finally {
      clearTimeout(idleTimeout!);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
}
