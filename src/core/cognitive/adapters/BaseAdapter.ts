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
 *
 * ★ これは「**流れている途中で切れた**」を検出するための値であって、「まだ考えている」に当ててはいけない。
 *   思考中の無音は下の `STREAM_FIRST_CHUNK_TIMEOUT_MS` が受け持つ。
 */
export const STREAM_IDLE_TIMEOUT_MS = 30000;

/**
 * **本文の最初の 1 文字が来るまで**に許す時間（ミリ秒）。
 *
 * 推論の最中は本文が来ない（Anthropic は `message_start` だけ先に届き、その後は思考が終わるまで本文が無い）。
 * 「最初の 1 バイト」を基準にすると、バイトは来ているのに本文が無い時間を 30 秒で切ってしまうので、
 * **基準はバイトではなく本文**にする。ミャク楽側で先に直したもの（2026-08-27 / T-0276）を揃えた（T-0492）。
 *
 * 中継（`llmProxy`）を挟む経路でも、関数側の上限は 1200 秒なのでこの値が先に効く。
 */
export const STREAM_FIRST_CHUNK_TIMEOUT_MS = 600000;

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

  /**
   * 本文（利用者に見える文字）が流れ始めたか。各アダプタが最初の `onChunk` の直前に `markContentStarted()` で立てる。
   * `monitorStream` の入口で倒す（1 回の生成 ＝ 1 本のストリーム）。
   */
  protected contentStarted = false;
  protected markContentStarted(): void {
    this.contentStarted = true;
  }

  /**
   * ストリームの無音を見張る。上限は 2 段。
   *
   *   1. **本文の最初の 1 文字が来るまで** …… `STREAM_FIRST_CHUNK_TIMEOUT_MS`（長い）
   *   2. **本文が流れ始めたあと**           …… `STREAM_IDLE_TIMEOUT_MS`（30 秒）
   *
   * ★ 30 秒は「流れている途中で通信が切れた」を検出するためのもので、「まだ考えている」に当てるものではない。
   *   Anthropic は `message_start` が先に届く（＝バイトは来る）ので、「最初の 1 バイト」を基準にすると
   *   思考中の無音を 30 秒で切ってしまう。基準はバイトではなく**本文**にする。
   *   本文が来るまでの間もバイトが届くたびに時計は戻す（長い上限の中で）。
   */
  protected async *monitorStream(reader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal) {
    let idleTimeout: ReturnType<typeof setTimeout>;
    let timedOut: 'first' | 'idle' | null = null;
    this.contentStarted = false;

    const onAbort = () => {
      reader.cancel(new DOMException('Aborted', 'AbortError')).catch(() => {});
    };
    if (signal) signal.addEventListener('abort', onAbort);

    const resetIdleTimeout = () => {
      clearTimeout(idleTimeout);
      const phase: 'first' | 'idle' = this.contentStarted ? 'idle' : 'first';
      const limitMs = phase === 'first' ? STREAM_FIRST_CHUNK_TIMEOUT_MS : STREAM_IDLE_TIMEOUT_MS;
      idleTimeout = setTimeout(() => {
        timedOut = phase;
        reader.cancel(new Error('Stream Idle Timeout')).catch(() => {});
      }, limitMs);
    };

    resetIdleTimeout();

    try {
      while (true) {
        if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const { done, value } = await reader.read();

        if (timedOut === 'first') {
          throw new Error(
            `Stream Idle Timeout: No response from API for ${STREAM_FIRST_CHUNK_TIMEOUT_MS / 1000} seconds (before the first chunk).`,
          );
        }
        if (timedOut === 'idle') {
          throw new Error(`Stream Idle Timeout: No response from API for ${STREAM_IDLE_TIMEOUT_MS / 1000} seconds.`);
        }

        resetIdleTimeout();

        if (done) break;
        if (value) {
          yield value;
          // アダプタがこの塊を処理して本文の開始を立てたかもしれない。段が変わったなら 30 秒の時計に掛け替える
          if (this.contentStarted) resetIdleTimeout();
        }
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
