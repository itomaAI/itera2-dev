/**
 * src/core/cognitive/Projector.ts
 * Itera OS v2: State to Prompt Conversion
 */

import type { VfsService } from "../vfs/VfsService";
import type { ConfigManager } from "../sys/ConfigManager";
import type { HistoryManager, Turn } from "../state/HistoryManager";
import { SYSTEM_PRINCIPAL } from "../vfs/types";

export abstract class BaseProjector {
  protected systemPrompt: string;

  constructor(systemPrompt: string) {
    this.systemPrompt = systemPrompt;
  }

  abstract createContext(
    state: {
      history: HistoryManager;
      vfs: VfsService;
      configManager: ConfigManager;
    },
    signal?: AbortSignal,
  ): Promise<any>;

  protected _buildSystemPrompt(
    configManager: ConfigManager,
    history: HistoryManager,
  ): string {
    const prefs = configManager.get("preferences");
    const user = prefs?.username || "User";
    const agent = prefs?.agentName || "Itera";
    const language = prefs?.language || "English";

    let effectivePrompt = this.systemPrompt.replace(/{{language}}/g, language);
    effectivePrompt = effectivePrompt.replace(/{{agentName}}/g, agent);
    effectivePrompt = effectivePrompt.replace(/{{username}}/g, user);

    const turns = history.get();
    const firstTurn = turns.length > 0 ? turns[0] : null;
    const sessionStart = firstTurn ? new Date(firstTurn.timestamp) : new Date();

    const days = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ];
    const timePrompt = `\n\n<system type="time">\nSession Started: ${sessionStart.toLocaleString()} (${days[sessionStart.getDay()]})\nTimestamp: ${sessionStart.toISOString()}\n</system>`;

    return effectivePrompt + timePrompt;
  }

  // Blob を Base64 文字列に変換するヘルパー
  protected async _blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result as string;
        resolve(result.split(",")[1] || result); // `data:...;base64,` のプレフィックスを削除した純粋なBase64
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
}

// ==========================================
// Google Gemini
// ==========================================

export class GeminiProjector extends BaseProjector {
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

    let apiKey = "";
    try {
      const secrets = JSON.parse(
        localStorage.getItem("itera_llm_secrets") || "{}",
      );
      if (secrets.google) apiKey = secrets.google;
    } catch (e) {}

    const apiMessages: any[] = [];
    const dynamicPrompt = this._buildSystemPrompt(
      state.configManager,
      state.history,
    );
    apiMessages.push({ role: "user", parts: [{ text: dynamicPrompt }] });

