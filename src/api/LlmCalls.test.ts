/**
 * MetaOS.llm の実体（T-0807）: 走っている呼び出しの表。
 *
 * 守りたいこと:
 *   1. 呼び手の設定で一組を作り、添付は呼んだゲストの権限で読み、送れない添付の代わりの文を渡さない
 *   2. 台帳には呼んだ pid と tag を名乗る
 *   3. 文字・終了・失敗は呼んだ pid にだけ通知する
 *   4. 止められるのは自分の呼び出しだけ。プロセスが終わったら全部止まる
 */
import { describe, it, expect, vi } from 'vitest';
import { LlmCalls, type LlmEndpointLike } from './LlmCalls';
import { LlmMediaError } from '../core/cognitive/LlmRequest';

const APP = { type: 'app', id: 'my_app' } as any;
const RESULT = {
  provider: 'anthropic',
  model: 'claude-x',
  usage: { input: 1, cached: 0, cacheWrite: 0, output: 2, total: 3 },
  stopReason: 'end_turn',
};
const payload = (id = 'c1', over: any = {}) => ({
  id,
  request: {
    config: { model: 'anthropic/claude-x', temperature: 0.1 },
    system: 's',
    messages: [{ role: 'user', content: 'hi' }],
  },
  tag: 'conv-1',
  ...over,
});

function harness(over: Partial<{ render: any; generate: any; resolve: any }> = {}) {
  const sent: { pid: string; action: string; payload: any }[] = [];
  const render: any = vi.fn(over.render ?? (async () => 'BODY'));
  const generate: any = vi.fn(
    over.generate ??
      (async (_body: any, onChunk: (t: string) => void) => {
        onChunk('Hel');
        onChunk('lo');
        return RESULT;
      }),
  );
  const endpoint: LlmEndpointLike = { renderer: { render }, adapter: { generateStream: generate } };
  const resolveLlm: any = vi.fn(over.resolve ?? (async () => endpoint));
  const vfs = { marker: 'vfs' } as any;
  const calls = new LlmCalls({ resolveLlm, vfs, send: (pid, action, p) => sent.push({ pid, action, payload: p }) });
  return { calls, sent, render, generate, resolveLlm, vfs };
}

