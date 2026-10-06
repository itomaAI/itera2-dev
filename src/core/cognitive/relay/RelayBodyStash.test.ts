/**
 * src/core/cognitive/relay/RelayBodyStash.test.ts
 * 大きな本文を Firebase Storage の REST（v0）へ multipart で置く口（T-0622）。
 *
 * 守りたいのは:
 *   1. 置き場は本人の `llmRelayBodies/{uid}/<乱数>.json`（中継側の受け付ける形）
 *   2. 送り先・認証（`Authorization: Firebase <token>`）・multipart の形が Firebase SDK の uploadBytes と同じ
 *   3. メタデータに name と contentType（application/json）が入り、中身は本文そのもの
 *   4. 置けなければ状態コードを添えて投げる。中断は signal で渡る
 */

import { describe, it, expect, vi } from 'vitest';
import { buildMultipartUpload, relayBodyPath, storageUploadUrl, uploadRelayBody } from './RelayBodyStash';

describe('relayBodyPath / storageUploadUrl', () => {
  it('中継が受け付ける形（llmRelayBodies/{uid}/[A-Za-z0-9_-]{8,128}.json）', () => {
    const p = relayBodyPath('u1');
    expect(p).toMatch(/^llmRelayBodies\/u1\/[A-Za-z0-9_-]{8,128}\.json$/);
    expect(relayBodyPath('u1')).not.toBe(relayBodyPath('u1'));
  });
  it('v0 の REST。バケットとパスは URL エンコード', () => {
    expect(storageUploadUrl('itera2.firebasestorage.app', 'llmRelayBodies/u1/x.json')).toBe(
      'https://firebasestorage.googleapis.com/v0/b/itera2.firebasestorage.app/o?name=llmRelayBodies%2Fu1%2Fx.json',
    );
  });
});

describe('buildMultipartUpload', () => {
  it('メタデータ部と中身部の 2 つ。中身は本文そのもの', () => {
    const body = JSON.stringify({ model: 'smart', messages: [{ role: 'user', content: 'ほげ' }] });
    const { contentType, payload } = buildMultipartUpload('llmRelayBodies/u1/a.json', body, 'B');
    expect(contentType).toBe('multipart/related; boundary=B');
    const text = new TextDecoder().decode(payload);
    const parts = text.split('--B');
    expect(parts).toHaveLength(4); // 先頭の空・メタ・中身・末尾の "--"
    expect(parts[3]).toBe('--');
    expect(parts[1]).toContain('Content-Type: application/json; charset=utf-8\r\n\r\n');
    expect(JSON.parse(parts[1].split('\r\n\r\n')[1].trim())).toEqual({
      name: 'llmRelayBodies/u1/a.json',
      contentType: 'application/json',
    });
    expect(parts[2]).toContain('Content-Type: application/json\r\n\r\n');
    expect(parts[2].split('\r\n\r\n')[1].replace(/\r\n$/, '')).toBe(body);
  });
});

describe('uploadRelayBody', () => {
  it('ID トークンで本人の置き場へ置き、パスを返す', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }) as any);
    const path = await uploadRelayBody({
      bucket: 'itera2.firebasestorage.app',
      uid: 'u1',
      idToken: 'TOKEN',
      body: '{"a":1}',
      fetchImpl,
    });
    expect(path).toMatch(/^llmRelayBodies\/u1\//);
    const [url, init] = fetchImpl.mock.calls[0] as any;
    expect(url).toBe(
      `https://firebasestorage.googleapis.com/v0/b/itera2.firebasestorage.app/o?name=${encodeURIComponent(path)}`,
    );
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Firebase TOKEN');
    expect(init.headers['X-Goog-Upload-Protocol']).toBe('multipart');
    expect(init.headers['Content-Type']).toMatch(/^multipart\/related; boundary=/);
    expect(init.body).toBeInstanceOf(Uint8Array);
  });

  it('置けなければ状態コードと本文の頭を添えて投げる', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, text: async () => 'Permission denied.' }) as any);
    await expect(uploadRelayBody({ bucket: 'b', uid: 'u1', idToken: 'T', body: '{}', fetchImpl })).rejects.toThrow(
      /storage upload failed: HTTP 403 Permission denied\./,
    );
  });

  it('signal をそのまま fetch へ渡す', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_u: any, init: any) => {
      expect(init.signal).toBe(controller.signal);
      return { ok: true, status: 200, text: async () => '{}' } as any;
    });
    await uploadRelayBody({ bucket: 'b', uid: 'u1', idToken: 'T', body: '{}', signal: controller.signal, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
