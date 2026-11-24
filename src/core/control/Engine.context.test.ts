/**
 * src/core/control/Engine.context.test.ts
 * 道具に渡す文脈（T-0903）。
 *
 * 道具は権限を持たず、呼んだエンジンが渡した取っ手だけを使う（ToolContext.ts）。
 * だからエンジンが渡すのは「自分自身」と「組み立てが差した取っ手」だけで、VFS・設定・履歴そのものは渡さない
 * （渡すと、道具がそこから主体を自分で選んで触れてしまう）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Engine } from './Engine';
import { ToolRegistry } from './ToolRegistry';
import { Translator } from '../cognitive/Translator';

/* eslint-disable @typescript-eslint/no-explicit-any */
function run(output: string, extraContext: any) {
  const turns: any[] = [];
  const subscribers: Function[] = [];
  const notify = (payload: any) => subscribers.forEach((cb) => cb(payload));
  const history = {
    on: (_event: string, cb: Function) => {
      subscribers.push(cb);
      return () => {};
    },
    get: () => turns,
    append: (role: string, content: any, meta: any) => {
      const turn = { id: `t${turns.length}`, timestamp: 0, role, content, meta };
      turns.push(turn);
      notify({ type: 'append', turn });
      return turn;
    },
    update: (id: string, content: any, meta: any) => {
      const turn = turns.find((t) => t.id === id);
      if (!turn) return null;
      turn.content = content;
      turn.meta = { ...turn.meta, ...meta };
      notify({ type: 'update', turn });
      return turn;
    },
  };

  const registry = new ToolRegistry();
  const seen: any[] = [];
  registry.registerSystemTool('system:test', 'Test', {
    name: 'probe',
    description: 'records the context it was given',
    impl: async (_params, context) => {
      seen.push(context);
      return { log: 'ok', trigger_llm: false };
    },
  });

  const llm = {
    generateStream: vi.fn(async (_m: any, onChunk: (c: string) => void) => {
      onChunk(output);
    }),
  };
  const engine = new Engine(
    { history, vfs: { raw: 'vfs' }, configManager: { get: () => ({}) } } as any,
    { createContext: async () => [] } as any,
    llm as any,
    new Translator(),
    registry,
    extraContext,
    'realtime',
    1500,
  );
  return { engine, seen };
}

describe('Engine: 道具に渡す文脈（T-0903）', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('渡すのは自分自身と、組み立てが差した取っ手だけ。VFS・設定・履歴そのものは渡さない', async () => {
    const fs = { tag: 'fs' };
    const conversation = { tag: 'conversation' };
    const shell = { tag: 'shell' };
    const h = run('<probe />', { fs, conversation, shell });
    await h.engine.injectUserTurn('go');
    await vi.advanceTimersByTimeAsync(1600);
    await vi.advanceTimersByTimeAsync(500);

    expect(h.seen).toHaveLength(1);
    const context = h.seen[0];
    expect(Object.keys(context).sort()).toEqual(['conversation', 'engine', 'fs', 'shell']);
    expect(context.engine).toBe(h.engine);
    expect(context.fs).toBe(fs);
    expect(context.conversation).toBe(conversation);
    expect(context.shell).toBe(shell);
  });
});
