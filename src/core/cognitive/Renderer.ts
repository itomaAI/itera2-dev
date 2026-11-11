/**
 * src/core/cognitive/Renderer.ts
 * Itera OS v2: 中立の要求 → 各社の本文（T-0804）
 *
 * 層の向きは一方向:  履歴（Projector）→ 中立の要求（LlmRequest）→ 各社の本文（ここ）→ 送信（Adapter）
 * ここが知っているのは各社のこと（部品の器・system の置き場・役割の並べ方・添付の上げ方と上限）だけ。
 * 履歴・エンジン・LPML は知らない。
 */

import type { VfsService } from '../vfs/VfsService';
import type { MediaRef } from '../types/content';
import type { Principal } from '../vfs/types';
import { blobToBase64 } from '../../utils/binary';
import type { RelayTransport } from './adapters/BaseAdapter';
import {
  isBlankMessage,
  isTextPart,
  LlmMediaError,
  type LlmMessage,
  type LlmRequest,
  type MediaFailure,
  type RenderEnv,
} from './LlmRequest';

export interface LlmCapabilities {
  maxMediaSizeMB: number;
  supportedMimes: string[];
  providerOptions?: Record<string, any>;
}

/**
 * 添付を組み立てられなかった理由。
 *
 * - `missing`: VFS に実体が無い
 * - `no_credentials`: 送信先へアップロードするための鍵が無い（未設定・失効など）
 * - `upload_failed`: アップロードそのものが失敗した
 */
export type MediaAttachFailure = 'missing' | 'no_credentials' | 'upload_failed';

/** Anthropic の document ブロックの `title`（ファイル名。パスの最後の段） */
export function documentTitle(path: string): string {
  return (path || '').split('/').pop() || path;
}

export type MediaAttachResult<T> = { ok: true; value: T } | { ok: false; reason: MediaAttachFailure };

/** base64 は 3 バイトを 4 文字にするので、送信サイズは元の 4/3 になる。 */
export const BASE64_EXPANSION_RATIO = 4 / 3;

/** 送信サイズの上限（base64 後・MB）から、VFS 上の実体に許される上限（MB）を求める。 */
export function rawLimitMBFromEncodedLimitMB(encodedLimitMB: number): number {
  return encodedLimitMB / BASE64_EXPANSION_RATIO;
}

export abstract class BaseRenderer {
  protected capabilities: LlmCapabilities;

  constructor(capabilities: LlmCapabilities) {
    this.capabilities = capabilities;
  }

  /** 中立の要求を、この上流の本文（Adapter に渡す形）にする。添付はここで解く。 */
  abstract render(request: LlmRequest, env: RenderEnv): Promise<any>;

  /** 文字の部品の器。 */
  protected abstract textPart(text: string): any;

  /** 送れると分かった添付を、この上流の部品にする（器の形が違うので、部品そのものを返す）。 */
  protected abstract resolveMedia(media: MediaRef, env: RenderEnv): Promise<MediaAttachResult<any>>;

