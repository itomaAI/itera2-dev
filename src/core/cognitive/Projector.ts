/**
 * src/core/cognitive/Projector.ts
 * Itera OS v2: State to Prompt Conversion
 */

import type { VfsService } from '../vfs/VfsService';
import type { ConfigManager } from '../sys/ConfigManager';
import type { HistoryManager, Turn } from '../state/HistoryManager';
import type { MediaRef } from '../types/content';
import type { Principal } from '../vfs/types';
import { buildTextPromptNodes, buildToolPromptNodes, buildUserPromptNodes } from './PromptContentBuilder';
import { wrapUserInput } from './LpmlSerializer';
import { SYSTEM_PRINCIPAL } from '../vfs/types';
import { blobToBase64 } from '../../utils/binary';

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

export type MediaAttachResult<T> = { ok: true; value: T } | { ok: false; reason: MediaAttachFailure };

/**
 * 添付を付けられなかったときに、代わりにプロンプトへ入れる注記。
 *
 * **黙って落とさないこと**と、**理由を取り違えないこと**の両方が要る。
 * 「VFS から読めなかった」と誤って出すと、実際には鍵が無いだけなのに保存先を疑わせる。
 */
export function buildMediaFailureNotice(path: string, reason: MediaAttachFailure): string {
  switch (reason) {
    case 'no_credentials':
      return `\n[System: The file '${path}' was NOT sent. This provider needs a file-upload API key, which is not configured or has expired.]\n`;
    case 'upload_failed':
      return `\n[System: The file '${path}' was NOT sent. Uploading it to the provider failed.]\n`;
    case 'missing':
    default:
      return `\n[System: The file '${path}' was NOT sent. It could not be loaded from VFS.]\n`;
  }
}

/** base64 は 3 バイトを 4 文字にするので、送信サイズは元の 4/3 になる。 */
export const BASE64_EXPANSION_RATIO = 4 / 3;

/** 送信サイズの上限（base64 後・MB）から、VFS 上の実体に許される上限（MB）を求める。 */
export function rawLimitMBFromEncodedLimitMB(encodedLimitMB: number): number {
  return encodedLimitMB / BASE64_EXPANSION_RATIO;
}

/** 上限を表示用に丸める（3.75 のような値も、無駄な桁を付けずに出す）。 */
function formatLimitMB(mb: number): string {
  return String(Math.round(mb * 100) / 100);
}

export abstract class BaseProjector {
  protected systemPrompt: string;
  protected capabilities: LlmCapabilities;

  constructor(systemPrompt: string, capabilities: LlmCapabilities) {
    this.systemPrompt = systemPrompt;
    this.capabilities = capabilities;
  }

  abstract createContext(
    state: {
      history: HistoryManager;
      vfs: VfsService;
      configManager: ConfigManager;
    },
    signal?: AbortSignal,
  ): Promise<any>;