/** 外から解決・中断できる生成（上流が黙っている間を作る） */
function hanging() {
  let signal: AbortSignal | undefined;
  const generate = (_body: any, onChunk: (t: string) => void, s?: AbortSignal) =>
    new Promise((_resolve, reject) => {
      signal = s;
      onChunk('first');
      s?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
  return { generate, signal: () => signal };
}

describe('LlmCalls', () => {
  it('設定 → 一組 → 本文 → 送信。文字と終わりを呼んだ pid へ通知する', async () => {
    const h = harness();
    const { id, done } = h.calls.start('my_app', APP, payload());
    expect(id).toBe('c1');
    expect(h.calls.count()).toBe(1);
    await done;

    expect(h.resolveLlm).toHaveBeenCalledWith({ model: 'anthropic/claude-x', temperature: 0.1 });
    expect(h.sent).toEqual([
      { pid: 'my_app', action: 'llm:chunk', payload: { id: 'c1', text: 'Hel' } },
      { pid: 'my_app', action: 'llm:chunk', payload: { id: 'c1', text: 'lo' } },
      { pid: 'my_app', action: 'llm:end', payload: { id: 'c1', result: RESULT } },
    ]);
    expect(h.calls.count()).toBe(0);
  });

  it('添付は呼んだゲストの権限で読み、送れない添付の代わりの文は渡さない', async () => {
    const h = harness();
    await h.calls.start('my_app', APP, payload()).done;
    const [request, env] = h.render.mock.calls[0];
    expect(request).toEqual({ system: 's', messages: [{ role: 'user', parts: [{ text: 'hi' }] }] });
    expect(env.principal).toBe(APP);
    expect(env.vfs).toBe(h.vfs);
    expect(env.signal).toBeInstanceOf(AbortSignal);
    expect('mediaFallback' in env).toBe(false);
  });

  it('台帳には呼んだ pid と tag を名乗る。本文は Renderer が作ったもの', async () => {
    const h = harness();
    await h.calls.start('my_app', APP, payload()).done;
    const [body, , signal, origin] = h.generate.mock.calls[0];
    expect(body).toBe('BODY');
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(origin).toEqual({ caller: 'my_app', tag: 'conv-1' });

    const h2 = harness();
    await h2.calls.start('other', APP, payload('c1', { tag: undefined })).done;
    expect(h2.generate.mock.calls[0][3]).toEqual({ caller: 'other', tag: null });
  });

  it('形として受けられない要求は、始めずに投げる', () => {
    const h = harness();
    expect(() => h.calls.start('my_app', APP, payload('c1', { request: { messages: [] } }))).toThrow(/config\.model/);
    expect(h.calls.count()).toBe(0);
    expect(h.resolveLlm).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
  });

  it('同じ pid・同じ id が走っている間は重ねて始めない。別の pid なら同じ id でよい', async () => {
    const hang = hanging();
    const h = harness({ generate: hang.generate });
    const first = h.calls.start('my_app', APP, payload('same'));
    expect(() => h.calls.start('my_app', APP, payload('same'))).toThrow(/already running/);
    const other = h.calls.start('other_app', APP, payload('same'));
    await vi.waitFor(() => expect(h.generate).toHaveBeenCalledTimes(2));
    expect(h.calls.count()).toBe(2);
    h.calls.abortAll('my_app');
    h.calls.abortAll('other_app');
    await Promise.all([first.done, other.done]);
    // 終われば同じ id をまた使える
    expect(() => h.calls.start('my_app', APP, payload('same'))).not.toThrow();
  });

  it('失敗は llm:error（種類つき）。送れない添付は media', async () => {
    const h = harness({
      generate: async () => {
        throw new Error('Anthropic API Error (429): slow down');
      },
    });
    await h.calls.start('my_app', APP, payload()).done;
    expect(h.sent).toEqual([
      {
        pid: 'my_app',
        action: 'llm:error',
        payload: { id: 'c1', message: 'Anthropic API Error (429): slow down', code: 'failed' },
      },
    ]);

    const media = new LlmMediaError({ path: 'a.zip', mimeType: 'application/zip' }, { reason: 'mime' });
    const h2 = harness({
      render: async () => {
        throw media;
      },
    });
    await h2.calls.start('my_app', APP, payload()).done;
    expect(h2.sent).toEqual([
      { pid: 'my_app', action: 'llm:error', payload: { id: 'c1', message: media.message, code: 'media' } },
    ]);
    expect(h2.generate).not.toHaveBeenCalled();

    const h3 = harness({
      resolve: async () => {
        throw new Error('The LLM is not available.');
      },
    });
    await h3.calls.start('my_app', APP, payload()).done;
    expect(h3.sent[0].payload).toEqual({ id: 'c1', message: 'The LLM is not available.', code: 'failed' });
    expect(h3.calls.count()).toBe(0);
  });

  it('止められるのは自分の呼び出しだけ。止めたら aborted を 1 回通知し、以後の文字は運ばない', async () => {
    const hang = hanging();
    const h = harness({ generate: hang.generate });
    const { done } = h.calls.start('my_app', APP, payload('c1'));
    await vi.waitFor(() => expect(h.generate).toHaveBeenCalled());

    expect(h.calls.abort('other_app', 'c1')).toBe(false);
    expect(h.calls.abort('my_app', 'nope')).toBe(false);
    expect(h.calls.abort('my_app', 123)).toBe(false);
    expect(hang.signal()?.aborted).toBe(false);

    expect(h.calls.abort('my_app', 'c1')).toBe(true);
    expect(hang.signal()?.aborted).toBe(true);
    await done;
    expect(h.sent).toEqual([
      { pid: 'my_app', action: 'llm:chunk', payload: { id: 'c1', text: 'first' } },
      { pid: 'my_app', action: 'llm:error', payload: { id: 'c1', message: 'Aborted', code: 'aborted' } },
    ]);
    expect(h.calls.count()).toBe(0);
    expect(h.calls.abort('my_app', 'c1')).toBe(false);
  });

  it('止めたあとに上流が返してきても、終わりとして通知しない', async () => {
    let finish: (v: any) => void = () => {};
    let chunk: (t: string) => void = () => {};
    const h = harness({
      generate: (_b: any, onChunk: (t: string) => void) =>
        new Promise((resolve) => {
          chunk = onChunk;
          finish = resolve;
        }),
    });
    const { done } = h.calls.start('my_app', APP, payload());
    await vi.waitFor(() => expect(h.generate).toHaveBeenCalled());
    h.calls.abort('my_app', 'c1');
    chunk('late');
    finish(RESULT);
    await done;
    expect(h.sent).toEqual([
      { pid: 'my_app', action: 'llm:error', payload: { id: 'c1', message: 'Aborted', code: 'aborted' } },
    ]);
  });

  it('プロセスが終わったら、その pid の呼び出しを全部止める（他の pid は止めない）', async () => {
    const hang = hanging();
    const h = harness({ generate: hang.generate });
    const a1 = h.calls.start('app_a', APP, payload('1'));
    const a2 = h.calls.start('app_a', APP, payload('2'));
    const b1 = h.calls.start('app_b', APP, payload('1'));
    await vi.waitFor(() => expect(h.generate).toHaveBeenCalledTimes(3));

    expect(h.calls.abortAll('app_a')).toBe(2);
    await Promise.all([a1.done, a2.done]);
    expect(h.calls.count()).toBe(1);
    expect(h.sent.filter((s) => s.action === 'llm:error').map((s) => s.pid)).toEqual(['app_a', 'app_a']);

    expect(h.calls.abortAll('app')).toBe(0); // 前方一致で他の pid を巻き込まない
    expect(h.calls.abortAll('app_b')).toBe(1);
    await b1.done;
    expect(h.calls.count()).toBe(0);
  });

  it('組み立ての途中で止めたら、本文を作らず・送らない', async () => {
    let release: (v: any) => void = () => {};
    const h = harness({ resolve: () => new Promise((resolve) => (release = resolve)) });
    const { done } = h.calls.start('my_app', APP, payload());
    h.calls.abort('my_app', 'c1');
    release({ renderer: { render: h.render }, adapter: { generateStream: h.generate } });
    await done;
    expect(h.render).not.toHaveBeenCalled();
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.sent).toEqual([
      { pid: 'my_app', action: 'llm:error', payload: { id: 'c1', message: 'Aborted', code: 'aborted' } },
    ]);
  });
});