  /**
   * 1 件のメッセージの部品を、この上流の器へ写す。
   *
   * 添付は門（MIME と大きさ）を通してから解く。送れなかった添付をどうするかは呼び手が決める
   * （`env.mediaFallback`）: 代わりの文が返ればそれを文字の部品として入れ、無ければ失敗する。
   * **黙って落とすことはしない。**
   */
  protected async renderParts(message: LlmMessage, env: RenderEnv): Promise<any[]> {
    const parts: any[] = [];
    for (const part of message.parts) {
      if (env.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (isTextPart(part)) {
        parts.push(this.textPart(part.text));
        continue;
      }

      const media = part.media;
      const support = await this.checkMediaSupport(env.vfs, media, env.principal);
      if (!support.supported) {
        const failure: MediaFailure =
          support.reason === 'size'
            ? { reason: 'size', limitMB: this.getMaxMediaSizeMB(media.mimeType) }
            : { reason: 'mime' };
        parts.push(this.textPart(this.unsendable(media, failure, env)));
        continue;
      }

      const resolved = await this.resolveMedia(media, env);
      if (resolved.ok) parts.push(resolved.value);
      else parts.push(this.textPart(this.unsendable(media, { reason: resolved.reason }, env)));
    }
    return parts;
  }

  private unsendable(media: MediaRef, failure: MediaFailure, env: RenderEnv): string {
    if (!env.mediaFallback) throw new LlmMediaError(media, failure);
    return env.mediaFallback(media, failure);
  }

  protected isSupportedMimeType(mimeType: string): boolean {
    if (!mimeType) return false;
    const baseMime = mimeType.split(';')[0].trim().toLowerCase();

    for (const pattern of this.capabilities.supportedMimes) {
      if (pattern === '*/*') return true;
      if (pattern.endsWith('/*')) {
        const typePrefix = pattern.split('/')[0];
        if (baseMime.startsWith(typePrefix + '/')) return true;
      } else if (pattern.endsWith('.*')) {
        const prefix = pattern.slice(0, -2);
        if (baseMime.startsWith(prefix)) return true;
      } else {
        if (baseMime === pattern.toLowerCase()) return true;
      }
    }
    return false;
  }

  /**
   * 種別ごとの上限（MB）。**VFS 上の実体の大きさ**で答える。
   *
   * 既定は capabilities の 1 つの値だが、上流によっては画像と文書で上限が違い、
   * さらに公表値が「送信サイズ（base64 後）」であることがある。そういう上流は
   * ここを上書きして、割り戻した値を返す。
   */
  protected getMaxMediaSizeMB(_mimeType: string): number {
    return this.capabilities.maxMediaSizeMB;
  }

  protected async checkMediaSupport(
    vfs: VfsService,
    mediaObj: MediaRef,
    principal: Principal,
  ): Promise<{ supported: boolean; reason?: 'mime' | 'size' }> {
    if (!this.isSupportedMimeType(mediaObj.mimeType)) {
      return { supported: false, reason: 'mime' };
    }

    try {
      const stat = vfs.stat(principal, mediaObj.path);
      const maxSizeBytes = this.getMaxMediaSizeMB(mediaObj.mimeType) * 1024 * 1024;
      if (stat.size > maxSizeBytes) {
        return { supported: false, reason: 'size' };
      }
    } catch (e) {
      // stat 失敗時はVFSに存在しないので、アップロード処理側で file not found として処理させる
    }

    return { supported: true };
  }

  protected async _blobToBase64(blob: Blob): Promise<string> {
    return blobToBase64(blob);
  }
}

// ==========================================
// Google Gemini
// ==========================================

export class GeminiRenderer extends BaseRenderer {
  private apiKey: string;
  /**
   * 中継（鍵が無いとき）。あれば添付を中継の Files 経路で運営の鍵へ上げる（T-0623。ミャク楽 T-0119）。
   * 鍵があるとき（利用者の鍵で直接叩く経路）はこれを見ない —— その経路の振る舞いは変えない。
   */
  private relay: RelayTransport | null;

  public static readonly DEFAULT_CAPABILITIES: LlmCapabilities = {
    maxMediaSizeMB: 100,
    supportedMimes: ['application/pdf', 'image/*', 'video/*', 'audio/*'],
  };

  /** Gemini の埋め込み（inlineData）は「要求全体で 20MB」（公式）。実体はその 3/4 までに収まっている必要がある。 */
  public static readonly INLINE_REQUEST_LIMIT_MB = 20;

  constructor(capabilities: Partial<LlmCapabilities> | undefined, apiKey: string, relay: RelayTransport | null = null) {
    super({
      ...GeminiRenderer.DEFAULT_CAPABILITIES,
      ...capabilities,
    } as LlmCapabilities);
    this.apiKey = apiKey;
    this.relay = relay;
  }

  /**
   * 中継の経路では、上げられなかったときに本文への埋め込み（inlineData）へ落とすので、
   * 大きさの判定は埋め込みの上限で行う（落としても上流に断られないように）。鍵があるときは従来どおり。
   */
  protected getMaxMediaSizeMB(_mimeType: string): number {
    if (this.apiKey || !this.relay) return this.capabilities.maxMediaSizeMB;
    return rawLimitMBFromEncodedLimitMB(GeminiRenderer.INLINE_REQUEST_LIMIT_MB);
  }

