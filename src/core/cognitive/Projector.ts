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

  protected getUnsupportedMessage(path: string, mimeType: string, reason: 'mime' | 'size'): string {
    const reasonText =
      reason === 'size'
        ? `it exceeds the file size limit (${this.capabilities.maxMediaSizeMB}MB)`
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
      const maxSizeBytes = this.capabilities.maxMediaSizeMB * 1024 * 1024;
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
              if (fileData) parts.push({ fileData });
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
            if (fileData) parts.push({ fileData });
            else
              parts.push({
                text: `\n[System: The image file '${node.media.path}' could not be loaded from VFS.]\n`,
              });
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

  private async _resolveMediaFile(mediaObj: any, vfs: VfsService, apiKey: string, signal?: AbortSignal): Promise<any> {
    const geminiMeta = mediaObj.metadata?.gemini;
    if (geminiMeta && geminiMeta.fileUri && geminiMeta.expirationTime) {
      if (new Date(geminiMeta.expirationTime) > new Date(Date.now() + 60 * 60 * 1000)) {
        return { fileUri: geminiMeta.fileUri, mimeType: mediaObj.mimeType };
      }
    }

    if (!vfs.exists(SYSTEM_PRINCIPAL, mediaObj.path)) return null;
    if (!apiKey) return null;

    try {
      const blob = await vfs.readBlob(SYSTEM_PRINCIPAL, mediaObj.path);
      const uploadResult = await this._uploadToGemini(blob, mediaObj.mimeType, apiKey, signal);

      if (!mediaObj.metadata) mediaObj.metadata = {};
      mediaObj.metadata.gemini = {
        fileUri: uploadResult.fileUri,
        expirationTime: uploadResult.expirationTime,
        name: uploadResult.name,
      };

      return { fileUri: uploadResult.fileUri, mimeType: mediaObj.mimeType };
    } catch (e) {
      console.error('[Projector] File upload failed:', e);
      return null;
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
                if (imgUrl) parts.push({ type: 'image_url', image_url: { url: imgUrl } });
              } else {
                const fileData = await this._resolveFileData(node.media, vfs);
                if (fileData) parts.push({ type: 'file', file: fileData });
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
              if (imgUrl) parts.push({ type: 'image_url', image_url: { url: imgUrl } });
              else
                parts.push({
                  type: 'text',
                  text: `\n[System: The image file '${node.media.path}' could not be loaded from VFS.]\n`,
                });
            } else {
              const fileData = await this._resolveFileData(node.media, vfs);
              if (fileData) parts.push({ type: 'file', file: fileData });
              else
                parts.push({
                  type: 'text',
                  text: `\n[System: The file '${node.media.path}' could not be loaded from VFS.]\n`,
                });
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

  private async _resolveMediaDataUrl(mediaObj: any, vfs: VfsService): Promise<string | null> {
    if (!vfs.exists(SYSTEM_PRINCIPAL, mediaObj.path)) return null;
    const blob = await vfs.readBlob(SYSTEM_PRINCIPAL, mediaObj.path);
    const base64 = await this._blobToBase64(blob);
    return `data:${mediaObj.mimeType || 'image/png'};base64,${base64}`;
  }

  private async _resolveFileData(mediaObj: any, vfs: VfsService): Promise<any | null> {
    if (!vfs.exists(SYSTEM_PRINCIPAL, mediaObj.path)) return null;
    const blob = await vfs.readBlob(SYSTEM_PRINCIPAL, mediaObj.path);
    const base64 = await this._blobToBase64(blob);
    const filename = mediaObj.path.split('/').pop() || 'file';

    const mimeType = mediaObj.mimeType || 'application/octet-stream';
    const dataUri = `data:${mimeType};base64,${base64}`;

    return {
      filename: filename,
      file_data: dataUri,
    };
  }
}

// ==========================================
// Anthropic
// ==========================================

export class AnthropicProjector extends BaseProjector {
  private apiKey: string;

  public static readonly DEFAULT_CAPABILITIES: LlmCapabilities = {
    maxMediaSizeMB: 500,
    supportedMimes: ['image/*', 'application/pdf', 'text/plain'],
  };

  constructor(systemPrompt: string, capabilities: Partial<LlmCapabilities> | undefined, apiKey: string) {
    super(systemPrompt, {
      ...AnthropicProjector.DEFAULT_CAPABILITIES,
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
              const fileObj = await this._resolveMediaFileAnthropic(
                node.media,
                vfs,
                this.apiKey,
                state.configManager,
                signal,
              );
              if (fileObj) parts.push(fileObj);
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
            const fileObj = await this._resolveMediaFileAnthropic(
              node.media,
              vfs,
              this.apiKey,
              state.configManager,
              signal,
            );
            if (fileObj) parts.push(fileObj);
            else
              parts.push({
                type: 'text',
                text: `\n[System: The file '${node.media.path}' could not be loaded from VFS.]\n`,
              });
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

  private async _resolveMediaFileAnthropic(
    mediaObj: any,
    vfs: VfsService,
    apiKey: string,
    configManager: ConfigManager,
    signal?: AbortSignal,
  ): Promise<any | null> {
    const anthropicMeta = mediaObj.metadata?.anthropic;
    if (anthropicMeta && anthropicMeta.fileId) {
      return this._buildAnthropicContentBlock(anthropicMeta.fileId, mediaObj.mimeType);
    }

    if (!vfs.exists(SYSTEM_PRINCIPAL, mediaObj.path)) return null;
    if (!apiKey) return null;

    try {
      const blob = await vfs.readBlob(SYSTEM_PRINCIPAL, mediaObj.path);
      const filename = mediaObj.path.split('/').pop() || 'file';

      const uploadResult = await this._uploadToAnthropic(blob, filename, apiKey, configManager, signal);

      if (!mediaObj.metadata) mediaObj.metadata = {};
      mediaObj.metadata.anthropic = {
        fileId: uploadResult.id,
      };

      return this._buildAnthropicContentBlock(uploadResult.id, mediaObj.mimeType || blob.type);
    } catch (e) {
      console.error('[Projector] Anthropic file upload failed:', e);
      return null;
    }
  }

  private _buildAnthropicContentBlock(fileId: string, mimeType: string): any {
    const isImage = mimeType.startsWith('image/');
    if (isImage) {
      return {
        type: 'image',
        source: { type: 'file', file_id: fileId },
      };
    } else {
      return {
        type: 'document',
        source: { type: 'file', file_id: fileId },
      };
    }
  }

  private async _uploadToAnthropic(
    blob: Blob,
    filename: string,
    apiKey: string,
    configManager: ConfigManager,
    signal?: AbortSignal,
  ): Promise<any> {
    const baseUrl = 'https://api.anthropic.com/v1/files';
    let targetUrl = baseUrl;
    const proxyUrl = configManager.get('network')?.proxyUrl;
    if (proxyUrl) {
      targetUrl = `${proxyUrl}${encodeURIComponent(baseUrl)}`;
    }

    const formData = new FormData();
    formData.append('file', blob, filename);

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'files-api-2025-04-14',
      },
      body: formData,
      signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Anthropic Upload Error (${response.status}): ${errText}`);
    }

    return await response.json();
  }
}
