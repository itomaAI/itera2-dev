import { describe, expect, it } from 'vitest';

import { AnthropicProjector, OpenAIProjector } from './Projector';

/**
 * 目的: **中身の無い発話を LLM へ送らない**ことを守る（T-0074）。
 *
 * 通信が切れると、本文が空のまま model のターンが履歴へ残ることがある。
 * これをそのまま送ると Anthropic は履歴全体を 400 で拒むため、
 * **たった 1 つの空白で、その会話が以後まったく続けられなくなる。**
 */

const stateOf = (turns: any[]) =>
  ({
    history: {
      // timestamp が無いとシステムプロンプトの組み立てが Invalid Date で落ちる
      get: () => turns.map((t) => ({ timestamp: '2026-08-23T00:00:00.000Z', ...t })),
      getSystemNotes: () => [],
    },
    vfs: {},
    configManager: { get: () => '' },
  }) as any;

const anthropic = () => new (AnthropicProjector as any)('システムプロンプト', {}, 'dummy-key');
const openai = () => new (OpenAIProjector as any)('システムプロンプト', {});

describe('空白の発話を履歴から落とす（T-0074）', () => {
  it('Anthropic: 空文字の model ターンは messages に入らない', async () => {
    const { messages } = await anthropic().createContext(
      stateOf([
        { role: 'user', content: 'こんにちは' },
        { role: 'model', content: '' },
        { role: 'user', content: '続けてください' },
      ]),
    );

    const texts = messages.flatMap((m: any) => m.content.map((c: any) => c.text ?? ''));
    expect(texts.some((t: string) => t.trim() === '')).toBe(false);
    expect(messages.filter((m: any) => m.role === 'assistant')).toHaveLength(0);
  });

  it('Anthropic: 空白だけの model ターンも落ちる', async () => {
    const { messages } = await anthropic().createContext(
      stateOf([
        { role: 'user', content: 'こんにちは' },
        { role: 'model', content: '   \n  ' },
      ]),
    );

    expect(messages.every((m: any) => m.content.length > 0)).toBe(true);
    expect(messages.filter((m: any) => m.role === 'assistant')).toHaveLength(0);
  });

  it('中身のある発話は落とさない', async () => {
    const { messages } = await anthropic().createContext(
      stateOf([
        { role: 'user', content: 'こんにちは' },
        { role: 'model', content: 'はい' },
      ]),
    );

    expect(messages.filter((m: any) => m.role === 'assistant')).toHaveLength(1);
  });

  it('OpenAI 系でも同じ（空の発話を送らない）', async () => {
    const messages = await openai().createContext(
      stateOf([
        { role: 'user', content: 'こんにちは' },
        { role: 'model', content: '' },
      ]),
    );

    expect(messages.filter((m: any) => m.role === 'assistant')).toHaveLength(0);
  });
});
