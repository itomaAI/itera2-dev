/**
 * MetaOS.llm の規則（T-0807）。ホストの実体に触らない純関数の試験。
 */
import { describe, it, expect } from 'vitest';
import { buildLlmCall, llmErrorOf, LLM_TAG_MAX } from './llmApi';
import { LlmMediaError } from '../core/cognitive/LlmRequest';

const ok = (over: any = {}, top: any = {}) => ({
  id: 'c1',
  request: { config: { model: 'anthropic/claude-x' }, messages: [{ role: 'user', content: 'hi' }], ...over },
  ...top,
});

describe('MetaOS.llm.generate の要求', () => {
  it('文字列の中身は text 1 つ。system・tag は無くてよい', () => {
    const p = buildLlmCall(ok());
    expect(p).toEqual({
      ok: true,
      id: 'c1',
      config: { model: 'anthropic/claude-x' },
      request: { messages: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      tag: null,
    });
  });

  it('system・役割・部品の並びをそのまま中立の要求にする（添付の MIME はパスから）', () => {
    const p = buildLlmCall(
      ok({
        system: 'be brief',
        messages: [
          { role: 'user', content: [{ text: 'see' }, { media: { path: 'data/a.png' } }] },
          { role: 'model', content: 'ok' },
          { role: 'user', content: [{ media: { path: 'data/b.bin', mimeType: 'application/pdf' } }] },
        ],
      }),
    );
    expect(p.ok && p.request).toEqual({
      system: 'be brief',
      messages: [
        {
          role: 'user',
          parts: [{ text: 'see' }, { media: { path: 'data/a.png', mimeType: 'image/png', metadata: {} } }],
        },
        { role: 'model', parts: [{ text: 'ok' }] },
        { role: 'user', parts: [{ media: { path: 'data/b.bin', mimeType: 'application/pdf', metadata: {} } }] },
      ],
    });
  });

  it('ゲストが添付に付けてきた metadata は捨てる（上流の控えを書かせない）', () => {
    const p = buildLlmCall(
      ok({
        messages: [
          {
            role: 'user',
            content: [{ media: { path: 'a.png', metadata: { relay: { anthropic: { fileId: 'x' } } } } }],
          },
        ],
      }),
    );
    expect(p.ok && (p.request.messages[0].parts[0] as any).media.metadata).toEqual({});
  });

  it('config はそのまま渡す（model は前後の空白を落とす）。OS の設定は混ぜない', () => {
    const p = buildLlmCall(ok({ config: { model: '  openai/gpt-x ', temperature: 0.2, reasoning_effort: 'low' } }));
    expect(p.ok && p.config).toEqual({ model: 'openai/gpt-x', temperature: 0.2, reasoning_effort: 'low' });
  });

  it('config.model が無ければ断る', () => {
    for (const config of [undefined, null, {}, { model: '' }, { model: '  ' }, { model: 5 }, 'anthropic/x', []]) {
      const p = buildLlmCall(ok({ config }));
      expect(p).toEqual({ ok: false, reason: "config.model is required (e.g. { model: 'provider/model' })" });
    }
  });

  it('messages は空でない配列。役割は user か model だけ', () => {
    expect(buildLlmCall(ok({ messages: [] })).ok).toBe(false);
    expect(buildLlmCall(ok({ messages: 'hi' })).ok).toBe(false);
    expect(buildLlmCall(ok({ messages: [null] })).ok).toBe(false);
    expect(buildLlmCall(ok({ messages: [{ role: 'system', content: 'x' }] }))).toEqual({
      ok: false,
      reason: "role must be 'user' or 'model'",
    });
    expect(buildLlmCall(ok({ messages: [{ role: 'user', content: [{ image: 'x' }] }] })).ok).toBe(false);
    expect(buildLlmCall(ok({ messages: [{ role: 'user', content: 5 }] })).ok).toBe(false);
  });

  it('system は文字列だけ', () => {
    expect(buildLlmCall(ok({ system: { text: 'x' } }))).toEqual({ ok: false, reason: 'system must be a string' });
    expect(buildLlmCall(ok({ system: null })).ok).toBe(true);
    const p = buildLlmCall(ok({ system: '' }));
    expect(p.ok && p.request.system).toBe('');
  });

  it('id と要求の形', () => {
    expect(buildLlmCall(null).ok).toBe(false);
    expect(buildLlmCall({ ...ok(), id: '' }).ok).toBe(false);
    expect(buildLlmCall({ ...ok(), id: 'x'.repeat(101) }).ok).toBe(false);
    expect(buildLlmCall({ ...ok(), id: 7 }).ok).toBe(false);
    expect(buildLlmCall({ id: 'c1', request: 'x' }).ok).toBe(false);
  });

  it('tag は文字列だけ採り、長さを切る', () => {
    const tagOf = (tag: unknown) => {
      const p = buildLlmCall(ok({}, { tag }));
      return p.ok ? p.tag : 'rejected';
    };
    expect(tagOf(' conv-1 ')).toBe('conv-1');
    expect(tagOf('')).toBeNull();
    expect(tagOf(12)).toBeNull();
    expect(tagOf({ a: 1 })).toBeNull();
    expect(tagOf('t'.repeat(500))).toHaveLength(LLM_TAG_MAX);
  });
});

describe('失敗の種類', () => {
  it('止めた → aborted／送れない添付 → media／それ以外 → failed', () => {
    expect(llmErrorOf(new Error('x'), true)).toEqual({ message: 'Aborted', code: 'aborted' });
    expect(llmErrorOf(new DOMException('Aborted', 'AbortError'), false)).toEqual({
      message: 'Aborted',
      code: 'aborted',
    });
    const media = new LlmMediaError({ path: 'a.zip', mimeType: 'application/zip' }, { reason: 'mime' });
    expect(llmErrorOf(media, false)).toEqual({ message: media.message, code: 'media' });
    expect(llmErrorOf(new Error('Anthropic API Error (429): slow down'), false)).toEqual({
      message: 'Anthropic API Error (429): slow down',
      code: 'failed',
    });
    expect(llmErrorOf('boom', false)).toEqual({ message: 'boom', code: 'failed' });
  });
});