  protected _buildSystemPrompt(configManager: ConfigManager, history: HistoryManager): string {
    const prefs = configManager.get('preferences');
    const user = prefs?.username || 'User';
    const agent = prefs?.agentName || 'Itera';
    const language = prefs?.language || 'English';

    let effectivePrompt = this.systemPrompt.replace(/{{language}}/g, language);
    effectivePrompt = effectivePrompt.replace(/{{agentName}}/g, agent);
    effectivePrompt = effectivePrompt.replace(/{{username}}/g, user);

    const turns = history.get();
    const firstTurn = turns.length > 0 ? turns[0] : null;
    const sessionStart = firstTurn ? new Date(firstTurn.timestamp) : new Date();

    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const timePrompt = `\n\n<system type="time">\nSession Started: ${sessionStart.toLocaleString()} (${days[sessionStart.getDay()]})\nTimestamp: ${sessionStart.toISOString()}\n</system>`;

    return effectivePrompt + timePrompt;
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

  protected getUnsupportedMessage(path: string, mimeType: string, reason: 'mime' | 'size'): string {
    const reasonText =
      reason === 'size'
        ? `it exceeds the file size limit (${formatLimitMB(this.getMaxMediaSizeMB(mimeType))}MB)`
        : `its format is not directly supported by this model's vision/file API`;

    return `\n[System: Attached file '${path}' (${mimeType}) cannot be processed directly because ${reasonText}. To analyze its content, please write and execute a script to process it from the VFS.]\n`;
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

export class GeminiProjector extends BaseProjector {
  private apiKey: string;

  public static readonly DEFAULT_CAPABILITIES: LlmCapabilities = {
    maxMediaSizeMB: 100,
    supportedMimes: ['application/pdf', 'image/*', 'video/*', 'audio/*'],
  };

  constructor(systemPrompt: string, capabilities: Partial<LlmCapabilities> | undefined, apiKey: string) {
    super(systemPrompt, {
      ...GeminiProjector.DEFAULT_CAPABILITIES,
      ...capabilities,
    } as LlmCapabilities);
    this.apiKey = apiKey;
  }

  async createContext(
    state: {
      history: HistoryManager;
      vfs: VfsService;
      configManager: ConfigManager;
    },
    signal?: AbortSignal,
  ): Promise<any> {
    const historyData = state.history.get();
    const history = [...historyData];

    const apiMessages: any[] = [];
    const dynamicPrompt = this._buildSystemPrompt(state.configManager, state.history);
    apiMessages.push({ role: 'user', parts: [{ text: dynamicPrompt }] });

    for (const turn of history) {
      if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const parts = await this._convertTurnToParts(turn, state.vfs, this.apiKey, signal);
      if (!parts || parts.length === 0) continue;

      let apiRole = 'user';
      if (turn.role === 'model') apiRole = 'model';
      apiMessages.push({ role: apiRole, parts: parts });
    }
    return apiMessages;
  }

  private async _convertTurnToParts(turn: Turn, vfs: VfsService, apiKey: string, signal?: AbortSignal): Promise<any[]> {
    if (typeof turn.content === 'string') {
      let text = turn.content;
      if (turn.role === 'user') text = wrapUserInput(text);
      return [{ text: text }];
    }

    if (Array.isArray(turn.content)) {
      if (turn.meta && turn.meta.type === 'tool_execution') {
        const parts: any[] = [];
        for (const node of buildToolPromptNodes(turn)) {
          if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
          if (!node.shouldEmit) continue;

          parts.push({ text: node.text });

          if (node.media) {
            const support = await this.checkMediaSupport(vfs, node.media, SYSTEM_PRINCIPAL);
            if (support.supported) {
              const fileData = await this._resolveMediaFile(node.media, vfs, apiKey, signal);
              if (fileData.ok) parts.push({ fileData: fileData.value });
              else parts.push({ text: buildMediaFailureNotice(node.media.path, fileData.reason) });
            } else {
              parts.push({
                text: this.getUnsupportedMessage(node.media.path, node.media.mimeType, support.reason!),
              });
            }
          }
        }
        return parts;
      }

      if (turn.role === 'user') {
        const parts: any[] = [];

        for (const node of buildUserPromptNodes(turn)) {
          if (node.kind === 'text') {
            parts.push({ text: node.text });
            continue;
          }

          const support = await this.checkMediaSupport(vfs, node.media, SYSTEM_PRINCIPAL);
          if (support.supported) {
            const fileData = await this._resolveMediaFile(node.media, vfs, apiKey, signal);
            if (fileData.ok) parts.push({ fileData: fileData.value });
            else parts.push({ text: buildMediaFailureNotice(node.media.path, fileData.reason) });
          } else {
            parts.push({
              text: this.getUnsupportedMessage(node.media.path, node.media.mimeType, support.reason!),
            });
          }
        }
        return parts;
      }

      return buildTextPromptNodes(turn).map((node) => ({ text: node.text }));
    }
    return [];
  }

  private async _resolveMediaFile(
    mediaObj: any,
    vfs: VfsService,
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<MediaAttachResult<any>> {
    const geminiMeta = mediaObj.metadata?.gemini;
    if (geminiMeta && geminiMeta.fileUri && geminiMeta.expirationTime) {
      if (new Date(geminiMeta.expirationTime) > new Date(Date.now() + 60 * 60 * 1000)) {
        return { ok: true, value: { fileUri: geminiMeta.fileUri, mimeType: mediaObj.mimeType } };
      }
    }

    if (!vfs.exists(SYSTEM_PRINCIPAL, mediaObj.path)) return { ok: false, reason: 'missing' };
    // 鍵が未設定・失効なら上げられない。ここで黙って落とすと、添付を送ったつもりの
    // 利用者に何も知らせないまま応答が返る。
    if (!apiKey) return { ok: false, reason: 'no_credentials' };

    try {
      const blob = await vfs.readBlob(SYSTEM_PRINCIPAL, mediaObj.path);
      const uploadResult = await this._uploadToGemini(blob, mediaObj.mimeType, apiKey, signal);

      if (!mediaObj.metadata) mediaObj.metadata = {};
      mediaObj.metadata.gemini = {
        fileUri: uploadResult.fileUri,
        expirationTime: uploadResult.expirationTime,
        name: uploadResult.name,
      };

      return { ok: true, value: { fileUri: uploadResult.fileUri, mimeType: mediaObj.mimeType } };
    } catch (e) {
      console.error('[Projector] File upload failed:', e);
      return { ok: false, reason: 'upload_failed' };
    }
  }

  private async _uploadToGemini(blob: Blob, mimeType: string, apiKey: string, signal?: AbortSignal): Promise<any> {
    const size = blob.size;
    const initUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`;
    const initRes = await fetch(initUrl, {
      method: 'POST',
      headers: {
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

export class OpenAIProjector extends BaseProjector {
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

  constructor(systemPrompt: string, capabilities?: Partial<LlmCapabilities>) {
    super(systemPrompt, {
      ...OpenAIProjector.DEFAULT_CAPABILITIES,
      ...capabilities,
    } as LlmCapabilities);
  }

  async createContext(
    state: {
      history: HistoryManager;
      vfs: VfsService;
      configManager: ConfigManager;
    },
    signal?: AbortSignal,
  ): Promise<any> {
    const history = [...state.history.get()];
    const apiMessages: any[] = [];

    apiMessages.push({
      role: 'system',
      content: this._buildSystemPrompt(state.configManager, state.history),
    });

    for (const turn of history) {
      if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const contentParts = await this._convertTurnToParts(turn, state.vfs, signal);
      if (!contentParts || contentParts.length === 0) continue;

      let apiRole = 'user';
      if (turn.role === 'model') apiRole = 'assistant';
      else if (turn.role === 'system') apiRole = 'user';

      apiMessages.push({ role: apiRole, content: contentParts });
    }
    return apiMessages;
  }

  private async _convertTurnToParts(turn: Turn, vfs: VfsService, signal?: AbortSignal): Promise<any[]> {
    if (typeof turn.content === 'string') {
      let text = turn.content;
      if (turn.role === 'user') text = wrapUserInput(text);
      // 空白だけの発話は「無かったこと」にする（T-0074）。
      // 通信が切れると中身の無い model ターンが履歴に残ることがあり、
      // 空のテキストブロックを送ると Anthropic は履歴全体を拒む。
      // 呼び出し側は「空の配列＝そのターンを送らない」として扱う。
      if (text.trim() === '') return [];
      return [{ type: 'text', text: text }];
    }

    if (Array.isArray(turn.content)) {
      if (turn.meta && turn.meta.type === 'tool_execution') {
        const parts: any[] = [];
        for (const node of buildToolPromptNodes(turn)) {
          if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
          if (!node.shouldEmit) continue;

          parts.push({
            type: 'text',
            text: node.text,
          });

          if (node.media) {
            const support = await this.checkMediaSupport(vfs, node.media, SYSTEM_PRINCIPAL);
            if (support.supported) {
              if (node.media.mimeType?.startsWith('image/')) {
                const imgUrl = await this._resolveMediaDataUrl(node.media, vfs);
                if (imgUrl.ok) parts.push({ type: 'image_url', image_url: { url: imgUrl.value } });
                else parts.push({ type: 'text', text: buildMediaFailureNotice(node.media.path, imgUrl.reason) });
              } else {
                const fileData = await this._resolveFileData(node.media, vfs);
                if (fileData.ok) parts.push({ type: 'file', file: fileData.value });
                else parts.push({ type: 'text', text: buildMediaFailureNotice(node.media.path, fileData.reason) });
              }
            } else {
              parts.push({
                type: 'text',
                text: this.getUnsupportedMessage(node.media.path, node.media.mimeType, support.reason!),
              });
            }
          }
        }
        return parts;
      }

      if (turn.role === 'user') {
        const parts: any[] = [];

        for (const node of buildUserPromptNodes(turn)) {
          if (node.kind === 'text') {
            parts.push({ type: 'text', text: node.text });
            continue;
          }

          const support = await this.checkMediaSupport(vfs, node.media, SYSTEM_PRINCIPAL);
          if (support.supported) {
            if (node.media.mimeType?.startsWith('image/')) {
              const imgUrl = await this._resolveMediaDataUrl(node.media, vfs);
              if (imgUrl.ok) parts.push({ type: 'image_url', image_url: { url: imgUrl.value } });
              else parts.push({ type: 'text', text: buildMediaFailureNotice(node.media.path, imgUrl.reason) });
            } else {
              const fileData = await this._resolveFileData(node.media, vfs);
              if (fileData.ok) parts.push({ type: 'file', file: fileData.value });
              else parts.push({ type: 'text', text: buildMediaFailureNotice(node.media.path, fileData.reason) });
            }
          } else {
            parts.push({
              type: 'text',
              text: this.getUnsupportedMessage(node.media.path, node.media.mimeType, support.reason!),
            });
          }
        }
        return parts;
      }

      return buildTextPromptNodes(turn).map((node) => ({ type: 'text', text: node.text }));
    }
    return [];
  }

  private async _resolveMediaDataUrl(mediaObj: any, vfs: VfsService): Promise<MediaAttachResult<string>> {
    if (!vfs.exists(SYSTEM_PRINCIPAL, mediaObj.path)) return { ok: false, reason: 'missing' };
    const blob = await vfs.readBlob(SYSTEM_PRINCIPAL, mediaObj.path);
    const base64 = await this._blobToBase64(blob);
    return { ok: true, value: `data:${mediaObj.mimeType || 'image/png'};base64,${base64}` };
  }

  private async _resolveFileData(mediaObj: any, vfs: VfsService): Promise<MediaAttachResult<any>> {
    if (!vfs.exists(SYSTEM_PRINCIPAL, mediaObj.path)) return { ok: false, reason: 'missing' };
    const blob = await vfs.readBlob(SYSTEM_PRINCIPAL, mediaObj.path);
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

export class AnthropicProjector extends BaseProjector {
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
      ? AnthropicProjector.INLINE_IMAGE_LIMIT_BYTES / (1024 * 1024)
      : AnthropicProjector.INLINE_DOCUMENT_LIMIT_MB;
    return rawLimitMBFromEncodedLimitMB(encodedLimitMB);
  }

  constructor(systemPrompt: string, capabilities: Partial<LlmCapabilities> | undefined) {
    super(systemPrompt, {
      ...AnthropicProjector.DEFAULT_CAPABILITIES,
      ...capabilities,
    } as LlmCapabilities);
  }

  async createContext(
    state: {
      history: HistoryManager;
      vfs: VfsService;
      configManager: ConfigManager;
    },
    signal?: AbortSignal,
  ): Promise<any> {
    const history = [...state.history.get()];
    const systemPrompt = this._buildSystemPrompt(state.configManager, state.history);
    const rawMessages: any[] = [];

    for (const turn of history) {
      if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const contentParts = await this._convertTurnToParts(turn, state, signal);
      if (!contentParts || contentParts.length === 0) continue;

      let apiRole = 'user';
      if (turn.role === 'model') apiRole = 'assistant';
      else if (turn.role === 'system') apiRole = 'user';

      rawMessages.push({ role: apiRole, content: contentParts });
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

    return { system: systemPrompt, messages: mergedMessages };
  }

  private async _convertTurnToParts(
    turn: Turn,
    state: {
      history: HistoryManager;
      vfs: VfsService;
      configManager: ConfigManager;
    },
    signal?: AbortSignal,
  ): Promise<any[]> {
    const vfs = state.vfs;
    if (typeof turn.content === 'string') {
      let text = turn.content;
      if (turn.role === 'user') text = wrapUserInput(text);
      // 空白だけの発話は「無かったこと」にする（T-0074）。
      // Anthropic は空のテキストブロックを含む履歴を 400 で拒む。
      if (text.trim() === '') return [];
      return [{ type: 'text', text: text }];
    }

    if (Array.isArray(turn.content)) {
      if (turn.meta && turn.meta.type === 'tool_execution') {
        const parts: any[] = [];
        for (const node of buildToolPromptNodes(turn)) {
          if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
          if (!node.shouldEmit) continue;

          parts.push({
            type: 'text',
            text: node.text,
          });

          if (node.media) {
            const support = await this.checkMediaSupport(vfs, node.media, SYSTEM_PRINCIPAL);
            if (support.supported) {
              const fileObj = await this._resolveMediaFileAnthropic(node.media, vfs, signal);
              if (fileObj.ok) parts.push(fileObj.value);
              else parts.push({ type: 'text', text: buildMediaFailureNotice(node.media.path, fileObj.reason) });
            } else {
              parts.push({
                type: 'text',
                text: this.getUnsupportedMessage(node.media.path, node.media.mimeType, support.reason!),
              });
            }
          }
        }
        return parts;
      }

      if (turn.role === 'user') {
        const parts: any[] = [];

        for (const node of buildUserPromptNodes(turn)) {
          if (node.kind === 'text') {
            parts.push({ type: 'text', text: node.text });
            continue;
          }

          const support = await this.checkMediaSupport(vfs, node.media, SYSTEM_PRINCIPAL);
          if (support.supported) {
            const fileObj = await this._resolveMediaFileAnthropic(node.media, vfs, signal);
            if (fileObj.ok) parts.push(fileObj.value);
            else parts.push({ type: 'text', text: buildMediaFailureNotice(node.media.path, fileObj.reason) });
          } else {
            parts.push({
              type: 'text',
              text: this.getUnsupportedMessage(node.media.path, node.media.mimeType, support.reason!),
            });
          }
        }
        return parts;
      }

      return buildTextPromptNodes(turn).map((node) => ({ type: 'text', text: node.text }));
    }
    return [];
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
  private async _resolveMediaFileAnthropic(
    mediaObj: any,
    vfs: VfsService,
    signal?: AbortSignal,
  ): Promise<MediaAttachResult<any>> {
    if (!vfs.exists(SYSTEM_PRINCIPAL, mediaObj.path)) return { ok: false, reason: 'missing' };
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');

    try {
      const blob = await vfs.readBlob(SYSTEM_PRINCIPAL, mediaObj.path);
      const mimeType = mediaObj.mimeType || blob.type;

      // 器は種別ごとに違う。text/* は base64 の document として受け取ってもらえない
      // （`source.type` が `'text'`）ので、そこだけ生の本文を渡す。
      if (mimeType.startsWith('text/')) {
        const text = await blob.text();
        return {
          ok: true,
          value: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: text } },
        };
      }

      const base64 = await this._blobToBase64(blob);
      return { ok: true, value: this._buildAnthropicContentBlock(base64, mimeType) };
    } catch (e) {
      console.error('[Projector] Anthropic media encode failed:', e);
      return { ok: false, reason: 'missing' };
    }
  }

  private _buildAnthropicContentBlock(base64: string, mimeType: string): any {
    if (mimeType.startsWith('image/')) {
      return { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } };
    }
    return { type: 'document', source: { type: 'base64', media_type: mimeType, data: base64 } };
  }
}
