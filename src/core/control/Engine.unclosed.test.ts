/**
 * src/core/control/Engine.unclosed.test.ts
 * Itera OS v2: 閉じていない要素は実行しない（T-0878）
 *
 * 背景:
 *   以前は、文字の終わりまで開いたままの要素を「そこで閉じたもの」として実行していた。出力が途中で切れた write は
 *   途中までの中身でファイルを書き、閉じ忘れた memo は後ろの道具を黙って飲み込んだ（どちらも警告なし）。
 *   いまは:
 *     1. 実行されるのは閉じた要素だけ（空タグか、自分の閉じタグで終わった要素）
 *     2. 閉じていない要素は道具を呼ばず、その 1 本の失敗の結果として返る（モデルは起きて、書き直せる）
 *     3. 書き留めるだけの要素（memo など）も、閉じていなければ同じ失敗として返る
 *     4. 閉じた要素の扱いは変えない（同じターンの、閉じている道具は実行される。閉じた memo は投げない）
 *
 * 本物の Translator と ToolRegistry を通す（判定は Translator、断るのは ToolRegistry、Engine は運ぶだけ）。
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

describe('Engine: 閉じていない要素は実行しない（T-0878）', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('途中で切れた write は実行されず、その 1 本の失敗として返る。モデルは起きる', async () => {
    const h = run('<memo>m</memo>\n<write path="a.txt">line1\nline2');
    await go(h);
    expect(h.written).toEqual([]);
    expect(outcomes(h)).toEqual([['write', true]]);
    const entry = toolTurns(h)[0].content[0];
    expect(entry.params).toEqual({ path: 'a.txt' });
    expect(entry.output.log).toContain('<write> was not closed, so it was not executed');
    expect(toolTurns(h)[0].meta.trigger_llm).toBe(true);
  });

  it('閉じた write は従来どおり実行される', async () => {
    const h = run('<write path="a.txt">x' + END('write') + '\n<yield />');
    await go(h);
    expect(h.written).toEqual([{ path: 'a.txt', content: 'x' }]);
    expect(outcomes(h)).toEqual([
      ['write', false],
      ['yield', false],
    ]);
  });

  it('同じターンの、閉じている道具は実行される（閉じていないものだけが断られる）', async () => {
    const h = run('<read path="a.md" />\n<write path="b.txt">partial');
    await go(h);
    expect(h.read).toEqual(['a.md']);
    expect(h.written).toEqual([]);
    expect(outcomes(h)).toEqual([
      ['read', false],
      ['write', true],
    ]);
  });

  it('閉じ忘れた memo が飲み込んだ道具は実行されない。memo の失敗として返る（黙って落とさない）', async () => {
    const h = run('<memo>note\n<read path="a.md" />\n<yield />');
    await go(h);
    expect(h.read).toEqual([]);
    expect(outcomes(h)).toEqual([['memo', true]]);
    expect(toolTurns(h)[0].content[0].output.log).toContain('<memo> was not closed');
    expect(toolTurns(h)[0].meta.trigger_llm).toBe(true);
  });

  it('閉じた memo は従来どおり投げない（道具の枠は出来ない）', async () => {
    const h = run('<memo>note</memo>');
    await go(h);
    expect(toolTurns(h)).toEqual([]);
  });

  it('中身の行頭の yield で切れて、タグを戻された write（Gemini の停止文字列。T-0877）も実行されない', async () => {
    const h = run('<write path="doc.md">\n# Turn\nEnd each turn with:\n<yield />');
    await go(h);
    expect(h.written).toEqual([]);
    expect(outcomes(h)).toEqual([['write', true]]);
  });
});
