/**
 * src/core/cognitive/Renderer.test.ts
 * 中立の要求 → 各社の本文 の境目の約束（T-0804）。
 *
 * 履歴を通る経路の本文は金型（ProjectorGolden.test.ts）が固定している。ここで見るのは、履歴を通らない呼び手が
 * この境目を直接使うときの約束:
 *   1. system を渡さなければ、system は送らない
 *   2. 送れない添付は、代わりの文（mediaFallback）が無ければ失敗する。黙って落とさない
 *   3. 添付は渡された権限（principal）で読む
 */

import { describe, expect, it } from 'vitest';
import { LlmMediaError, isBlankMessage, type LlmRequest, type RenderEnv } from './LlmRequest';
import { projectHistory, projectTurn } from './Projector';
import { AnthropicRenderer, GeminiRenderer, OpenAIRenderer, type BaseRenderer } from './Renderer';

const GUEST = { type: 'app', id: 'pure_chat' } as any;
const MB = 1024 * 1024;

function fakeVfs(opts: { exists?: boolean; size?: number } = {}) {
  const seen: unknown[] = [];
  const vfs = {
    exists: (principal: unknown) => {
      seen.push(principal);
      return opts.exists ?? true;
    },
    stat: (principal: unknown) => {
      seen.push(principal);
      return { size: opts.size ?? 1024 };
    },
    readBlob: async (principal: unknown) => {
      seen.push(principal);
      return new Blob(['abc'], { type: 'image/png' });
    },
  } as any;
  return { vfs, seen };
}

const env = (vfs: any, extra: Partial<RenderEnv> = {}): RenderEnv => ({ vfs, principal: GUEST, ...extra });

const renderers = (): Array<[string, BaseRenderer]> => [
  ['Gemini', new GeminiRenderer(undefined, '')],
  ['OpenAI', new OpenAIRenderer(undefined)],
  ['Anthropic', new AnthropicRenderer(undefined)],
];

const hello: LlmRequest = { messages: [{ role: 'user', parts: [{ text: 'こんにちは' }] }] };
const withImage = (path = 'data/a.png', mimeType = 'image/png'): LlmRequest => ({
  messages: [{ role: 'user', parts: [{ text: 'これ' }, { media: { path, mimeType } }] }],
});

describe('system を渡さなければ、system は送らない', () => {
  it('Gemini: 先頭に system の user メッセージを足さない', async () => {
    const out = await new GeminiRenderer(undefined, '').render(hello, env(fakeVfs().vfs));
    expect(out).toEqual([{ role: 'user', parts: [{ text: 'こんにちは' }] }]);
  });

  it('OpenAI: system 役割のメッセージを足さない', async () => {
    const out = await new OpenAIRenderer(undefined).render(hello, env(fakeVfs().vfs));
    expect(out).toEqual([{ role: 'user', content: [{ type: 'text', text: 'こんにちは' }] }]);
  });

  it('Anthropic: system 欄は undefined（JSON にすると消える）', async () => {
    const out = await new AnthropicRenderer(undefined).render(hello, env(fakeVfs().vfs));
    expect(out.system).toBeUndefined();
    expect(JSON.parse(JSON.stringify(out))).toEqual({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'こんにちは' }] }],
    });
  });

  it('渡せば、各社の置き場に入る', async () => {
    const req = { ...hello, system: 'SYS' };
    const { vfs } = fakeVfs();
    expect((await new GeminiRenderer(undefined, '').render(req, env(vfs)))[0]).toEqual({
      role: 'user',
      parts: [{ text: 'SYS' }],
    });
    expect((await new OpenAIRenderer(undefined).render(req, env(vfs)))[0]).toEqual({ role: 'system', content: 'SYS' });
    expect((await new AnthropicRenderer(undefined).render(req, env(vfs))).system).toBe('SYS');
  });
});

