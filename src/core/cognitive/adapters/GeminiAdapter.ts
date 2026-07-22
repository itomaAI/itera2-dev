/**
 * src/core/cognitive/adapters/GeminiAdapter.ts
 * Itera OS v2: Google Gemini API Adapter
 */

import { BaseLLMAdapter, type LlmConfig } from './BaseAdapter';
import type { SystemLogger } from '../../state/SystemLogger';

export class GeminiAdapter extends BaseLLMAdapter {
  private apiKey: string;
  private modelName: string;
  private baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models';

  constructor(
    apiKey: string,
    modelName: string = 'gemini-3-flash-preview',
    config: LlmConfig = {},
    logger: SystemLogger | null = null,
  ) {
    super(config, logger);
    this.apiKey = apiKey;
    this.modelName = modelName;
  }

  async generateStream(messages: any, onChunk: (text: string) => void, signal?: AbortSignal): Promise<void> {
    if (!this.apiKey) throw new Error('API Key is missing.');

    const url = `${this.baseUrl}/${this.modelName}:streamGenerateContent?key=${this.apiKey}`;

    const GEMINI_GEN_CONFIG_KEYS = [
      'thinkingLevel',
      'thinking_level',
      'maxOutputTokens',
      'max_output_tokens',
      'temperature',
      'topP',
      'top_p',
      'topK',
      'top_k',
      'stopSequences',
      'stop_sequences',
      'responseMimeType',
      'response_mime_type',
      'responseSchema',
      'response_schema',
      'candidateCount',
      'candidate_count',
      'thinkingConfig',
    ];

    const userGenConfig = (typeof this.config.generationConfig === 'object' && this.config.generationConfig !== null)
      ? this.config.generationConfig
      : {};

    const generationConfig: Record<string, any> = {
      temperature: userGenConfig.temperature ?? this.config.temperature ?? 1.0,
      maxOutputTokens: userGenConfig.maxOutputTokens ?? userGenConfig.max_output_tokens ?? this.config.maxOutputTokens ?? this.config.max_output_tokens ?? 65536,
    };

    for (const key of GEMINI_GEN_CONFIG_KEYS) {
      if (key in userGenConfig && userGenConfig[key] !== null) {
        generationConfig[key] = userGenConfig[key];
      } else if (key in this.config && this.config[key] !== null) {
        generationConfig[key] = this.config[key];
      }
    }

    // Normalize snake_case keys to camelCase for Gemini REST API protobuf compatibility
    if ('thinking_level' in generationConfig) {
      generationConfig.thinkingLevel = generationConfig.thinking_level;
      delete generationConfig.thinking_level;
    }
    if ('max_output_tokens' in generationConfig) {
      generationConfig.maxOutputTokens = generationConfig.max_output_tokens;
      delete generationConfig.max_output_tokens;
    }
    if ('stop_sequences' in generationConfig) {
      generationConfig.stopSequences = generationConfig.stop_sequences;
      delete generationConfig.stop_sequences;
    }
    if ('response_mime_type' in generationConfig) {
      generationConfig.responseMimeType = generationConfig.response_mime_type;
      delete generationConfig.response_mime_type;
    }
    if ('response_schema' in generationConfig) {
      generationConfig.responseSchema = generationConfig.response_schema;
      delete generationConfig.response_schema;
    }
    if ('candidate_count' in generationConfig) {
      generationConfig.candidateCount = generationConfig.candidate_count;
      delete generationConfig.candidate_count;
    }
    if ('top_p' in generationConfig) {
      generationConfig.topP = generationConfig.top_p;
      delete generationConfig.top_p;
    }
    if ('top_k' in generationConfig) {
      generationConfig.topK = generationConfig.top_k;
      delete generationConfig.top_k;
    }

    if (generationConfig.thinkingLevel) {
      delete generationConfig.thinkingConfig;
      delete generationConfig.thinkingBudget;
    }

    const payload = {
      contents: messages,
      generationConfig: generationConfig,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });

    if (!response.ok) {
      let errText = await response.text();
      try {
        const errJson = JSON.parse(errText);
        errText = errJson.error?.message || errText;
      } catch (e) {}
      throw new Error(`Gemini API Error (${response.status}): ${errText}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
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

    let finalUsageMetadata: any = null;

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

        while (true) {
          const textKeyIdx = buffer.indexOf('"text"');
          if (textKeyIdx === -1) break;

          let startQuote = -1;
          for (let i = textKeyIdx + 6; i < buffer.length; i++) {
            if (buffer[i] === '"') {
              startQuote = i;
              break;
            }
          }
          if (startQuote === -1) break;

          let endQuote = -1;
          let escaped = false;
          for (let i = startQuote + 1; i < buffer.length; i++) {
            const char = buffer[i];
            if (escaped) {
              escaped = false;
              continue;
            }
            if (char === '\\') {
              escaped = true;
              continue;
            }
            if (char === '"') {
              endQuote = i;
              break;
            }
          }

          if (endQuote === -1) break;

          const rawText = buffer.substring(startQuote + 1, endQuote);
          try {
            const text = JSON.parse(`"${rawText}"`);
            if (text) onChunk(text);
          } catch (e) {}

          buffer = buffer.substring(endQuote + 1);
        }

        const usageMatch = buffer.match(/"usageMetadata"\s*:\s*(\{(?:[^{}]|(?:\{[^{}]*\}))*\})/);
        if (usageMatch) {
          try {
            finalUsageMetadata = JSON.parse(usageMatch[1]);
          } catch (e) {}
        }
      }

      if (this.logger && finalUsageMetadata) {
        const cached = finalUsageMetadata.cachedContentTokenCount || 0;
        const promptTotal = finalUsageMetadata.promptTokenCount || 0;
        const input = Math.max(0, promptTotal - cached);
        const output = finalUsageMetadata.candidatesTokenCount || 0;

        this.logger.log('usage', {
          provider: 'google',
          model: this.modelName,
          tokens: {
            input: input,
            cached: cached,
            output: output,
            total: finalUsageMetadata.totalTokenCount || promptTotal + output,
          },
        });
      }
    } finally {
      clearTimeout(idleTimeout!);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
}