  async render(request: LlmRequest, env: RenderEnv): Promise<any> {
    const apiMessages: any[] = [];
    // system は先頭の user メッセージとして送る
    if (request.system !== undefined) apiMessages.push({ role: 'user', parts: [{ text: request.system }] });

    for (const message of request.messages) {
      if (env.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const parts = await this.renderParts(message, env);
      if (parts.length === 0) continue;
      apiMessages.push({ role: message.role === 'model' ? 'model' : 'user', parts: parts });
    }
    return apiMessages;
  }

  protected textPart(text: string): any {
    return { text: text };
  }

  protected resolveMedia(media: MediaRef, env: RenderEnv): Promise<MediaAttachResult<any>> {
    return this._resolveMediaPart(media, env);
  }

  /**
   * 添付を Gemini の part にする（`fileData` か `inlineData`。器の形が違うので呼び出し側に組ませない）。
   *
   * 鍵が無く中継があるとき（T-0623）: 控えの fileUri（metadata.gemini）は利用者自身の鍵で上げたもので、
   * 運営の鍵からは参照できない。中継の Files 経路で運営の鍵へ上げ直し、控えは別の場所（metadata.relay.gemini）に持つ。
   * 上げられなければ本文への埋め込みへ落とす。
   * それ以外（利用者の鍵で直接叩く・鍵も中継も無い）は従来どおり `_resolveMediaFile`。
   */
  private async _resolveMediaPart(mediaObj: any, env: RenderEnv): Promise<MediaAttachResult<any>> {
    if (!this.apiKey && this.relay) return this._resolveViaRelay(mediaObj, env, this.relay);
    const resolved = await this._resolveMediaFile(mediaObj, env);
    return resolved.ok ? { ok: true, value: { fileData: resolved.value } } : resolved;
  }

  /** 鍵が無いときの逃げ道。Files API を使わず、本文へ base64 で埋める（part そのものを返す）。 */
  private async _resolveInlineData(mediaObj: any, env: RenderEnv): Promise<MediaAttachResult<any>> {
    if (!env.vfs.exists(env.principal, mediaObj.path)) return { ok: false, reason: 'missing' };
    try {
      const blob = await env.vfs.readBlob(env.principal, mediaObj.path);
      const data = await this._blobToBase64(blob);
      const mimeType = mediaObj.mimeType || blob.type || 'application/octet-stream';
      return { ok: true, value: { inlineData: { mimeType, data } } };
    } catch (e) {
      console.error('[Renderer] Inline embedding failed:', e);
      return { ok: false, reason: 'missing' };
    }
  }

  /**
   * 中継の Files 経路で、運営の鍵の側へ上げる（T-0623。ミャク楽 T-0119）。
   *
   * 中継が代行するのは鍵の要る 1 回目（start）だけで、バイト本体は返ってきた
   * `x-goog-upload-url`（それ自体が資格である URL）へ直接送る。中継の 32 MiB に当たらない。
   *
   * 上げられなかったときは本文への埋め込みへ落とす（中継の Files 経路がまだ配信されていない間も添付は送れる）。
   * 大きさの判定は埋め込みの上限なので（getMaxMediaSizeMB）、落としても上流に断られない。
   */
  private async _resolveViaRelay(
    mediaObj: any,
    env: RenderEnv,
    relay: RelayTransport,
  ): Promise<MediaAttachResult<any>> {
    const cached = mediaObj.metadata?.relay?.gemini;
    if (cached && cached.fileUri && cached.expirationTime) {
      if (new Date(cached.expirationTime) > new Date(Date.now() + 60 * 60 * 1000)) {
        return { ok: true, value: { fileData: { fileUri: cached.fileUri, mimeType: mediaObj.mimeType } } };
      }
    }

    if (!env.vfs.exists(env.principal, mediaObj.path)) return { ok: false, reason: 'missing' };

    try {
      const blob = await env.vfs.readBlob(env.principal, mediaObj.path);
      const mimeType = mediaObj.mimeType || blob.type || 'application/octet-stream';
      const uploadResult = await this._uploadToGemini(
        blob,
        mimeType,
        {
          url: `${relay.baseUrl.replace(/\/+$/, '')}/google/upload/v1beta/files`,
          headers: await relay.getAuthHeaders(),
        },
        env.signal,
      );

      if (!mediaObj.metadata) mediaObj.metadata = {};
      mediaObj.metadata.relay = {
        ...(mediaObj.metadata.relay || {}),
        gemini: {
          fileUri: uploadResult.fileUri,
          expirationTime: uploadResult.expirationTime,
          name: uploadResult.name,
        },
      };
      return { ok: true, value: { fileData: { fileUri: uploadResult.fileUri, mimeType } } };
    } catch (e) {
      if (env.signal?.aborted) throw e;
      console.warn('[Renderer] Relay file upload failed; embedding inline instead:', e);
      return this._resolveInlineData(mediaObj, env);
    }
  }

  private async _resolveMediaFile(mediaObj: any, env: RenderEnv): Promise<MediaAttachResult<any>> {
    const apiKey = this.apiKey;
    const geminiMeta = mediaObj.metadata?.gemini;
    if (geminiMeta && geminiMeta.fileUri && geminiMeta.expirationTime) {
      if (new Date(geminiMeta.expirationTime) > new Date(Date.now() + 60 * 60 * 1000)) {
        return { ok: true, value: { fileUri: geminiMeta.fileUri, mimeType: mediaObj.mimeType } };
      }
    }

    if (!env.vfs.exists(env.principal, mediaObj.path)) return { ok: false, reason: 'missing' };
    // 鍵が未設定・失効なら上げられない。ここで黙って落とすと、添付を送ったつもりの
    // 利用者に何も知らせないまま応答が返る。
    if (!apiKey) return { ok: false, reason: 'no_credentials' };

    try {
      const blob = await env.vfs.readBlob(env.principal, mediaObj.path);
      const uploadResult = await this._uploadToGemini(
        blob,
        mediaObj.mimeType,
        { url: `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`, headers: {} },
        env.signal,
      );

      if (!mediaObj.metadata) mediaObj.metadata = {};
      mediaObj.metadata.gemini = {
        fileUri: uploadResult.fileUri,
        expirationTime: uploadResult.expirationTime,
        name: uploadResult.name,
      };

      return { ok: true, value: { fileUri: uploadResult.fileUri, mimeType: mediaObj.mimeType } };
    } catch (e) {
      console.error('[Renderer] File upload failed:', e);
      return { ok: false, reason: 'upload_failed' };
    }
  }

  /**
   * 再開可能アップロード。1 回目（start）の宛先だけが経路で違う
   * （利用者の鍵なら Google へ直接・中継なら中継の Files 経路）。本体は返ってきた upload URL へ直接送る。
   */
  private async _uploadToGemini(
    blob: Blob,
    mimeType: string,
    init: { url: string; headers: Record<string, string> },
    signal?: AbortSignal,
  ): Promise<any> {
    const size = blob.size;
    const initRes = await fetch(init.url, {
      method: 'POST',
      headers: {
        ...init.headers,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': size.toString(),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: 'itera_media' } }),
      signal,
    });

    if (!initRes.ok) throw new Error(`Upload init failed (${initRes.status})`);

    const uploadUrl = initRes.headers.get('x-goog-upload-url');
    if (!uploadUrl) throw new Error('No upload URL returned');

    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Length': size.toString(),
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: blob,
      signal,
    });

    if (!uploadRes.ok) throw new Error(`Binary upload failed (${uploadRes.status})`);
    const result = await uploadRes.json();
    return {
      fileUri: result.file.uri,
      name: result.file.name,
      expirationTime: result.file.expirationTime,
    };
  }
}

// ==========================================
// OpenAI
// ==========================================

export class OpenAIRenderer extends BaseRenderer {
  public static readonly DEFAULT_CAPABILITIES: LlmCapabilities = {
    maxMediaSizeMB: 50,
    supportedMimes: [
      'image/*',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.*',
      'text/*',
      'application/json',
    ],
  };

