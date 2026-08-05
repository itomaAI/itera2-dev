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

    const url = `${this.baseUrl}/${this.modelName}:streamGenerateContent?alt=sse&key=${this.apiKey}`;

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
    let finalUsageMetadata: any = null;

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
                onChunk(part.text);
              }
            }
          }

          if (data.usageMetadata) {
            finalUsageMetadata = data.usageMetadata;
          }
        } catch (e) {
          console.warn('[GeminiAdapter] Stream JSON parse warning:', e);
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