describe('送れない添付は、代わりの文が無ければ失敗する', () => {
  for (const [name, renderer] of renderers()) {
    it(`${name}: 受け取れない種類（mime）`, async () => {
      const failed = renderer.render(withImage('data/a.zip', 'application/zip'), env(fakeVfs().vfs));
      await expect(failed).rejects.toBeInstanceOf(LlmMediaError);
      await expect(failed).rejects.toMatchObject({ failure: { reason: 'mime' }, media: { path: 'data/a.zip' } });
    });

    it(`${name}: 上限を超える（size。上限の値が付く）`, async () => {
      const failed = renderer.render(withImage(), env(fakeVfs({ size: 900 * MB }).vfs));
      await expect(failed).rejects.toMatchObject({ failure: { reason: 'size', limitMB: expect.any(Number) } });
    });

    it(`${name}: 代わりの文があれば、それを文字の部品として入れる（失敗しない）`, async () => {
      const calls: unknown[] = [];
      const out = await renderer.render(
        withImage('data/a.zip', 'application/zip'),
        env(fakeVfs().vfs, {
          mediaFallback: (media, failure) => {
            calls.push([media.path, failure]);
            return '[代わりの文]';
          },
        }),
      );
      expect(JSON.stringify(out)).toContain('[代わりの文]');
      expect(calls).toEqual([['data/a.zip', { reason: 'mime' }]]);
    });
  }

  it('実体が無い（missing）: 埋め込む経路', async () => {
    for (const renderer of [new OpenAIRenderer(undefined), new AnthropicRenderer(undefined)]) {
      // stat は通り（大きさの門は実体の有無を見ない）、読むところで無いと分かる
      await expect(renderer.render(withImage(), env(fakeVfs({ exists: false }).vfs))).rejects.toMatchObject({
        failure: { reason: 'missing' },
      });
    }
  });

  it('上げる鍵が無い（no_credentials）: Gemini・鍵なし・中継なし', async () => {
    await expect(new GeminiRenderer(undefined, '').render(withImage(), env(fakeVfs().vfs))).rejects.toMatchObject({
      failure: { reason: 'no_credentials' },
    });
  });

  it('失敗の文は、どのファイルが・なぜ、を言う', () => {
    const e = new LlmMediaError({ path: 'data/a.png', mimeType: 'image/png' }, { reason: 'size', limitMB: 3.75 });
    expect(e.name).toBe('LlmMediaError');
    expect(e.message).toContain('data/a.png');
    expect(e.message).toContain('3.75MB');
  });
});

describe('添付は渡された権限で読む', () => {
  for (const [name, renderer] of renderers().filter(([n]) => n !== 'Gemini')) {
    it(`${name}: 存在・大きさ・中身のどれも、呼び手の principal で`, async () => {
      const { vfs, seen } = fakeVfs();
      (renderer as any)._blobToBase64 = async () => 'QUJD';
      await renderer.render(withImage(), env(vfs));
      expect(seen.length).toBeGreaterThanOrEqual(3);
      expect(seen.every((p) => p === GUEST)).toBe(true);
    });
  }

  it('Gemini（中継なし・鍵なし）: 鍵が無いと分かる前の確認も、呼び手の principal で', async () => {
    const { vfs, seen } = fakeVfs();
    await new GeminiRenderer(undefined, '').render(withImage(), env(vfs, { mediaFallback: () => 'x' }));
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((p) => p === GUEST)).toBe(true);
  });
});

describe('中断', () => {
  for (const [name, renderer] of renderers()) {
    it(`${name}: 中断済みなら本文を作らずに AbortError`, async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(renderer.render(hello, env(fakeVfs().vfs, { signal: controller.signal }))).rejects.toMatchObject({
        name: 'AbortError',
      });
    });
  }
});

describe('履歴 → 中立（Projector の前半）', () => {
  const turn = (role: string, content: any, meta: any = {}) => ({ id: 'x', timestamp: 0, role, content, meta }) as any;

  it('役割は model だけが model。system のターン（イベント・道具の結果）は user の側', () => {
    const messages = projectHistory([turn('user', 'a'), turn('model', 'b'), turn('system', 'c')]);
    expect(messages.map((m) => m.role)).toEqual(['user', 'model', 'user']);
  });

  it('利用者の発言だけを <user_input> で包む', () => {
    expect(projectTurn(turn('user', 'a'))).toEqual([{ text: '<user_input>\na\n</user_input>' }]);
    expect(projectTurn(turn('model', 'b'))).toEqual([{ text: 'b' }]);
    expect(projectTurn(turn('system', 'c'))).toEqual([{ text: 'c' }]);
  });

  it('部品の無いターンは送らない。空の文字列のターンは部品 1 つとして残す（送るかは各社が決める）', () => {
    const messages = projectHistory([
      turn('system', [{ actionType: 'noop', output: {} }], { type: 'tool_execution' }),
      turn('model', ''),
      turn('user', { broken: true }),
    ]);
    expect(messages).toEqual([{ role: 'model', parts: [{ text: '' }] }]);
    expect(isBlankMessage(messages[0])).toBe(true);
  });

  it('道具の結果は文字の部品、付いた添付はその直後の添付の部品', () => {
    const media = { path: 'shot.png', mimeType: 'image/png' };
    const parts = projectTurn(
      turn('system', [{ actionType: 'take_screenshot', params: {}, output: { log: 'ok', media } }], {
        type: 'tool_execution',
      }),
    );
    expect(parts).toEqual([
      { text: '<tool_output tool="take_screenshot" status="success">\nok\n</tool_output>' },
      { media },
    ]);
    // 添付は写しではなく履歴のノードそのもの（上げた控えを各社の単位が書き戻す）
    expect((parts[1] as any).media).toBe(media);
  });
});
