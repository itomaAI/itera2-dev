/**
 * src/core/cognitive/adapters/GeminiInteractionsAdapter.ts
 * Itera OS v2: Google Gemini を Interactions API（`POST /v1beta/interactions`）で呼ぶアダプタ（T-0853）
 *
 * `llm.json` の `geminiApi: "interactions"` のときだけ、**利用者の鍵で直接叩く経路**で使う。
 * 中継の経路と既定（`geminiApi` が無い）は従来の GeminiAdapter（streamGenerateContent）のまま。
 *
 * 受け取る本文は GeminiRenderer が作る contents（generateContent の形）そのもの。ここで Interactions の
 * steps（`user_input` / `model_output`）に詰め替える。Projector・Renderer には手を入れない。
 *
 * 会話の鎖（`previous_interaction_id`）:
 *   - 生成が終わるたびに「送った会話＋返した応答」の指紋（先頭からの累積ハッシュ）と interaction の id を覚える
 *   - 次の要求の先頭がそれと一致すれば、残り（新しいターン）だけを id 付きで送る。上流はその会話（思考を含む）を引き継ぐ
 *   - 一致しなければ全部を送る（新しい鎖）。圧縮・リセット・履歴の削除・モデルの切り替え・添付の上げ直しで
 *     先頭が変わったときは、ここに倒れる
 *   - 覚えた id が上流で見つからなければ（404。保存期間切れなど）、本文が流れ始める前に全部を送り直す
 *   覚えるのはこのモジュールの中だけ（再読み込みで消える ＝ 次の 1 回は全部を送る）。
 *   Engine の履歴はモデルの出力をそのまま残す（T-0593）ので、送った応答と履歴のモデルのターンは一致する。
 *
 * 引き継いだ会話も入力として数えられる（2026-11-14 の実測: 鎖でも全部でも total_input_tokens と
 * total_cached_tokens はほぼ同じ。鎖は前のターンの思考の分だけ多い）。費用を下げる仕組みではない。
 * 生の思考は返らない（要約だけ。ここでは要約も求めない）。
 */

import { BaseLLMAdapter, filterNestedObject, type LlmConfig, type LlmResult } from './BaseAdapter';
import type { SystemLogger } from '../../state/SystemLogger';

export const GEMINI_INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';

/** `llm.json` でこのアダプタを選ぶ値（`geminiApi`） */
export const GEMINI_API_INTERACTIONS = 'interactions';

export interface InteractionsStep {
  type: 'user_input' | 'model_output';
  content: any[];
}

