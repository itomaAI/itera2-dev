import { describe, expect, it } from 'vitest';

import { AnthropicProjector, buildMediaFailureNotice, GeminiProjector, OpenAIProjector } from './Projector';

/**
 * 目的: 添付（画像・PDF）を送れなかったときの振る舞いを固定する。
 *
 * 鍵が未設定・失効のとき、各社の Files API へは上げられない。
 * このとき **黙って落とす**と、添付したはずの利用者にも、受け取る LLM にも何も伝わらない。
 * また理由を取り違えた注記（「VFS から読めなかった」）は、無いより悪い。
 *
 * 不変条件: 添付を組み立てられなかったら、必ずその旨の注記が prompt に入る。理由は取り違えない。
 */

const MEDIA = { path: 'system/temp/media/shot.png', mimeType: 'image/png' } as any;

/** VFS の代役。実体の有無と大きさだけを答える。 */
function fakeVfs(opts: { exists?: boolean } = {}) {
  const exists = opts.exists ?? true;
  return {
    exists: () => exists,
    stat: () => ({ size: 1024 }),
    readBlob: async () => ({ size: 1024, type: 'image/png' }),
  } as any;
}

/** 道具の結果に画像が付いた turn（画面写真を撮ったときの形）。 */
function toolTurn() {
  return {
    role: 'assistant',
    meta: { type: 'tool_execution' },
    content: [{ actionType: 'take_screenshot', output: { log: 'captured', media: MEDIA } }],
  } as any;
}

/** 利用者が画像を添付した turn。 */
function userTurn() {
  return {
    role: 'user',
    content: [
      { type: 'text', text: 'これを見てください' },
      { type: 'media', media: MEDIA },
    ],
  } as any;
}

const fakeState = (vfs: any) => ({ history: {} as any, vfs, configManager: {} as any });

/** parts の中から、注記らしいテキストを集める。 */
function texts(parts: any[]): string {
  return parts.map((p) => p?.text ?? '').join('\n');
}

describe('buildMediaFailureNotice', () => {
  /**
   * 事前条件: 3つの理由。
   * 事後条件: いずれも対象のパスと「送っていない」ことを含むこと。
   */
  it('どの理由でも、対象のパスと「送っていない」ことを伝えること', () => {
    for (const reason of ['missing', 'no_credentials', 'upload_failed'] as const) {
      const notice = buildMediaFailureNotice('a/b/c.png', reason);
      expect(notice).toContain('a/b/c.png');
      expect(notice).toContain('NOT sent');
    }
  });

  /**
   * 事前条件: 鍵が無いことが理由。
   * 事後条件: VFS のせいにしないこと（保存先を疑わせる誤った診断を出さない）。
   */
  it('鍵が無いときに、VFS から読めなかったと誤って言わないこと', () => {
    const notice = buildMediaFailureNotice('a/b/c.png', 'no_credentials');
    expect(notice).not.toContain('VFS');
    expect(notice).toMatch(/key/i);
  });

  /**
   * 事前条件: 3つの理由。
   * 事後条件: それぞれ異なる文言であること（原因の切り分けができること）。
   */
  it('理由ごとに文言が異なること', () => {
    const notices = (['missing', 'no_credentials', 'upload_failed'] as const).map((r) =>
      buildMediaFailureNotice('a/b/c.png', r),
    );
    expect(new Set(notices).size).toBe(3);
  });
});

describe('添付を組み立てられないとき（鍵が無い）', () => {
  /**
   * 事前条件: Gemini 経路・鍵なし・VFS に実体あり・道具の結果に付いた画像。
   * 事後条件: 黙って消さず、鍵が無いことを理由として注記が入ること。
   */
  it('Gemini: 道具の結果の画像を黙って落とさないこと', async () => {
    const projector = new GeminiProjector('sys', undefined, '');
    const parts = await (projector as any)._convertTurnToParts(toolTurn(), fakeVfs(), '');
    expect(texts(parts)).toContain(buildMediaFailureNotice(MEDIA.path, 'no_credentials'));
  });

  /**
   * 事前条件: Gemini 経路・鍵なし・利用者の添付。
   * 事後条件: 注記の理由が「鍵が無い」であること（VFS のせいにしない）。
   */
  it('Gemini: 利用者の添付では、理由を取り違えないこと', async () => {
    const projector = new GeminiProjector('sys', undefined, '');
    const parts = await (projector as any)._convertTurnToParts(userTurn(), fakeVfs(), '');
    const joined = texts(parts);
    expect(joined).toContain(buildMediaFailureNotice(MEDIA.path, 'no_credentials'));
    expect(joined).not.toContain('could not be loaded from VFS');
  });
});

