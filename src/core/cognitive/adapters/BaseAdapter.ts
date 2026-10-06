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
  /**
   * 大きな本文を Firebase Storage に置き、在り処（`llmRelayBodies/{uid}/{名前}.json`）を返す（T-0622。ミャク楽 T-0600）。
   * 中継は HTTP/1 で受けるので 32 MiB を超える本文は届かない。超えそうな本文はここへ置き、中継には在り処だけを送る。
   * 無ければ（置き場の分からない配布物）従来どおり 32 MiB で止める。
   */
  stashBody?: (body: string, signal?: AbortSignal) => Promise<string>;
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

/**
 * 中継（Cloud Functions 第 2 世代＝Cloud Run）が受け付ける要求本文の上限（ミャク楽 T-0594）。
 *
 * 超えると Google のフロントが 413 を返すが、その応答には CORS ヘッダが無い。
 * ブラウザは状態コードを読めず、fetch は "Failed to fetch"（TypeError）で落ちる。
 * ミャク楽 prod で確かめた値（2026-10-02）: 31 MiB の POST は関数に届き、33 MiB は 413（CORS なし）。
 * 中継の経路では添付を毎回 base64 で本文に埋めるので、会話が進むほど本文は大きくなる。
 */
export const RELAY_MAX_REQUEST_BYTES = 32 * 1024 * 1024;

/**
 * これを超える本文は、上限の手前でも中継が処理しきれないことがある（ミャク楽 T-0594）。
 * 2026-10-02 のミャク楽 prod のログでは、18.3 MB の要求の 1 秒後に中継が 512 MiB を超えて落ちた。
 * 落ちた中継の応答にも CORS ヘッダは無く、ブラウザからは同じ "Failed to fetch" に見える。
 */
export const RELAY_LARGE_REQUEST_BYTES = 16 * 1024 * 1024;

/**
 * これを超える本文は、Storage に置いてから在り処だけを中継へ送る（T-0622。ミャク楽 T-0600）。
 * 32 MiB の門の手前に余裕を取る（認証ヘッダなど本文の外の分と、数え方の差）。
 */
export const RELAY_STASH_THRESHOLD_BYTES = 24 * 1024 * 1024;

/** Storage に置ける本文の上限。中継側の `storage.rules` と `llmRelayBodies.MAX_STORED_BYTES` と同じ値にする */
export const RELAY_STORED_MAX_BYTES = 64 * 1024 * 1024;

/** 本文を中継へ渡すときの在り処の印。中継側の `llmRelayBodies.STORED_BODY_FIELD` と同じ名前 */
export const RELAY_STORED_BODY_FIELD = 'relayStoredBody';

function formatMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/** 中継の上限を超えたため送らなかったときの文言。利用者と AI の両方が読む */
export function requestTooLargeMessage(bytes: number, limit: number = RELAY_MAX_REQUEST_BYTES): string {
  return (
    `The request was not sent because it is too large for the LLM relay (about ${formatMB(bytes)} MB; the limit is ${formatMB(limit)} MB). ` +
    `Attachments in the conversation (PDFs, images, files you read) are re-sent in full on every turn, so the request grows as the conversation goes on. ` +
    `Start a new conversation, or remove the messages with attachments from the history, and try again.`
  );
}

/** 中継への fetch が応答を返さずに落ちたときの文言。ブラウザは理由を教えないので、分かっていることと候補を伝える */
export function relayFetchFailedMessage(cause: string, bytes: number): string {
  const head = `Could not reach the LLM relay (${cause}; the request was about ${formatMB(bytes)} MB). `;
  if (bytes > RELAY_LARGE_REQUEST_BYTES) {
    return (
      head +
      `Large requests (over ${formatMB(RELAY_LARGE_REQUEST_BYTES)} MB) can fail because the relay cannot handle them. ` +
      `Attachments in the conversation (PDFs, images, files you read) are re-sent in full on every turn. ` +
      `Start a new conversation, or remove the messages with attachments from the history, and try again.`
    );
  }
  return (
    head + `The connection may have dropped or the relay may be temporarily unavailable. Wait a moment and try again.`
  );
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

  /**
   * 生成の要求を送る（3 つのアダプタ共通。T-0622。ミャク楽 T-0594 / T-0600）。
   *
   * **中継を使わないときは素の fetch そのもの**（利用者の鍵で直接叩く経路の振る舞いは変えない。山内さん 2026-10-07）。
   *
   * 中継を使うとき:
   *   - 閾値（24 MiB）を超える本文は、`relay.stashBody` が在れば Storage に置いて在り処だけを送る。
   *     置ける上限（64 MiB）を超える本文は置かずに止める
   *   - 置く口が無ければ、上限（32 MiB）を超える本文は送らずに止める（送っても必ず落ちる）
   *   - fetch が応答を返さずに落ちたら（TypeError: Failed to fetch。ブラウザは理由を教えない）、送った大きさと
   *     理由の候補と次の一手を添えて投げ直す。素の文言のままだと、利用者も AI も同じ送信を繰り返すだけになる
   *     （ミャク楽 2026-10-02: 「続けてください」の繰り返し）
   *   - 中断（AbortError）はそのまま投げ直す（Engine が停止として扱う）
   */
  protected async postForStream(url: string, headers: any, payload: any, signal?: AbortSignal): Promise<Response> {
    let body = JSON.stringify(payload);
    if (!this.relay) return fetch(url, { method: 'POST', headers, body, signal });

    const bytes = new TextEncoder().encode(body).length;
    if (bytes > RELAY_STASH_THRESHOLD_BYTES && this.relay.stashBody) {
      if (bytes > RELAY_STORED_MAX_BYTES) throw new Error(requestTooLargeMessage(bytes, RELAY_STORED_MAX_BYTES));
      let path: string;
      try {
        path = await this.relay.stashBody(body, signal);
      } catch (err: any) {
        if (signal?.aborted || err?.name === 'AbortError') throw new DOMException('Aborted', 'AbortError');
        throw new Error(
          `Could not hand the request (about ${formatMB(bytes)} MB) to the LLM relay (${String(err?.message || err)}). ` +
            `Check your connection and try again.`,
        );
      }
      body = JSON.stringify({ [RELAY_STORED_BODY_FIELD]: { path } });
    } else if (bytes > RELAY_MAX_REQUEST_BYTES) {
      throw new Error(requestTooLargeMessage(bytes));
    }
    try {
      return await fetch(url, { method: 'POST', headers, body, signal });
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err;
      throw new Error(relayFetchFailedMessage(String(err?.message || err), bytes));
    }
  }

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