    for (const turn of history) {
      if (signal && signal.aborted)
        throw new DOMException("Aborted", "AbortError");
      const parts = await this._convertTurnToParts(
        turn,
        state.vfs,
        apiKey,
        signal,
      );
      if (!parts || parts.length === 0) continue;

      let apiRole = "user";
      if (turn.role === "model") apiRole = "model";
      apiMessages.push({ role: apiRole, parts: parts });
    }
    return apiMessages;
  }

  private async _convertTurnToParts(
    turn: Turn,
    vfs: VfsService,
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<any[]> {
    if (typeof turn.content === "string") {
      let text = turn.content;
      if (turn.role === "user") text = `<user_input>\n${text}\n</user_input>`;
      return [{ text: text }];
    }

    if (Array.isArray(turn.content)) {
      if (turn.meta && turn.meta.type === "tool_execution") {
        const parts: any[] = [];
        for (const c of turn.content) {
          if (signal && signal.aborted)
            throw new DOMException("Aborted", "AbortError");
          if (!c.output || (!c.output.log && !c.output.media)) continue;

          const actionName = c.actionType || "unknown";
          const status = c.output.error ? "error" : "success";
          let attrStr = `action="${actionName}" status="${status}"`;

          if (c.params) {
            for (const [key, val] of Object.entries(c.params)) {
              attrStr += ` ${key}="${String(val).replace(/"/g, "&quot;")}"`;
            }
          }

          const logContent = c.output.log ? c.output.log.trim() : "";
          parts.push({
            text: logContent
              ? `<tool_output ${attrStr}>\n${logContent}\n</tool_output>`
              : `<tool_output ${attrStr} />`,
          });

          if (c.output.media) {
            const fileData = await this._resolveMediaFile(
              c.output.media,
              vfs,
              apiKey,
              signal,
            );
            if (fileData) parts.push({ fileData });
          }
        }
        return parts;
      }

      if (turn.role === "user") {
        const parts: any[] = [];
        let textBuffer = "";
        const flushText = () => {
          if (textBuffer.trim())
            parts.push({
              text: `<user_input>\n${textBuffer.trim()}\n</user_input>`,
            });
          textBuffer = "";
        };

        for (const item of turn.content) {
          if (item.text) {
            if (item.text.trim().startsWith("<")) {
              flushText();
              parts.push({ text: item.text });
            } else {
              textBuffer += item.text + "\n";
            }
          } else if (item.media) {
            flushText();
            const fileData = await this._resolveMediaFile(
              item.media,
              vfs,
              apiKey,
              signal,
            );
            if (fileData) parts.push({ fileData });
            else
              parts.push({
                text: `\n[System: The image file '${item.media.path}' could not be loaded from VFS.]\n`,
              });
          }
        }
        flushText();
        return parts;
      }

      return turn.content
        .map((c: any) => (c.text ? { text: c.text } : null))
        .filter(Boolean);
    }
    return [];
  }

  private async _resolveMediaFile(
    mediaObj: any,
    vfs: VfsService,
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<any> {
    const geminiMeta = mediaObj.metadata?.gemini;
    if (geminiMeta && geminiMeta.fileUri && geminiMeta.expirationTime) {
      if (
        new Date(geminiMeta.expirationTime) >
        new Date(Date.now() + 60 * 60 * 1000)
      ) {
        return { fileUri: geminiMeta.fileUri, mimeType: mediaObj.mimeType };
      }
    }

    if (!vfs.exists(SYSTEM_PRINCIPAL, mediaObj.path)) return null;
    if (!apiKey) return null;

    try {
      const blob = await vfs.readBlob(SYSTEM_PRINCIPAL, mediaObj.path);
      const uploadResult = await this._uploadToGemini(
        blob,
        mediaObj.mimeType,
        apiKey,
        signal,
      );

      if (!mediaObj.metadata) mediaObj.metadata = {};
      mediaObj.metadata.gemini = {
        fileUri: uploadResult.fileUri,
        expirationTime: uploadResult.expirationTime,
        name: uploadResult.name,
      };

      return { fileUri: uploadResult.fileUri, mimeType: mediaObj.mimeType };
    } catch (e) {
      console.error("[Projector] File upload failed:", e);
      return null;
    }
  }

  private async _uploadToGemini(
    blob: Blob,
    mimeType: string,
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<any> {
    const size = blob.size;
    const initUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`;
    const initRes = await fetch(initUrl, {
      method: "POST",
      headers: {
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": size.toString(),
        "X-Goog-Upload-Header-Content-Type": mimeType,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file: { display_name: "itera_media" } }),
      signal,
    });

    if (!initRes.ok) throw new Error(`Upload init failed (${initRes.status})`);

    const uploadUrl = initRes.headers.get("x-goog-upload-url");
    if (!uploadUrl) throw new Error("No upload URL returned");

    const uploadRes = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "Content-Length": size.toString(),
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize",
      },
      body: blob,
      signal,
    });

    if (!uploadRes.ok)
      throw new Error(`Binary upload failed (${uploadRes.status})`);
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
      role: "system",
      content: this._buildSystemPrompt(state.configManager, state.history),
    });

    for (const turn of history) {
      if (signal && signal.aborted)
        throw new DOMException("Aborted", "AbortError");
      const contentParts = await this._convertTurnToParts(
        turn,
        state.vfs,
        signal,
      );
      if (!contentParts || contentParts.length === 0) continue;

      let apiRole = "user";
      if (turn.role === "model") apiRole = "assistant";
      else if (turn.role === "system") apiRole = "user";

      apiMessages.push({ role: apiRole, content: contentParts });
    }
    return apiMessages;
  }

  private async _convertTurnToParts(
    turn: Turn,
    vfs: VfsService,
    signal?: AbortSignal,
  ): Promise<any[]> {
    if (typeof turn.content === "string") {
      let text = turn.content;
      if (turn.role === "user") text = `<user_input>\n${text}\n</user_input>`;
      return [{ type: "text", text: text }];
    }

    if (Array.isArray(turn.content)) {
      if (turn.meta && turn.meta.type === "tool_execution") {
        const parts: any[] = [];
        for (const c of turn.content) {
          if (signal && signal.aborted)
            throw new DOMException("Aborted", "AbortError");
          if (!c.output || (!c.output.log && !c.output.media)) continue;

          const actionName = c.actionType || "unknown";
          const status = c.output.error ? "error" : "success";
          let attrStr = `action="${actionName}" status="${status}"`;

          if (c.params) {
            for (const [key, val] of Object.entries(c.params)) {
              attrStr += ` ${key}="${String(val).replace(/"/g, "&quot;")}"`;
            }
          }

          const logContent = c.output.log ? c.output.log.trim() : "";
          parts.push({
            type: "text",
            text: logContent
              ? `<tool_output ${attrStr}>\n${logContent}\n</tool_output>`
              : `<tool_output ${attrStr} />`,
          });

          if (c.output.media) {
            if (c.output.media.mimeType?.startsWith("image/")) {
              const imgUrl = await this._resolveMediaDataUrl(
                c.output.media,
                vfs,
              );
              if (imgUrl)
                parts.push({ type: "image_url", image_url: { url: imgUrl } });
            } else {
              parts.push({
                type: "text",
                text: `\n[System: Attached binary file '${c.output.media.path}' (${c.output.media.mimeType}) is not an image and cannot be viewed directly by this model.]\n`,
              });
            }
          }
        }
        return parts;
      }

      if (turn.role === "user") {
        const parts: any[] = [];
        let textBuffer = "";
        const flushText = () => {
          if (textBuffer.trim())
            parts.push({
              type: "text",
              text: `<user_input>\n${textBuffer.trim()}\n</user_input>`,
            });
          textBuffer = "";
        };

        for (const item of turn.content) {
          if (item.text) {
            if (item.text.trim().startsWith("<")) {
              flushText();
              parts.push({ type: "text", text: item.text });
            } else {
              textBuffer += item.text + "\n";
            }
          } else if (item.media) {
            flushText();
            if (item.media.mimeType?.startsWith("image/")) {
              const imgUrl = await this._resolveMediaDataUrl(item.media, vfs);
              if (imgUrl)
                parts.push({ type: "image_url", image_url: { url: imgUrl } });
              else
                parts.push({
                  type: "text",
                  text: `\n[System: The image file '${item.media.path}' could not be loaded from VFS.]\n`,
                });
            } else {
              parts.push({
                type: "text",
                text: `\n[System: Attached binary file '${item.media.path}' (${item.media.mimeType}) is not an image and cannot be viewed directly by this model.]\n`,
              });
            }
          }
        }
        flushText();
        return parts;
      }

      return turn.content
        .map((c: any) => (c.text ? { type: "text", text: c.text } : null))
        .filter(Boolean);
    }
    return [];
  }

  private async _resolveMediaDataUrl(
    mediaObj: any,
    vfs: VfsService,
  ): Promise<string | null> {
    if (!vfs.exists(SYSTEM_PRINCIPAL, mediaObj.path)) return null;
    const blob = await vfs.readBlob(SYSTEM_PRINCIPAL, mediaObj.path);
    const base64 = await this._blobToBase64(blob);
    return `data:${mediaObj.mimeType || "image/png"};base64,${base64}`;
  }
}

