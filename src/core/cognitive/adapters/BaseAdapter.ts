/**
 * src/core/cognitive/adapters/BaseAdapter.ts
 * Itera OS v2: Base LLM Adapter Interface
 */

import type { SystemLogger } from '../../state/SystemLogger';

export interface LlmConfig {
  temperature?: number;
  maxOutputTokens?: number;
  [key: string]: any;
}

/**
 * テンプレート構造に存在するキーのみをネストを含めて再帰的に抽出するヘルパー関数
 */
export function filterNestedObject(input: any, template: Record<string, any>): Record<string, any> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {};
  }

  const result: Record<string, any> = {};

  for (const [key, templateValue] of Object.entries(template)) {
    if (key in input && input[key] !== null && input[key] !== undefined) {
      const val = input[key];

      if (typeof templateValue === 'object' && templateValue !== null && !Array.isArray(templateValue)) {
        if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
          const filteredSub = filterNestedObject(val, templateValue);
          if (Object.keys(filteredSub).length > 0) {
            result[key] = filteredSub;
          }
        }
      } else {
        result[key] = val;
      }
    }
  }

  return result;
}

export abstract class BaseLLMAdapter {
  protected config: LlmConfig;
  protected logger: SystemLogger | null;

  constructor(config: LlmConfig = {}, logger: SystemLogger | null = null) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * @param messages - 各社プロバイダのフォーマットに合わせたメッセージ配列 (Projectorが生成)
   * @param onChunk - テキストのチャンクを受信した際のコールバック
   * @param signal - 中断用のAbortSignal
   */
  abstract generateStream(messages: any, onChunk: (text: string) => void, signal?: AbortSignal): Promise<void>;

  protected async checkError(response: Response, providerName: string): Promise<void> {
    if (!response.ok) {
      let errText = await response.text();
      try {
        const errJson = JSON.parse(errText);
        errText = errJson.error?.message || errText;
      } catch (e) {}
      throw new Error(`${providerName} API Error (${response.status}): ${errText}`);
    }
  }

  protected async *monitorStream(reader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal) {
    let idleTimeout: ReturnType<typeof setTimeout>;
    let isIdleTimeout = false;

    const onAbort = () => {
      reader.cancel(new DOMException('Aborted', 'AbortError')).catch(() => {});
    };
    if (signal) signal.addEventListener('abort', onAbort);

    const resetIdleTimeout = () => {
      clearTimeout(idleTimeout);
      idleTimeout = setTimeout(() => {
        isIdleTimeout = true;
        reader.cancel(new Error('Stream Idle Timeout')).catch(() => {});
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
        if (value) yield value;
      }
    } finally {
      clearTimeout(idleTimeout!);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  protected async *readSSELines(reader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal) {
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    for await (const chunk of this.monitorStream(reader, signal)) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        yield line;
      }
    }
    if (buffer) {
      yield buffer;
    }
  }
}
