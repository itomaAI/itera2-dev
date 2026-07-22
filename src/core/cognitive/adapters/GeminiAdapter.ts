/**
 * src/core/cognitive/adapters/GeminiAdapter.ts
 * Itera OS v2: Google Gemini API Adapter
 */

import { BaseLLMAdapter, filterNestedObject, type LlmConfig } from './BaseAdapter';
import type { SystemLogger } from '../../state/SystemLogger';

export class GeminiAdapter extends BaseLLMAdapter {
  private apiKey: string;
  private modelName: string;
  private baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models';

  constructor(
    apiKey: string,
    modelName: string = 'gemini-3.6-flash',
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

    const GEMINI_ALLOWED_STRUCTURE = {
      temperature: null,
      maxOutputTokens: null,
      topP: null,
      topK: null,
      stopSequences: null,
      responseMimeType: null,
      responseSchema: null,
      candidateCount: null,
      thinkingConfig: {
        thinkingLevel: null,
        thinkingBudget: null,
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

    // Extract & normalize flat or shorthand thinking settings
    const thinkingLevel =
      combinedInput.thinkingLevel ??
      combinedInput.thinking_level ??
      userGenConfig.thinkingConfig?.thinkingLevel ??
      userGenConfig.thinkingConfig?.thinking_level ??
      this.config.thinkingConfig?.thinkingLevel ??
      this.config.thinkingConfig?.thinking_level;

    const thinkingBudget =
      combinedInput.thinkingBudget ??
      combinedInput.thinking_budget ??
      userGenConfig.thinkingConfig?.thinkingBudget ??
      userGenConfig.thinkingConfig?.thinking_budget ??
      this.config.thinkingConfig?.thinkingBudget ??
      this.config.thinkingConfig?.thinking_budget;

    if (thinkingLevel || thinkingBudget !== undefined) {
      const existingTc = combinedInput.thinkingConfig && typeof combinedInput.thinkingConfig === 'object'
        ? combinedInput.thinkingConfig
        : {};
      combinedInput.thinkingConfig = { ...existingTc };
      if (thinkingLevel) combinedInput.thinkingConfig.thinkingLevel = thinkingLevel;
      if (thinkingBudget !== undefined) combinedInput.thinkingConfig.thinkingBudget = thinkingBudget;
    }

    if ('max_output_tokens' in combinedInput) combinedInput.maxOutputTokens = combinedInput.max_output_tokens;
    if ('stop_sequences' in combinedInput) combinedInput.stopSequences = combinedInput.stop_sequences;
    if ('response_mime_type' in combinedInput) combinedInput.responseMimeType = combinedInput.response_mime_type;
    if ('response_schema' in combinedInput) combinedInput.responseSchema = combinedInput.response_schema;
    if ('candidate_count' in combinedInput) combinedInput.candidateCount = combinedInput.candidate_count;
    if ('top_p' in combinedInput) combinedInput.topP = combinedInput.top_p;
    if ('top_k' in combinedInput) combinedInput.topK = combinedInput.top_k;

    const generationConfig = filterNestedObject(combinedInput, GEMINI_ALLOWED_STRUCTURE);

    if (generationConfig.temperature === undefined) generationConfig.temperature = 1.0;
    if (generationConfig.maxOutputTokens === undefined) generationConfig.maxOutputTokens = 65536;

    if (generationConfig.thinkingConfig && generationConfig.thinkingConfig.thinkingLevel) {
      delete generationConfig.thinkingConfig.thinkingBudget;
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