// ==========================================
// Anthropic
// ==========================================

export class AnthropicProjector extends BaseProjector {
  async createContext(
    state: {
      history: HistoryManager;
      vfs: VfsService;
      configManager: ConfigManager;
    },
    signal?: AbortSignal,
  ): Promise<any> {
    const history = [...state.history.get()];
    const systemPrompt = this._buildSystemPrompt(
      state.configManager,
      state.history,
    );
    const rawMessages: any[] = [];

    for (const turn of history) {
      if (signal && signal.aborted)
        throw new DOMException("Aborted", "AbortError");
      const contentParts = await this._convertTurnToParts(
        turn,
        state.vfs,
        signal,
      );
      if (!contentParts || contentParts.length === 0) continue;

      let apiRole = "user";
      if (turn.role === "model") apiRole = "assistant";
      else if (turn.role === "system") apiRole = "user";

      rawMessages.push({ role: apiRole, content: contentParts });
    }

    // Role Alternating Constraint
    const mergedMessages: any[] = [];
    for (const msg of rawMessages) {
      if (mergedMessages.length === 0) {
        if (msg.role === "assistant") {
          mergedMessages.push({
            role: "user",
            content: [
              { type: "text", text: "[System: Internal initialization]" },
            ],
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
    vfs: VfsService,
    signal?: AbortSignal,
  ): Promise<any[]> {
    if (typeof turn.content === "string") {
      let text = turn.content;
      if (turn.role === "user") text = `<user_input>\n${text}\n</user_input>`;
      return [{ type: "text", text: text }];
    }

    if (Array.isArray(turn.content)) {
      if (turn.meta && turn.meta.type === "tool_execution") {
        const parts: any[] = [];
        for (const c of turn.content) {
          if (signal && signal.aborted)
            throw new DOMException("Aborted", "AbortError");
          if (!c.output || (!c.output.log && !c.output.media)) continue;

          const actionName = c.actionType || "unknown";
          const status = c.output.error ? "error" : "success";
          let attrStr = `action="${actionName}" status="${status}"`;

          if (c.params) {
            for (const [key, val] of Object.entries(c.params)) {
              attrStr += ` ${key}="${String(val).replace(/"/g, "&quot;")}"`;
            }
          }

          const logContent = c.output.log ? c.output.log.trim() : "";
          parts.push({
            type: "text",
            text: logContent
              ? `<tool_output ${attrStr}>\n${logContent}\n</tool_output>`
              : `<tool_output ${attrStr} />`,
          });

          if (c.output.media) {
            if (c.output.media.mimeType?.startsWith("image/")) {
              const imgObj = await this._resolveMediaAnthropic(
                c.output.media,
                vfs,
              );
              if (imgObj) parts.push(imgObj);
            } else {
              parts.push({
                type: "text",
                text: `\n[System: Attached binary file '${c.output.media.path}' (${c.output.media.mimeType}) is not an image and cannot be viewed directly by this model.]\n`,
              });
            }
          }
        }
        return parts;
      }

      if (turn.role === "user") {
        const parts: any[] = [];
        let textBuffer = "";
        const flushText = () => {
          if (textBuffer.trim())
            parts.push({
              type: "text",
              text: `<user_input>\n${textBuffer.trim()}\n</user_input>`,
            });
          textBuffer = "";
        };

        for (const item of turn.content) {
          if (item.text) {
            if (item.text.trim().startsWith("<")) {
              flushText();
              parts.push({ type: "text", text: item.text });
            } else {
              textBuffer += item.text + "\n";
            }
          } else if (item.media) {
            flushText();
            if (item.media.mimeType?.startsWith("image/")) {
              const imgObj = await this._resolveMediaAnthropic(item.media, vfs);
              if (imgObj) parts.push(imgObj);
              else
                parts.push({
                  type: "text",
                  text: `\n[System: The image file '${item.media.path}' could not be loaded from VFS.]\n`,
                });
            } else {
              parts.push({
                type: "text",
                text: `\n[System: Attached binary file '${item.media.path}' (${item.media.mimeType}) is not an image and cannot be viewed directly by this model.]\n`,
              });
            }
          }
        }
        flushText();
        return parts;
      }

      return turn.content
        .map((c: any) => (c.text ? { type: "text", text: c.text } : null))
        .filter(Boolean);
    }
    return [];
  }

  private async _resolveMediaAnthropic(
    mediaObj: any,
    vfs: VfsService,
  ): Promise<any | null> {
    if (!vfs.exists(SYSTEM_PRINCIPAL, mediaObj.path)) return null;
    const blob = await vfs.readBlob(SYSTEM_PRINCIPAL, mediaObj.path);
    const base64 = await this._blobToBase64(blob);
    const mime = mediaObj.mimeType || "image/png";
    return {
      type: "image",
      source: { type: "base64", media_type: mime, data: base64 },
    };
  }
}
