/**
 * src/core/cognitive/adapters/BaseAdapter.ts
 * Itera OS v2: Base LLM Adapter Interface
 */

import type { SystemLogger } from '../../state/SystemLogger';

/**
 * ストリームが無音のまま許す時間（ミリ秒）。
 *
 * これを超えたら通信が死んだとみなして中断する。**推論（reasoning）の最中は
 * 上流から何も届かないことがある**ため、短すぎると「考えているだけのモデル」を殺してしまう。
 * 15 秒では足りなかった（2026-08-22 / T-0073）。
 */
export const STREAM_IDLE_TIMEOUT_MS = 30000;

export interface LlmConfig {
  temperature?: number;
  maxOutputTokens?: number;
  [key: string]: any;
}

/**
 * 中継（運営の鍵で LLM を呼ぶプロキシ。itera2 の Functions `llmProxy`）を使うときだけ渡す送信設定。
 *
 * 各アダプタは既定では各社の URL と鍵を内側に持っている。中継ではその 2 点だけが別物になるため、
 * 差し替え口をここに集約する。**本文の形式は各社のまま**（中継は素通しする）。
 *
 * 認証は「値」ではなく「取り方」で持つ。Firebase の ID トークンは 1 時間で失効し、
 * Engine は同じアダプタを長時間使い回すため、生成のたびに取り直す必要がある。
 * （ミャク楽 `agent/` の `RelayTransport` と同じ形。T-0421）
 */
export interface RelayTransport {
  /** 中継の基点 URL。各アダプタが自分の経路（`/v1/messages` など）を足す */
  baseUrl: string;
  /** 認証ヘッダの取得。呼ぶたびに取り直す。取れなければ投げる */
  getAuthHeaders: () => Promise<Record<string, string>>;
  /**
   * OpenAI 形式のとき、上流が本家 OpenAI であることを示す。
   * 中継先が本家である以上、OpenRouter / Custom 向けの「設定の素通し」は 400 を招くだけなので、
   * 既定の絞り込みを働かせる。
   */
  strictOpenAISchema?: boolean;
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
  /** 中継を使うときだけ非 null。null なら各社の API を直接叩く（従来どおり） */
  protected relay: RelayTransport | null;

  constructor(config: LlmConfig = {}, logger: SystemLogger | null = null, relay: RelayTransport | null = null) {
    this.config = config;
    this.logger = logger;
    this.relay = relay;
  }

  /** 中継の経路を組み立てる。`path` は先頭にスラッシュを付けて渡す。 */
  protected relayUrl(path: string): string {
    return `${(this.relay?.baseUrl || '').replace(/\/+$/, '')}${path}`;
  }

  /**
   * 中継へ付ける認証ヘッダ。取得できなければ**送信しない**。
   * 未認証のまま投げても 401 が返るだけだが、利用者からは「モデルが壊れている」ようにしか見えない。
   * ここで理由の分かる形で落とす。
   */
  protected async relayAuthHeaders(): Promise<Record<string, string>> {
    const headers = this.relay ? await this.relay.getAuthHeaders() : null;
    if (!headers || typeof headers !== 'object' || Object.keys(headers).length === 0) {
      throw new Error('Could not get credentials for the LLM relay. Sign in to Itera Cloud again.');
    }
    return headers;
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
    const idleLimitMs = STREAM_IDLE_TIMEOUT_MS;
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
      }, idleLimitMs);
    };

    resetIdleTimeout();

    try {
      while (true) {
        if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const { done, value } = await reader.read();

        if (isIdleTimeout) {
          throw new Error(`Stream Idle Timeout: No response from API for ${idleLimitMs / 1000} seconds.`);
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