/** 添付の MIME から、Interactions の部品の種類を決める */
export function interactionsMediaType(mimeType: string): 'image' | 'audio' | 'video' | 'document' {
  const base = String(mimeType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (base.startsWith('image/')) return 'image';
  if (base.startsWith('audio/')) return 'audio';
  if (base.startsWith('video/')) return 'video';
  return 'document';
}

/**
 * generateContent の part 1 つを、Interactions の content 1 つにする。知らない形は null（落とす）。
 * 空の文字は落とす: Interactions は `{type:'text', text:''}` を 400（Missing text in content of type text.）で断る
 * （2026-11-14 実測。中身の無いモデルのターンは generateContent では `{text:''}` のまま通っていた）。content が空の step は通る。
 */
export function toInteractionsContent(part: any): any | null {
  if (part && typeof part.text === 'string') return part.text === '' ? null : { type: 'text', text: part.text };
  if (part && part.fileData && part.fileData.fileUri) {
    const mime = part.fileData.mimeType || '';
    return { type: interactionsMediaType(mime), uri: part.fileData.fileUri, ...(mime ? { mime_type: mime } : {}) };
  }
  if (part && part.inlineData && typeof part.inlineData.data === 'string') {
    const mime = part.inlineData.mimeType || 'application/octet-stream';
    return { type: interactionsMediaType(mime), data: part.inlineData.data, mime_type: mime };
  }
  return null;
}

/** generateContent の contents を、Interactions の input（steps の並び）にする */
export function toInteractionsSteps(contents: any[]): InteractionsStep[] {
  return contents.map((message: any) => ({
    type: message?.role === 'model' ? 'model_output' : 'user_input',
    content: (Array.isArray(message?.parts) ? message.parts : [])
      .map(toInteractionsContent)
      .filter((c: any) => c !== null),
  }));
}

/**
 * 設定（llm.json・各アプリの generationConfig。generateContent の名前）から Interactions の generation_config を作る。
 * 送る鍵は従来の経路と同じ考え方で絞る（temperature などは送らない。GeminiAdapter の注記を参照）。
 */
export function toInteractionsGenerationConfig(config: LlmConfig): {
  generation_config: Record<string, any>;
  response_format?: Record<string, any>;
} {
  const userGenConfig =
    typeof config.generationConfig === 'object' && config.generationConfig !== null ? config.generationConfig : {};
  const src = filterNestedObject(
    { ...config, ...userGenConfig },
    {
      maxOutputTokens: null,
      stopSequences: null,
      responseMimeType: null,
      responseSchema: null,
      thinkingConfig: { thinkingLevel: null },
    },
  );

  const generation_config: Record<string, any> = {
    max_output_tokens: src.maxOutputTokens !== undefined ? src.maxOutputTokens : 65536,
  };
  if (Array.isArray(src.stopSequences) && src.stopSequences.length > 0)
    generation_config.stop_sequences = src.stopSequences;
  if (src.thinkingConfig?.thinkingLevel)
    generation_config.thinking_level = String(src.thinkingConfig.thinkingLevel).toLowerCase();

  if (src.responseMimeType || src.responseSchema) {
    return {
      generation_config,
      response_format: {
        type: 'text',
        ...(src.responseMimeType ? { mime_type: src.responseMimeType } : {}),
        ...(src.responseSchema ? { schema: src.responseSchema } : {}),
      },
    };
  }
  return { generation_config };
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 先頭から i+1 件までの会話の指紋（累積ハッシュ）。`digests[i]` が contents[0..i] に対応する */
export async function prefixDigests(contents: any[], seed = ''): Promise<string[]> {
  const out: string[] = [];
  let prev = seed;
  for (const message of contents) {
    prev = await sha256Hex(`${prev}\u0000${JSON.stringify(message)}`);
    out.push(prev);
  }
  return out;
}

/** 覚えている鎖の 1 本: 「この会話（length 件・指紋 digest）の続きは interactionId に在る」 */
export interface InteractionLink {
  scope: string;
  length: number;
  digest: string;
  interactionId: string;
}

/**
 * 覚えている鎖の表。会話は分かれることがある（ターンを消して送り直す・別の呼び手）ので、最後の 1 本ではなく数本を持ち、
 * 先頭がいちばん長く一致するものを使う。古いものから捨てる。
 */
export class InteractionChains {
  private links: InteractionLink[] = [];
  private readonly max: number;

  constructor(max = 32) {
    this.max = max;
  }

  /** contents の指紋の並びに対し、続きを送れる鎖（少なくとも 1 件の新しいターンが残るもの）を探す */
  find(scope: string, digests: string[]): InteractionLink | null {
    let best: InteractionLink | null = null;
    for (const link of this.links) {
      if (link.scope !== scope) continue;
      if (link.length < 1 || link.length >= digests.length) continue;
      if (digests[link.length - 1] !== link.digest) continue;
      if (!best || link.length > best.length) best = link;
    }
    return best;
  }

  remember(link: InteractionLink): void {
    this.links = this.links.filter((l) => !(l.scope === link.scope && l.digest === link.digest));
    this.links.push(link);
    if (this.links.length > this.max) this.links.splice(0, this.links.length - this.max);
  }

  forget(interactionId: string): void {
    this.links = this.links.filter((l) => l.interactionId !== interactionId);
  }

  clear(): void {
    this.links = [];
  }

  get size(): number {
    return this.links.length;
  }
}

/** モジュールで 1 つ。アダプタは設定が変わるたびに作り直される（CognitiveManager.refreshEngineConfig）ので、表はここに置く */
export const sharedInteractionChains = new InteractionChains();

/**
 * Interactions の状態を、これまでの止まった理由の語（generateContent の finishReason）に寄せる。
 * ゲストは /max/i で「出力の上限で止まった」を見ている。
 *   - completed → STOP
 *   - incomplete → MAX_TOKENS（2026-11-14 実測: max_output_tokens に達すると incomplete と continuation_token が返る）
 *   - それ以外はそのまま
 */
export function interactionsStopReason(status: string | null): string | null {
  if (!status) return null;
  if (status === 'completed') return 'STOP';
  if (status === 'incomplete') return 'MAX_TOKENS';
  return status;
}

export class GeminiInteractionsAdapter extends BaseLLMAdapter {
  private apiKey: string;
  private modelName: string;
  private chains: InteractionChains;
  private endpoint: string;

  constructor(
    apiKey: string,
    modelName: string = 'gemini-3.8-flash',
    config: LlmConfig = {},
    logger: SystemLogger | null = null,
    chains: InteractionChains = sharedInteractionChains,
    endpoint: string = GEMINI_INTERACTIONS_URL,
  ) {
    super(config, logger, null);
    this.apiKey = apiKey;
    this.modelName = modelName;
    this.chains = chains;
    this.endpoint = endpoint;
  }

  protected async stream(messages: any, onChunk: (text: string) => void, signal?: AbortSignal): Promise<LlmResult> {
    if (!this.apiKey) throw new Error('API Key is missing.');
    const contents: any[] = Array.isArray(messages) ? messages : [];

    // 鍵ごと・モデルごとに鎖を分ける（別の鍵からは interaction が見えない。モデルを変えたら新しい鎖から）
    const scope = `${this.modelName}\u0000${(await sha256Hex(this.apiKey)).slice(0, 16)}`;
    const digests = await prefixDigests(contents);
    const link = this.chains.find(scope, digests);

    const { generation_config, response_format } = toInteractionsGenerationConfig(this.config);
    const base: Record<string, any> = {
      model: this.modelName,
      generation_config,
      ...(response_format ? { response_format } : {}),
      stream: true,
    };
    const url = `${this.endpoint}?key=${this.apiKey}`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const full = () => ({ ...base, input: toInteractionsSteps(contents) });

    let response = await this.postForStream(
      url,
      headers,
      link
        ? {
            ...base,
            previous_interaction_id: link.interactionId,
            input: toInteractionsSteps(contents.slice(link.length)),
          }
        : full(),
      signal,
    );

    if (link && !response.ok && (response.status === 404 || response.status === 400)) {
      // 覚えた id が上流に無い（保存期間切れ・別の鍵など）。本文はまだ流れていないので、全部を送り直す
      try {
        await response.text();
      } catch (e) {}
      this.chains.forget(link.interactionId);
      response = await this.postForStream(url, headers, full(), signal);
    }

    await this.checkError(response, 'Gemini');

    const reader = response.body!.getReader();
    const stepTypes = new Map<number, string>();
    let interactionId: string | null = null;
    let status: string | null = null;
    /** interaction.completed を受け取ったか（途中で途切れた流れを鎖として覚えない） */
    let completed = false;
    let usage: any = null;
    let text = '';

    try {
      for await (const line of this.readSSELines(reader, signal)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const dataStr = trimmed.slice(5).trim();
        if (!dataStr || dataStr === '[DONE]') continue;

        let event: any;
        try {
          event = JSON.parse(dataStr);
        } catch (e) {
          console.warn('[GeminiInteractionsAdapter] Stream JSON parse warning:', e);
          continue;
        }

        if (event?.error) {
          const msg = event.error.message || JSON.stringify(event.error);
          throw new Error(`Gemini API Error (stream): ${msg}`);
        }

        switch (event?.event_type) {
          case 'interaction.created':
            if (event.interaction?.id) interactionId = event.interaction.id;
            break;
          case 'interaction.status_update':
            if (typeof event.status === 'string') status = event.status;
            break;
          case 'step.start':
            if (typeof event.index === 'number') stepTypes.set(event.index, event.step?.type || '');
            break;
          case 'step.delta': {
            const delta = event.delta;
            if (!delta || delta.type !== 'text' || typeof delta.text !== 'string' || !delta.text) break;
            // 本文は model_output の中の文字だけ（思考の要約・署名は流さない）
            const stepType = typeof event.index === 'number' ? stepTypes.get(event.index) : undefined;
            if (stepType !== undefined && stepType !== 'model_output') break;
            this.markContentStarted();
            text += delta.text;
            onChunk(delta.text);
            break;
          }
          case 'interaction.completed':
            completed = true;
            if (event.interaction?.id) interactionId = event.interaction.id;
            if (typeof event.interaction?.status === 'string') status = event.interaction.status;
            if (event.interaction?.usage) usage = event.interaction.usage;
            break;
          default:
            break;
        }
      }
    } finally {
      reader.releaseLock();
    }

    // failed: Gemini 4 Hydrogen は文字を流したあとで failed に終わることがある（2026-11-14 実測 3/8。usage は 0・理由は無い。
    // generateContent では MALFORMED_FUNCTION_CALL の finishReason に当たるもの）。従来の経路はこれを普通の終わりとして返し、
    // Engine は流れた文字を読んでいた。それに揃え、文字が流れていれば返す（止まった理由に failed を置く）。何も流れていなければ投げる。
    if (status === 'cancelled' || (status === 'failed' && text === '')) {
      throw new Error(`Gemini API Error (interaction ${status}).`);
    }

    // 送った会話＋この応答を覚える。履歴にはこの応答がそのまま 1 つのモデルのターンとして入る（GeminiRenderer の形）。
    // 続きを頼めるのは、上流が会話を保存し終えた interaction だけ（completed・incomplete）
    if (completed && interactionId && (status === 'completed' || status === 'incomplete') && !signal?.aborted) {
      const last = digests.length > 0 ? digests[digests.length - 1] : '';
      const [digest] = await prefixDigests([{ role: 'model', parts: [{ text }] }], last);
      this.chains.remember({ scope, length: contents.length + 1, digest, interactionId });
    }

    const result: LlmResult = {
      provider: 'google',
      model: this.modelName,
      usage: null,
      stopReason: interactionsStopReason(status),
    };
    if (usage) {
      const cached = usage.total_cached_tokens || 0;
      const promptTotal = usage.total_input_tokens || 0;
      const output = usage.total_output_tokens || 0;
      result.usage = {
        input: Math.max(0, promptTotal - cached),
        cached,
        // Gemini はキャッシュへの書き込みを別に報告しない
        cacheWrite: 0,
        output,
        total: usage.total_tokens || promptTotal + output,
      };
    }
    return result;
  }
}
