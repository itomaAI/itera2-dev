/**
 * src/core/cognitive/adapters/OpenAIAdapter.ts
 * Itera OS v2: OpenAI / Local (Ollama, LM Studio) API Adapter
 */

import { BaseLLMAdapter, type LlmConfig } from "./BaseAdapter";
import type { SystemLogger } from "../../state/SystemLogger";

export class OpenAIAdapter extends BaseLLMAdapter {
  private apiKey: string;
  private modelName: string;
  private baseUrl: string;

  constructor(
    apiKey: string,
    modelName: string = "gpt-4o",
    baseUrl: string = "https://api.openai.com/v1",
    config: LlmConfig = {},
    logger: SystemLogger | null = null,
  ) {
    super(config, logger);
    this.apiKey = apiKey;
    this.modelName = modelName;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async generateStream(
    messages: any,
    onChunk: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const url = `${this.baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    if (this.baseUrl.includes("openrouter.ai")) {
      headers["HTTP-Referer"] = window.location.href;
      headers["X-Title"] = "Itera OS v2";
    }

    const payload: any = {
      model: this.modelName,
      messages: messages,
      stream: true,
      // ★ OpenAI最新仕様: ストリームの最後に usage を含めるオプション
      stream_options: { include_usage: true },
      temperature: this.config.temperature || 1.0,
    };
    if (this.config.maxOutputTokens) {
      payload.max_tokens = this.config.maxOutputTokens;
    }

    const response = await fetch(url, {
      method: "POST",
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
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    const onAbort = () => {
      reader.cancel(new DOMException("Aborted", "AbortError")).catch(() => {});
    };
    if (signal) signal.addEventListener("abort", onAbort);

    let idleTimeout: ReturnType<typeof setTimeout>;
    let isIdleTimeout = false;
    const resetIdleTimeout = () => {
      clearTimeout(idleTimeout);
      idleTimeout = setTimeout(() => {
        isIdleTimeout = true;
        reader.cancel(new Error("Stream Idle Timeout"));
      }, 15000);
    };

    resetIdleTimeout();

    try {
      while (true) {
        if (signal && signal.aborted)
          throw new DOMException("Aborted", "AbortError");
        const { done, value } = await reader.read();

        if (isIdleTimeout) {
          throw new Error(
            "Stream Idle Timeout: No response from API for 15 seconds.",
          );
        }

        resetIdleTimeout();

        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");

        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmedLine = line.trim();
          if (!trimmedLine || !trimmedLine.startsWith("data: ")) continue;

          const dataStr = trimmedLine.substring(6);

          if (dataStr === "[DONE]") break;

          try {
            const data = JSON.parse(dataStr);

            // ★ OpenAIの include_usage: true 時のトークン消費量抽出
            if (data.usage && this.logger) {
              this.logger.log("usage", {
                provider: "openai_compatible",
                model: this.modelName,
                tokens: {
                  input: data.usage.prompt_tokens,
                  output: data.usage.completion_tokens,
                  total: data.usage.total_tokens,
                },
              });
            }

            const delta = data.choices?.[0]?.delta;
            if (delta && delta.content) {
              onChunk(delta.content);
            }
          } catch (e) {
            console.warn("[OpenAIAdapter] Stream Parse Warning:", e, dataStr);
          }
        }
      }
    } catch (e: any) {
      if (e.name === "AbortError") throw e;
      throw e;
    } finally {
      clearTimeout(idleTimeout!);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }
}