  constructor(capabilities?: Partial<LlmCapabilities>) {
    super({
      ...OpenAIRenderer.DEFAULT_CAPABILITIES,
      ...capabilities,
    } as LlmCapabilities);
  }

  async render(request: LlmRequest, env: RenderEnv): Promise<any> {
    const apiMessages: any[] = [];

    if (request.system !== undefined) {
      apiMessages.push({
        role: 'system',
        content: request.system,
      });
    }

    for (const message of request.messages) {
      if (env.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      // 空白だけの発話は「無かったこと」にする（T-0074）。
      // 通信が切れると中身の無い model ターンが履歴に残ることがあり、
      // 空のテキストブロックを送ると Anthropic は履歴全体を拒む。
      if (isBlankMessage(message)) continue;
      const contentParts = await this.renderParts(message, env);
      if (contentParts.length === 0) continue;
      apiMessages.push({ role: message.role === 'model' ? 'assistant' : 'user', content: contentParts });
    }
    return apiMessages;
  }

  protected textPart(text: string): any {
    return { type: 'text', text: text };
  }

  protected async resolveMedia(media: MediaRef, env: RenderEnv): Promise<MediaAttachResult<any>> {
    if (media.mimeType?.startsWith('image/')) {
      const imgUrl = await this._resolveMediaDataUrl(media, env);
      return imgUrl.ok ? { ok: true, value: { type: 'image_url', image_url: { url: imgUrl.value } } } : imgUrl;
    }
    const fileData = await this._resolveFileData(media, env);
    return fileData.ok ? { ok: true, value: { type: 'file', file: fileData.value } } : fileData;
  }

  private async _resolveMediaDataUrl(mediaObj: any, env: RenderEnv): Promise<MediaAttachResult<string>> {
    if (!env.vfs.exists(env.principal, mediaObj.path)) return { ok: false, reason: 'missing' };
    const blob = await env.vfs.readBlob(env.principal, mediaObj.path);
    const base64 = await this._blobToBase64(blob);
    return { ok: true, value: `data:${mediaObj.mimeType || 'image/png'};base64,${base64}` };
  }

  private async _resolveFileData(mediaObj: any, env: RenderEnv): Promise<MediaAttachResult<any>> {
    if (!env.vfs.exists(env.principal, mediaObj.path)) return { ok: false, reason: 'missing' };
    const blob = await env.vfs.readBlob(env.principal, mediaObj.path);
    const base64 = await this._blobToBase64(blob);
    const filename = mediaObj.path.split('/').pop() || 'file';

    const mimeType = mediaObj.mimeType || 'application/octet-stream';
    const dataUri = `data:${mimeType};base64,${base64}`;

    return {
      ok: true,
      value: {
        filename: filename,
        file_data: dataUri,
      },
    };
  }
}

// ==========================================
// Anthropic
// ==========================================

export class AnthropicRenderer extends BaseRenderer {
  /** 埋め込みの上限（base64 後）。画像はバイト、文書は MB で公表されている。 */
  public static readonly INLINE_IMAGE_LIMIT_BYTES = 5_242_880;
  public static readonly INLINE_DOCUMENT_LIMIT_MB = 32;

