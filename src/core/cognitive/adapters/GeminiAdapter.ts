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

    await this.checkError(response, 'Gemini');

    const reader = response.body!.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let finalUsageMetadata: any = null;

    try {
      for await (const chunk of this.monitorStream(reader, signal)) {
        buffer += decoder.decode(chunk, { stream: true });

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
      reader.releaseLock();
    }
  }
}
