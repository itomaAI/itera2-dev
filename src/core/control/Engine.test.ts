/**
 * src/core/control/Engine.test.ts
 * Itera OS v2: 自律ループの連続ツール実行上限（preferences.maxContinuousTools）
 *
 * 背景:
 *   上限は Engine が持つ固定値 50 だった。これを設定で変えられるようにし、
 *   「上限なし」も選べるようにした（T-0010）。守りたいのは3点:
 *     1. 設定が無ければ従来どおり 50 で止まる（既存インストールの互換）
 *     2. 設定した値が、再起動を挟まずその場のサイクルから効く
 *     3. 0 / 負数は「上限なし」。ただし**読めない値は「上限なし」ではなく既定へ倒す**
 *        （設定の失敗が、そのまま暴走の許可に化けるのを避けるため）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Engine } from './Engine';
import { DEFAULT_MAX_CONTINUOUS_TOOLS } from '../sys/ConfigManager';

const ALERT_MARK = 'Max continuous tool executions';

function createHarness(preferences: any) {
  const appended: any[] = [];

  // 実物の HistoryManager は IndexedDB を開くので使わない。
  // Engine が触るのは on / get / append / update の4つだけ。
  const history = {
    on: () => () => {},
    get: () => [{ id: 'u1', timestamp: 0, role: 'user', content: 'hi', meta: { trigger_llm: true } }],
    append: (role: string, content: any, meta: any) => {
      const turn = { id: `a${appended.length}`, timestamp: 0, role, content, meta };
      appended.push(turn);
      return turn;
    },
    update: () => null,
  };

  // ここが呼ばれたこと ＝ 上限判定を通過したこと の証拠。
  // 先（LLM 呼び出し）へは進ませたくないので番兵の例外で抜ける。
  const createContext = vi.fn(async () => {
    throw new Error('reached-projector');
  });

  const configManager = {
    get: (category: string) => (category === 'preferences' ? preferences : {}),
  };

  const engine = new Engine(
    { history, vfs: {}, configManager } as any,
    { createContext } as any,
    { generateStream: vi.fn() } as any,
    { parse: () => [] } as any,
    { getRegisteredToolNames: () => [] } as any,
  );

  const stops: any[] = [];
  engine.on('loop_stop', (d: any) => stops.push(d));

  /** 連続実行回数を count に固定して1サイクル回し、止まったかどうかを返す */
  const runCycleAt = async (count: number) => {
    (engine as any).continuousToolCount = count;
    stops.length = 0;
    appended.length = 0;
    createContext.mockClear();
    await (engine as any)._ping();
    return {
      stopped: stops.some((s) => s.reason === 'max_tools'),
      proceeded: createContext.mock.calls.length > 0,
      alert: appended.map((t) => t.content).find((c: any) => typeof c === 'string' && c.includes(ALERT_MARK)),
    };
  };

  return { runCycleAt };
}

describe('Engine: 自律ループの連続ツール実行上限', () => {
  beforeEach(() => {
    // 番兵の例外で毎回 console.error が出るため黙らせる
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('設定が無ければ既定値（50）で止まる', async () => {
    const { runCycleAt } = createHarness({});

    expect((await runCycleAt(DEFAULT_MAX_CONTINUOUS_TOOLS - 1)).proceeded).toBe(true);

    const atLimit = await runCycleAt(DEFAULT_MAX_CONTINUOUS_TOOLS);
    expect(atLimit.stopped).toBe(true);
    expect(atLimit.proceeded).toBe(false);
    expect(atLimit.alert).toContain(`(${DEFAULT_MAX_CONTINUOUS_TOOLS})`);
  });

  it('設定した値が上限になる（本命）', async () => {
    const { runCycleAt } = createHarness({ maxContinuousTools: 5 });

    expect((await runCycleAt(4)).proceeded).toBe(true);

    const atLimit = await runCycleAt(5);
    expect(atLimit.stopped).toBe(true);
    // 警告文にも設定値が出る（50 のままだと利用者に嘘をつくことになる）
    expect(atLimit.alert).toContain('(5)');
  });

  it('設定の変更は Engine を作り直さなくても次のサイクルから効く', async () => {
    const preferences = { maxContinuousTools: 5 };
    const { runCycleAt } = createHarness(preferences);

    expect((await runCycleAt(5)).stopped).toBe(true);

    preferences.maxContinuousTools = 100;

    expect((await runCycleAt(5)).proceeded).toBe(true);
  });

  it('0 は「上限なし」を意味する', async () => {
    const { runCycleAt } = createHarness({ maxContinuousTools: 0 });
    const far = await runCycleAt(10000);
    expect(far.stopped).toBe(false);
    expect(far.proceeded).toBe(true);
  });

  it('負数（-1）も「上限なし」を意味する', async () => {
    const { runCycleAt } = createHarness({ maxContinuousTools: -1 });
    const far = await runCycleAt(10000);
    expect(far.stopped).toBe(false);
    expect(far.proceeded).toBe(true);
  });

  it('数値として書かれた文字列も受け付ける', async () => {
    // 設定アプリ側は数値化して保存するが、手で JSON を書くと文字列になりうる
    const { runCycleAt } = createHarness({ maxContinuousTools: '5' });
    expect((await runCycleAt(5)).stopped).toBe(true);
  });

  it('読めない値は「上限なし」ではなく既定値へ倒す', async () => {
    // null / '' を素朴に Number() すると 0 になり、"無制限" に化ける。
    // 設定の失敗が暴走の許可になってはならない。
    for (const bad of [null, undefined, '', '   ', 'abc', NaN, {}]) {
      const { runCycleAt } = createHarness({ maxContinuousTools: bad });
      const atDefault = await runCycleAt(DEFAULT_MAX_CONTINUOUS_TOOLS);
      expect(atDefault.stopped, `value=${JSON.stringify(bad)}`).toBe(true);
      expect(atDefault.alert).toContain(`(${DEFAULT_MAX_CONTINUOUS_TOOLS})`);
    }
  });
});
