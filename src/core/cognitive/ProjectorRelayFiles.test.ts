/**
 * src/core/cognitive/ProjectorRelayFiles.test.ts
 * 中継を使うとき、添付を中継の Files 経路で運営の鍵へ上げる（T-0623。ミャク楽 T-0119）。
 *
 * 守りたいのは:
 *   1. 鍵が無く中継があるとき: Gemini は中継の `/google/upload/v1beta/files` に start だけ送り、本体は返ってきた
 *      upload URL へ直接送る。控えは metadata.relay.gemini（利用者の鍵の控え metadata.gemini と混ぜない）
 *   2. 上げられなければ inlineData（本文への埋め込み）へ落とす
 *   3. Anthropic は multipart で中継の `/anthropic/v1/files` へ。控えは metadata.relay.anthropic。text/* は埋め込みのまま
 *   4. 期限内／既にある控えがあれば上げ直さない（参照が変わらない＝キャッシュが外れない）
 *   5. 🔴 鍵があるとき・中継が無いときは従来どおり（直接叩く経路は変えない）
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { AnthropicProjector, GeminiProjector, buildMediaFailureNotice } from './Projector';
import type { RelayTransport } from './adapters/BaseAdapter';

const RELAY = 'https://asia-northeast1-itera2.cloudfunctions.net/llmProxy';
const MEDIA = { path: 'system/temp/media/shot.png', mimeType: 'image/png' } as any;

function fakeVfs(opts: { exists?: boolean; size?: number } = {}) {
  const exists = opts.exists ?? true;
  const size = opts.size ?? 1024;
  return {
    exists: () => exists,
    stat: () => ({ size }),
    readBlob: async () => new Blob([new Uint8Array(size)], { type: 'image/png' }),
  } as any;
}

function relay(): RelayTransport {
  return { baseUrl: RELAY, getAuthHeaders: async () => ({ Authorization: 'Bearer T' }) };
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as any;
});

const jsonResponse = (body: any, headers: Record<string, string> = {}, status = 200) =>
  ({
    ok: status < 400,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as any;

describe('Gemini: 鍵が無く中継があるとき', () => {
  it('start は中継へ（認証ヘッダつき）、本体は upload URL へ直接。控えは metadata.relay.gemini', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, { 'x-goog-upload-url': 'https://upload.example/u1' }))
      .mockResolvedValueOnce(
        jsonResponse({ file: { uri: 'files/relay-1', name: 'files/relay-1', expirationTime: '2099-01-01T00:00:00Z' } }),
      );
    const projector = new GeminiProjector('sys', undefined, '', relay());
    const media = { ...MEDIA };
    const result = await (projector as any)._resolveMediaPart(media, fakeVfs(), '');
    expect(result).toEqual({ ok: true, value: { fileData: { fileUri: 'files/relay-1', mimeType: 'image/png' } } });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [startUrl, startInit] = fetchMock.mock.calls[0];
    expect(startUrl).toBe(`${RELAY}/google/upload/v1beta/files`);
    expect(startInit.headers.Authorization).toBe('Bearer T');
    expect(startInit.headers['X-Goog-Upload-Command']).toBe('start');
    expect(String(startUrl)).not.toContain('key=');
    const [uploadUrl, uploadInit] = fetchMock.mock.calls[1];
    expect(uploadUrl).toBe('https://upload.example/u1');
    expect(uploadInit.headers['X-Goog-Upload-Command']).toBe('upload, finalize');
    expect(uploadInit.headers.Authorization).toBeUndefined();

    expect(media.metadata.relay.gemini).toMatchObject({ fileUri: 'files/relay-1' });
    expect(media.metadata.gemini).toBeUndefined();
  });

  it('期限内の控え（metadata.relay.gemini）があれば上げ直さない。利用者の鍵の控えは使わない', async () => {
    const projector = new GeminiProjector('sys', undefined, '', relay());
    const media = {
      ...MEDIA,
      metadata: {
        gemini: { fileUri: 'files/users-own', expirationTime: '2099-01-01T00:00:00Z' },
        relay: { gemini: { fileUri: 'files/relay-cached', expirationTime: '2099-01-01T00:00:00Z' } },
      },
    };
    const result = await (projector as any)._resolveMediaPart(media, fakeVfs(), '');
    expect(result.value.fileData.fileUri).toBe('files/relay-cached');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('上げられなければ inlineData へ落とす（添付は送れる）', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'nope' }, {}, 404));
    const projector = new GeminiProjector('sys', undefined, '', relay());
    (projector as any)._blobToBase64 = async () => 'QUJD';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await (projector as any)._resolveMediaPart({ ...MEDIA }, fakeVfs(), '');
    warn.mockRestore();
    expect(result).toEqual({ ok: true, value: { inlineData: { mimeType: 'image/png', data: 'QUJD' } } });
  });

  it('中継のときの大きさの上限は埋め込みの上限（20MB の 3/4）。鍵があれば従来どおり', () => {
    const viaRelay = new GeminiProjector('sys', undefined, '', relay());
    expect((viaRelay as any).getMaxMediaSizeMB('image/png')).toBeCloseTo(15, 5);
    const direct = new GeminiProjector('sys', undefined, 'key', relay());
    expect((direct as any).getMaxMediaSizeMB('image/png')).toBe(GeminiProjector.DEFAULT_CAPABILITIES.maxMediaSizeMB);
    const noRelay = new GeminiProjector('sys', undefined, '');
    expect((noRelay as any).getMaxMediaSizeMB('image/png')).toBe(GeminiProjector.DEFAULT_CAPABILITIES.maxMediaSizeMB);
  });

  it('🔴 鍵があるときは中継を見ない（直接叩く経路は変えない）', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, { 'x-goog-upload-url': 'https://upload.example/u2' }))
      .mockResolvedValueOnce(
        jsonResponse({ file: { uri: 'files/own', name: 'n', expirationTime: '2099-01-01T00:00:00Z' } }),
      );
    const projector = new GeminiProjector('sys', undefined, 'key', relay());
    const media = { ...MEDIA };
    const result = await (projector as any)._resolveMediaPart(media, fakeVfs(), 'key');
    expect(result.value.fileData.fileUri).toBe('files/own');
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://generativelanguage.googleapis.com/upload/v1beta/files?key=key',
    );
    expect(media.metadata.gemini.fileUri).toBe('files/own');
    expect(media.metadata.relay).toBeUndefined();
  });

  it('🔴 鍵も中継も無ければ従来どおり no_credentials の注記', async () => {
    const projector = new GeminiProjector('sys', undefined, '');
    const result = await (projector as any)._resolveMediaPart({ ...MEDIA }, fakeVfs(), '');
    expect(result).toEqual({ ok: false, reason: 'no_credentials' });
    expect(buildMediaFailureNotice(MEDIA.path, 'no_credentials')).toContain('NOT sent');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Anthropic: 中継があるとき', () => {
  it('multipart で中継の /anthropic/v1/files へ。file ブロックで参照し、控えは metadata.relay.anthropic', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'file_abc' }));
    const projector = new AnthropicProjector('sys', undefined, relay());
    const media = { ...MEDIA };
    const result = await (projector as any)._resolveMediaFileAnthropic(media, fakeVfs());
    expect(result).toEqual({ ok: true, value: { type: 'image', source: { type: 'file', file_id: 'file_abc' } } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${RELAY}/anthropic/v1/files`);
    expect(init.headers.Authorization).toBe('Bearer T');
    expect(init.headers['anthropic-beta']).toContain('files-api');
    expect(init.headers['x-api-key']).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);
    expect(media.metadata.relay.anthropic).toEqual({ fileId: 'file_abc' });
  });

  it('控えがあれば上げ直さない。PDF は document の file ブロック', async () => {
    const projector = new AnthropicProjector('sys', undefined, relay());
    const media = {
      path: 'a.pdf',
      mimeType: 'application/pdf',
      metadata: { relay: { anthropic: { fileId: 'file_pdf' } } },
    };
    const result = await (projector as any)._resolveMediaFileAnthropic(media, fakeVfs());
    expect(result).toEqual({ ok: true, value: { type: 'document', source: { type: 'file', file_id: 'file_pdf' } } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('text/* は中継に上げず、従来どおり本文へ', async () => {
    const projector = new AnthropicProjector('sys', undefined, relay());
    const vfs = {
      exists: () => true,
      stat: () => ({ size: 3 }),
      readBlob: async () => new Blob(['abc'], { type: 'text/plain' }),
    } as any;
    const result = await (projector as any)._resolveMediaFileAnthropic({ path: 'n.txt', mimeType: 'text/plain' }, vfs);
    expect(result).toEqual({
      ok: true,
      value: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'abc' } },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('上げられなければ従来の埋め込み（base64）へ落とす', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'denied' }, {}, 403));
    const projector = new AnthropicProjector('sys', undefined, relay());
    (projector as any)._blobToBase64 = async () => 'QUJD';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await (projector as any)._resolveMediaFileAnthropic({ ...MEDIA }, fakeVfs());
    warn.mockRestore();
    expect(result).toEqual({
      ok: true,
      value: { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
    });
  });

  it('🔴 中継が無ければ従来どおり埋め込み（fetch しない）', async () => {
    const projector = new AnthropicProjector('sys', undefined);
    (projector as any)._blobToBase64 = async () => 'QUJD';
    const result = await (projector as any)._resolveMediaFileAnthropic({ ...MEDIA }, fakeVfs());
    expect(result.value.source.type).toBe('base64');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