  public static readonly DEFAULT_CAPABILITIES: LlmCapabilities = {
    // 添付は本文に base64 で載せる。Files API（別端点）はブラウザから叩けないため使わない。
    // 実効の上限は種別ごとに getMaxMediaSizeMB() が決める。ここは緩い側（文書）を
    // 割り戻した値で、表示と既定のためだけに置いている。
    maxMediaSizeMB: rawLimitMBFromEncodedLimitMB(32),
    supportedMimes: ['image/*', 'application/pdf', 'text/plain'],
  };

  /**
   * Anthropic は画像と文書で上限が違い、どちらも**送信サイズ（base64 後）**で公表されている。
   * VFS 上の実体に許してよい大きさはその 3/4 になる。
   *
   * ミャク楽側は同じ関数を `if (this.apiKey)` で分岐させているが、こちらは Files API を
   * 使わない（鍵を持たない）ので、常に埋め込みの上限でよい。
   */
  protected getMaxMediaSizeMB(mimeType: string): number {
    const encodedLimitMB = (mimeType || '').startsWith('image/')
      ? AnthropicRenderer.INLINE_IMAGE_LIMIT_BYTES / (1024 * 1024)
      : AnthropicRenderer.INLINE_DOCUMENT_LIMIT_MB;
    return rawLimitMBFromEncodedLimitMB(encodedLimitMB);
  }