describe('VFS に実体が無いとき', () => {
  /**
   * 事前条件: Gemini 経路・鍵あり・VFS に実体なし。
   * 事後条件: 「VFS から読めなかった」として扱われること（鍵のせいにしない）。
   */
  it('Gemini: 鍵の有無ではなく、実体が無いことを理由にすること', async () => {
    const projector = new GeminiProjector('sys', undefined, 'key');
    const result = await (projector as any)._resolveMediaFile(MEDIA, fakeVfs({ exists: false }), 'key');
    expect(result).toEqual({ ok: false, reason: 'missing' });
  });

  /**
   * 事前条件: OpenAI 経路（鍵を使わず本文へ埋める）・VFS に実体なし。
   * 事後条件: 道具の結果でも注記が入ること。
   */
  it('OpenAI: 道具の結果の画像を黙って落とさないこと', async () => {
    const projector = new OpenAIProjector('sys', undefined);
    const parts = await (projector as any)._convertTurnToParts(toolTurn(), fakeVfs({ exists: false }));
    expect(texts(parts)).toContain(buildMediaFailureNotice(MEDIA.path, 'missing'));
  });

  /**
   * 事前条件: Anthropic 経路（鍵を使わず本文へ埋める）・VFS に実体なし。
   * 事後条件: 道具の結果でも注記が入ること。
   */
  it('Anthropic: 道具の結果の画像を黙って落とさないこと', async () => {
    const projector = new AnthropicProjector('sys', undefined);
    const parts = await (projector as any)._convertTurnToParts(toolTurn(), fakeState(fakeVfs({ exists: false })));
    expect(texts(parts)).toContain(buildMediaFailureNotice(MEDIA.path, 'missing'));
  });
});

describe('添付を組み立てられたとき', () => {
  /**
   * 事前条件: OpenAI 経路・VFS に実体あり。
   * 事後条件: 本文へ埋め込んだ data URL が返ること（鍵を使わずに通る経路）。
   */
  it('OpenAI: 鍵なしでも本文への埋め込みが成立すること', async () => {
    const projector = new OpenAIProjector('sys', undefined);
    (projector as any)._blobToBase64 = async () => 'QUJD';
    const result = await (projector as any)._resolveMediaDataUrl(MEDIA, fakeVfs());
    expect(result).toEqual({ ok: true, value: 'data:image/png;base64,QUJD' });
  });

  /**
   * 事前条件: Anthropic 経路・鍵なし・VFS に実体あり。
   * 事後条件: 本文へ埋め込む image ブロックが返ること。
   *
   * **鍵を渡していないのに成立することが要点。** Files API（別端点）はブラウザから
   * 叩けないため本文へ載せる方式にした。ここが鍵を要求し始めたら退行である。
   */
  it('Anthropic: 鍵なしでも本文への埋め込みが成立すること', async () => {
    const projector = new AnthropicProjector('sys', undefined);
    (projector as any)._blobToBase64 = async () => 'QUJD';
    const result = await (projector as any)._resolveMediaFileAnthropic(MEDIA, fakeVfs());
    expect(result).toEqual({
      ok: true,
      value: { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
    });
  });

  /**
   * 事前条件: Anthropic 経路・PDF。
   * 事後条件: image ではなく document ブロックになること（型を取り違えると 400 になる）。
   */
  it('Anthropic: PDF は document ブロックになること', async () => {
    const projector = new AnthropicProjector('sys', undefined);
    (projector as any)._blobToBase64 = async () => 'QUJD';
    const pdf = { path: 'data/doc.pdf', mimeType: 'application/pdf' } as any;
    const result = await (projector as any)._resolveMediaFileAnthropic(pdf, fakeVfs());
    expect(result).toEqual({
      ok: true,
      value: { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'QUJD' } },
    });
  });

  /**
   * 事前条件: Gemini 経路・鍵あり・アップロード済みの控えが metadata にある。
   * 事後条件: 再アップロードせずに成功として返ること。
   */
  it('Gemini: 期限内の控えがあれば、それを使うこと', async () => {
    const projector = new GeminiProjector('sys', undefined, 'key');
    const media = {
      ...MEDIA,
      metadata: { gemini: { fileUri: 'files/xyz', expirationTime: new Date(Date.now() + 86400000).toISOString() } },
    };
    const result = await (projector as any)._resolveMediaFile(media, fakeVfs(), 'key');
    expect(result).toEqual({ ok: true, value: { fileUri: 'files/xyz', mimeType: 'image/png' } });
  });
});
