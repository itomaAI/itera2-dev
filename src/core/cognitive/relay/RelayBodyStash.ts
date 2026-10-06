/**
 * src/core/cognitive/relay/RelayBodyStash.ts
 * 大きな本文を Firebase Storage に置き、中継には在り処だけを送るための口（T-0622。ミャク楽 T-0600 の itera2 版）。
 *
 * ■ なぜ要るか
 * 中継（Cloud Functions 第 2 世代）は HTTP/1 で受けるので、32 MiB を超える本文は届かない（CORS の無い 413 →
 * ブラウザでは "Failed to fetch"）。HTTP/2 で受けることもできない（ミャク楽 T-0599）。そこで閾値を超える本文だけは
 * `llmRelayBodies/{uid}/{乱数}.json` に置き、中継には `{ relayStoredBody: { path } }` だけを送る。中継は読んだら消す。
 *
 * ■ なぜホストが直接上げるか（ミャク楽は認証アダプタの中で Firebase SDK を使う）
 * itera2-dev のホストは認証アダプタの関数を呼ぶ口を持たず、ID トークンと Firebase の設定を `system/temp/firebase_auth.json`
 * から読む（T-0419 / T-0421）。Storage の REST（`firebasestorage.googleapis.com/v0`）は ID トークンを
 * `Authorization: Firebase <token>` で受け、CORS も開いているので、ホストの素の fetch で足りる。
 * 置き方は Firebase JS SDK の `uploadBytes`（multipart）と同じ形。
 *
 * ■ 守り
 * 置けるのは本人の `llmRelayBodies/{uid}/` だけ・64 MiB 未満・JSON・上書き不可（中継側の `storage.rules`）。
 * 読む・消すのは中継（管理 SDK）だけ。読まれずに残ったものは中継側の定期の関数が消す。
 */

export const RELAY_BODIES_PREFIX = 'llmRelayBodies/';
export const STORAGE_UPLOAD_HOST = 'https://firebasestorage.googleapis.com';

function randomId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/** 置き場のパス。中継側の `llmRelayBodies.takeStoredRef` が受け付ける形（`llmRelayBodies/{uid}/[A-Za-z0-9_-]{8,128}.json`） */
export function relayBodyPath(uid: string, id: string = randomId()): string {
  return `${RELAY_BODIES_PREFIX}${uid}/${id}.json`;
}

/** Firebase Storage の REST（v0）のアップロード先 */
export function storageUploadUrl(bucket: string, path: string): string {
  return `${STORAGE_UPLOAD_HOST}/v0/b/${encodeURIComponent(bucket)}/o?name=${encodeURIComponent(path)}`;
}

/**
 * multipart/related の本文を組む（Firebase JS SDK の multipartUpload と同じ形）。
 * 1 つ目の部分がメタデータ（name / contentType）、2 つ目が中身。
 */
export function buildMultipartUpload(
  path: string,
  body: string,
  boundary: string = `itera-relay-${randomId()}`,
): { contentType: string; payload: Uint8Array } {
  const metadata = JSON.stringify({ name: path, contentType: 'application/json' });
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${metadata}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n`,
  );
  const data = enc.encode(body);
  const tail = enc.encode(`\r\n--${boundary}--`);
  const payload = new Uint8Array(head.length + data.length + tail.length);
  payload.set(head, 0);
  payload.set(data, head.length);
  payload.set(tail, head.length + data.length);
  return { contentType: `multipart/related; boundary=${boundary}`, payload };
}

export interface UploadRelayBodyOptions {
  /** 既定のバケット（`firebase_auth.json` の `firebaseConfig.storageBucket`） */
  bucket: string;
  /** 本人の uid。置き場はこの下だけ */
  uid: string;
  /** Firebase の ID トークン */
  idToken: string;
  /** 置く本文（JSON の文字列） */
  body: string;
  signal?: AbortSignal;
  /** 試験用。既定は globalThis.fetch */
  fetchImpl?: typeof fetch;
}

/** 本文を置いて、在り処（中継へ送るパス）を返す。置けなければ投げる（理由を添えて）。 */
export async function uploadRelayBody(options: UploadRelayBodyOptions): Promise<string> {
  const { bucket, uid, idToken, body, signal } = options;
  const doFetch = options.fetchImpl ?? fetch;
  const path = relayBodyPath(uid);
  const { contentType, payload } = buildMultipartUpload(path, body);
  const response = await doFetch(storageUploadUrl(bucket, path), {
    method: 'POST',
    headers: {
      Authorization: `Firebase ${idToken}`,
      'Content-Type': contentType,
      'X-Goog-Upload-Protocol': 'multipart',
    },
    body: payload as unknown as BodyInit,
    signal,
  });
  if (!response.ok) {
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 200);
    } catch {
      /* 本文が読めなくても状態コードは伝える */
    }
    throw new Error(`storage upload failed: HTTP ${response.status}${detail ? ` ${detail}` : ''}`);
  }
  return path;
}