  /**
   * 中継（鍵が無いとき）。あれば添付を中継の Files 経路で運営の鍵へ上げる（T-0623。ミャク楽 T-0119）。
   * 利用者の鍵で直接叩く経路は本文への埋め込みのまま（下の注記のとおり Files API はブラウザから叩けない）。
   */
  private relay: RelayTransport | null;

  constructor(capabilities: Partial<LlmCapabilities> | undefined, relay: RelayTransport | null = null) {
    super({
      ...AnthropicRenderer.DEFAULT_CAPABILITIES,
      ...capabilities,
    } as LlmCapabilities);
    this.relay = relay;
  }

  async render(request: LlmRequest, env: RenderEnv): Promise<any> {
    const rawMessages: any[] = [];

    for (const message of request.messages) {
      if (env.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      // 空白だけの発話は「無かったこと」にする（T-0074）。
      // Anthropic は空のテキストブロックを含む履歴を 400 で拒む。
      if (isBlankMessage(message)) continue;
      const contentParts = await this.renderParts(message, env);
      if (contentParts.length === 0) continue;
      rawMessages.push({ role: message.role === 'model' ? 'assistant' : 'user', content: contentParts });
    }

    // Role Alternating Constraint
    const mergedMessages: any[] = [];
    for (const msg of rawMessages) {
      if (mergedMessages.length === 0) {
        if (msg.role === 'assistant') {
          mergedMessages.push({
            role: 'user',
            content: [{ type: 'text', text: '[System: Internal initialization]' }],
          });
        }
        mergedMessages.push(msg);
      } else {
        const lastMsg = mergedMessages[mergedMessages.length - 1];
        if (lastMsg.role === msg.role) {
          lastMsg.content = lastMsg.content.concat(msg.content);
        } else {
          mergedMessages.push(msg);
        }
      }
    }

    return { system: request.system, messages: mergedMessages };
  }

  protected textPart(text: string): any {
    return { type: 'text', text: text };
  }

  protected resolveMedia(media: MediaRef, env: RenderEnv): Promise<MediaAttachResult<any>> {
    return this._resolveMediaFileAnthropic(media, env);
  }

  /**
   * 添付を Anthropic の content ブロックへ変換する。
   *
   * **本文に base64 で載せる。** Files API（`POST /v1/files`）は別端点で、
   * ブラウザからの呼び出しを許していない（正しいブラウザ用ヘッダを付けても
   * `Disallowed CORS origin` を返す。2026-08-25 実測）。プロキシを挟めば通せるが、
   * 添付のためだけにプロキシを必須にするのは、ブラウザ単独で動くという目的に反する。
   *
   * 副産物として、`file_id` を履歴に焼き込むことで生じる面倒も消える ——
   * 上げたファイルには寿命があり、失効・削除された添付を 1 つでも参照すると、
   * そのリクエストは推論の前に丸ごと失敗する（履歴は毎ターン送り直すので、会話が死ぬ）。
   */
  private async _resolveMediaFileAnthropic(mediaObj: any, env: RenderEnv): Promise<MediaAttachResult<any>> {
    // 中継があるときだけ、運営の鍵の側の Files API を中継経由で使う（T-0623）。無ければ従来どおり埋め込み
    if (this.relay) return this._resolveAnthropicViaRelay(mediaObj, env, this.relay);
    return this._resolveInlineBlock(mediaObj, env);
  }

  /** 本文へ埋め込む（従来の経路そのもの）。 */
  private async _resolveInlineBlock(mediaObj: any, env: RenderEnv): Promise<MediaAttachResult<any>> {
    if (!env.vfs.exists(env.principal, mediaObj.path)) return { ok: false, reason: 'missing' };
    if (env.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    try {
      const blob = await env.vfs.readBlob(env.principal, mediaObj.path);
      const mimeType = mediaObj.mimeType || blob.type;

      // 器は種別ごとに違う。text/* は base64 の document として受け取ってもらえない
      // （`source.type` が `'text'`）ので、そこだけ生の本文を渡す。
      if (mimeType.startsWith('text/')) {
        const text = await blob.text();
        return {
          ok: true,
          value: {
            type: 'document',
            source: { type: 'text', media_type: 'text/plain', data: text },
            title: documentTitle(mediaObj.path),
          },
        };
      }

      const base64 = await this._blobToBase64(blob);
      return { ok: true, value: this._buildAnthropicContentBlock(base64, mimeType, documentTitle(mediaObj.path)) };
    } catch (e) {
      console.error('[Renderer] Anthropic media encode failed:', e);
      return { ok: false, reason: 'missing' };
    }
  }

  /**
   * 中継の Files 経路で、運営の鍵の側へ上げる（T-0623。ミャク楽 T-0119）。
   *
   * バイトは中継を通る（Anthropic には Gemini のような直接の上げ先が無い）。中継の上限は 24 MiB だが、
   * 大きさの判定は埋め込みの上限（画像 3.75MB・文書 24MB。getMaxMediaSizeMB）のままにしてある。
   * そのため上げられなかったときに本文への埋め込みへ落としても、上流に断られない。
   * text/* は Files に上げる利点が無い（小さく、本文として渡せる）ので、埋め込みのまま。
   * 控えは `metadata.relay.anthropic`（利用者自身の鍵の控えと混ぜない）。あれば上げ直さない ——
   * 参照が会話の中で変わらないので、プロンプトキャッシュが外れない。
   */
  private async _resolveAnthropicViaRelay(
    mediaObj: any,
    env: RenderEnv,
    relay: RelayTransport,
  ): Promise<MediaAttachResult<any>> {
    if ((mediaObj.mimeType || '').startsWith('text/')) return this._resolveInlineBlock(mediaObj, env);

    const cached = mediaObj.metadata?.relay?.anthropic;
    if (cached && cached.fileId) {
      return {
        ok: true,
        value: this._buildAnthropicFileBlock(cached.fileId, mediaObj.mimeType, documentTitle(mediaObj.path)),
      };
    }

    if (!env.vfs.exists(env.principal, mediaObj.path)) return { ok: false, reason: 'missing' };
    if (env.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    try {
      const blob = await env.vfs.readBlob(env.principal, mediaObj.path);
      const mimeType = mediaObj.mimeType || blob.type || 'application/octet-stream';
      if (mimeType.startsWith('text/')) return this._resolveInlineBlock(mediaObj, env);
      const filename = mediaObj.path.split('/').pop() || 'file';

      const formData = new FormData();
      formData.append('file', blob as Blob, filename);
      const response = await fetch(`${relay.baseUrl.replace(/\/+$/, '')}/anthropic/v1/files`, {
        method: 'POST',
        headers: {
          ...(await relay.getAuthHeaders()),
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'files-api-2025-04-14',
        },
        body: formData,
        signal: env.signal,
      });
      if (!response.ok) {
        throw new Error(`Relay Anthropic upload failed (${response.status}): ${await response.text()}`);
      }
      const uploaded = await response.json();
      if (!uploaded?.id) throw new Error('Relay Anthropic upload returned no file id');

      if (!mediaObj.metadata) mediaObj.metadata = {};
      mediaObj.metadata.relay = { ...(mediaObj.metadata.relay || {}), anthropic: { fileId: uploaded.id } };
      return { ok: true, value: this._buildAnthropicFileBlock(uploaded.id, mimeType, documentTitle(mediaObj.path)) };
    } catch (e) {
      if (env.signal?.aborted) throw e;
      console.warn('[Renderer] Relay file upload failed; embedding inline instead:', e);
      return this._resolveInlineBlock(mediaObj, env);
    }
  }

  /** Files API に上げた添付を指すブロック（`source.type: 'file'`）。 */
  private _buildAnthropicFileBlock(fileId: string, mimeType: string, title?: string): any {
    if ((mimeType || '').startsWith('image/')) return { type: 'image', source: { type: 'file', file_id: fileId } };
    return { type: 'document', source: { type: 'file', file_id: fileId }, ...(title ? { title } : {}) };
  }

  /** 文書（PDF など）には `title` を付ける —— 無いと上流が 'file' と呼び、どの添付か並び順でしか分からない（T-0690）。画像には無い */
  private _buildAnthropicContentBlock(base64: string, mimeType: string, title?: string): any {
    if (mimeType.startsWith('image/')) {
      return { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } };
    }
    return {
      type: 'document',
      source: { type: 'base64', media_type: mimeType, data: base64 },
      ...(title ? { title } : {}),
    };
  }
}
