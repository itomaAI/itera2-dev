/**
 * src/core/control/Engine.cdata.test.ts
 * Itera OS v2: CDATA で中身を丸ごと包む（T-0881）— Engine を通した確かめ
 *
 *   1. 丸ごと包んだ道具は、包みを外した字を中身として実行される
 *   2. 最上位で道具を CDATA で包んだ出力は実行されず、素の文字（漏れの警告）になる
 *
 * 読み方そのものの試験は Translator.test.ts。ここは本物の Translator と ToolRegistry を通す
 * （台は Engine.unclosed.test.ts と同じ）。CDATA の印と閉じタグの字面は、部品から組み立てる。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Engine, ROOT_ENGINE_ID, TurnType } from './Engine';
import { ToolRegistry } from './ToolRegistry';
import { registerSysTools } from './tools/sys_tools';
import { Translator } from '../cognitive/Translator';

const END = (tag: string) => '</' + tag + '>';

function run(output: string) {
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
  registerSysTools(registry);
  const written: any[] = [];
  const read: string[] = [];
  registry.registerSystemTool('system:test', 'Test', {
    name: 'write',
    description: 'write a file',
    impl: async (params) => {
      written.push(params);
      return { log: 'Created', trigger_llm: false };
    },
  });
  registry.registerSystemTool('system:test', 'Test', {
    name: 'read',
    description: 'read a file',
    impl: async (params) => {
      read.push(String(params.path));
      return { log: 'text', trigger_llm: false };
    },
  });

  const llm = {
    generateStream: vi.fn(async (_m: any, onChunk: (c: string) => void) => {
      onChunk(output);
    }),
  };
  const engine = new Engine(
    { history, vfs: {}, configManager: { get: () => ({}) } } as any,
    { createContext: async () => [] } as any,
    llm as any,
    new Translator(),
    registry.viewFor(ROOT_ENGINE_ID) as any,
    {},
    'realtime',
    1500,
  );
  return { engine, turns, written, read };
}

const go = async (h: ReturnType<typeof run>) => {
  await h.engine.injectUserTurn('go');
  await vi.advanceTimersByTimeAsync(1600);
  await vi.advanceTimersByTimeAsync(500);
};
const toolTurns = (h: ReturnType<typeof run>) => h.turns.filter((t) => t.meta?.type === TurnType.TOOL_EXECUTION);
/** 道具の枠の中身を [タグ名, 失敗か] で */
const outcomes = (h: ReturnType<typeof run>) =>
  toolTurns(h).flatMap((t) => t.content.map((e: any) => [e.actionType, e.output.error === true]));

describe('Engine: CDATA（T-0881）', () => {
  const OPEN = '<!' + '[CDATA[';
  const CLOSE = ']]' + '>';

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('中身を丸ごと包んだ write は、包みを外した字で実行される（自分の閉じタグの字面を含んでいても）', async () => {
    const body = "const s = '" + END('write') + '\';\n<read path="never.md" />\n';
    const h = run('<write path="s.js">' + OPEN + body + CLOSE + END('write') + '\n<yield />');
    await go(h);
    expect(h.written).toEqual([{ path: 's.js', content: body }]);
    expect(h.read).toEqual([]);
    expect(outcomes(h)).toEqual([
      ['write', false],
      ['yield', false],
    ]);
  });

  it('最上位で道具を CDATA で包んだ出力は実行されない。素の文字として、漏れの警告が積まれる', async () => {
    const h = run(OPEN + '<write path="a.txt">x' + END('write') + '\n<read path="a.md" />' + CLOSE);
    await go(h);
    expect(h.written).toEqual([]);
    expect(h.read).toEqual([]);
    expect(toolTurns(h)).toEqual([]);
    const warnings = h.turns.filter(
      (t) =>
        t.role === 'system' && typeof t.content === 'string' && t.content.includes('raw text outside of valid tags'),
    );
    expect(warnings).toHaveLength(1);
  });
});
