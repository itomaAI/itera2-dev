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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Engine, TurnType } from './Engine';
import { DEFAULT_MAX_CONTINUOUS_TOOLS } from '../sys/ConfigManager';

const ALERT_MARK = 'Max continuous tool executions';

function createHarness(preferences: any) {
  const appended: any[] = [];
  const turns: any[] = [{ id: 'u1', timestamp: 0, role: 'user', content: 'hi', meta: { trigger_llm: true } }];
  const subscribers: Function[] = [];

  // 実物の HistoryManager は IndexedDB を開くので使わない。
  // Engine が触るのは on / get / append / update の4つだけ。
  // 【重要】on() のコールバックは捨てずに繋ぐ。ここを繋がないと
  // 「履歴が変わる → 起床を予約する」という、今回の欠陥が住んでいた経路を試験できない。
  const history = {
    on: (_event: string, cb: Function) => {
      subscribers.push(cb);
      return () => {};
    },
    get: () => turns,
    append: (role: string, content: any, meta: any) => {
      const turn = { id: `a${appended.length}`, timestamp: 0, role, content, meta };
      appended.push(turn);
      turns.push(turn);
      subscribers.forEach((cb) => cb({ type: 'append', turn }));
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

  // 【重要】「履歴に積まれた」と「画面に届いた」は別のことである。
  // チャット欄は履歴を直接見ておらず、turn_end を受けて初めて描く。
  // 欠陥はまさにその隙間に住んでいたので、観測点は append ではなく通知にする。
  const turnEnds: any[] = [];
  engine.on('turn_end', (d: any) => turnEnds.push(d));

  /** 警告が turn_end として通知された回数（＝利用者の画面に出た回数） */
  const deliveredAlerts = () =>
    turnEnds.filter((d: any) => typeof d?.turn?.content === 'string' && d.turn.content.includes(ALERT_MARK));

  /** 連続実行回数を count に固定して1サイクル回し、止まったかどうかを返す */
  const runCycleAt = async (count: number) => {
    (engine as any).continuousToolCount = count;
    stops.length = 0;
    appended.length = 0;
    turnEnds.length = 0;
    createContext.mockClear();
    await (engine as any)._ping();
    return {
      stopped: stops.some((s) => s.reason === 'max_tools'),
      proceeded: createContext.mock.calls.length > 0,
      alert: appended.map((t) => t.content).find((c: any) => typeof c === 'string' && c.includes(ALERT_MARK)),
    };
  };

  /** 履歴に何か積まれた状況を作る（外部のデーモンやツール結果を模す） */
  const appendTurn = (role: string, meta: any = { trigger_llm: true }) =>
    history.append(role, '<event type="x" />', meta);

  /** デバウンス（ツール結果は 10000ms）を越えて時間を進め、予約されていた起床を走らせる */
  const flush = async () => {
    await vi.advanceTimersByTimeAsync(11000);
  };

  const alertCount = () =>
    appended.filter((t) => typeof t.content === 'string' && t.content.includes(ALERT_MARK)).length;

  const reachedProjector = () => createContext.mock.calls.length > 0;

  /** カウンタも記録も触らずに、もう一度サイクルを回す（積み上げ側の判定だけを見るため） */
  const pingAgain = async () => {
    await (engine as any)._ping();
  };

  return {
    engine,
    runCycleAt,
    pingAgain,
    appendTurn,
    flush,
    alertCount,
    deliveredAlerts,
    reachedProjector,
    createContext,
    stops,
  };
}

describe('Engine: 自律ループの連続ツール実行上限', () => {
  beforeEach(() => {
    // 番兵の例外で毎回 console.error が出るため黙らせる
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
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

/**
 * 上限に達した「後」のふるまい。
 *
 * 上限1で実物を動かしたところ、警告が約40件・1.5秒間隔で積まれ続けた。
 * 警告自身が履歴の変更であり、それが次の起床を予約してしまうため、
 * 「Auto-trigger paused」と名乗りながら実際には回り続けていた。
 * さらに、その状態で設定値を上げると、停止していたループがそのまま走り出した。
 *
 * 仕様（2026-08-18 山内さん判断）: **止まったら、利用者が発言するまで再開しない。**
 */
describe('Engine: 上限に達して停止した後', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('警告は1連続につき1回しか積まない', async () => {
    const h = createHarness({ maxContinuousTools: 1 });

    expect((await h.runCycleAt(1)).stopped).toBe(true);
    expect(h.alertCount()).toBe(1);

    // 【重要】ここは _schedulePing 側の門ではなく、積み上げ側の判定を見る試験である。
    // 時間を進めるだけでは、起床が予約されない限り _ping が再入しないので、
    // 積み上げ側を外しても落ちない（＝何も守らない試験になる）。
    // そのため _ping を直接もう一度回して、警告が増えないことを確かめる。
    await h.pingAgain();
    await h.pingAgain();
    expect(h.alertCount()).toBe(1);

    // 循環が無いことも併せて確認する
    await h.flush();
    expect(h.alertCount()).toBe(1);
  });

  it('停止中に履歴が動いても起床しない', async () => {
    const h = createHarness({ maxContinuousTools: 1 });
    await h.runCycleAt(1);
    h.createContext.mockClear();
    h.stops.length = 0;

    // 遅れて返ったツール結果やデーモンの通知が積まれた状況
    h.appendTurn('system');
    await h.flush();

    // 【重要】「実行に至らなかったこと」を見てはいけない。
    // 起床してしまっても、上限判定が同じ場所で跳ね返すので実行には至らず、
    // 予約を止める門を外しても落ちない試験になる（実際に変異試験で素通りした）。
    // 見るべきは「そもそも一度も起きなかったこと」。起床すれば loop_stop が出る。
    expect(h.stops.length).toBe(0);
    expect(h.reachedProjector()).toBe(false);
  });

  it('設定値を上げても、それだけでは再開しない（本命）', async () => {
    const preferences: any = { maxContinuousTools: 1 };
    const h = createHarness(preferences);
    await h.runCycleAt(1);
    h.createContext.mockClear();

    // 山内さんが設定アプリで上限を無制限にした、という状況。
    // 設定の書き込みは VFS イベントとして履歴にも現れる。
    preferences.maxContinuousTools = 0;
    h.appendTurn('system');
    await h.flush();

    // 上限そのものは外れているが、停止は解除されない。
    // 「設定を確認しにいっただけ」で私が走り出さないこと。
    expect(h.reachedProjector()).toBe(false);
  });

  it('利用者が発言すれば解除されて動き出す', async () => {
    const h = createHarness({ maxContinuousTools: 1 });
    await h.runCycleAt(1);
    h.createContext.mockClear();

    h.appendTurn('user');
    await h.flush();

    // 連続回数も 0 に戻るので、上限1のままでも1回は動ける
    expect(h.reachedProjector()).toBe(true);
  });
});

/**
 * 停止したことが「利用者に」見えるか。
 *
 * 上限に達したときの警告は履歴に積まれていたが、画面には一度も出ていなかった。
 * チャット欄は履歴を直接見ておらず、Engine が emit する turn_end を
 * EventOrchestrator が受けて ChatPanel.appendTurn を呼ぶ経路でしか描かないため、
 * emit を落としていた append は「記録には残るが誰も描かない」ものになっていた。
 * 利用者からは、OS が理由も言わずに黙って止まったようにしか見えない。
 *
 * したがって観測点は append ではなく通知に置く。
 * 「積まれたこと」を見る試験は、この欠陥がある状態でも通ってしまう。
 */
describe('Engine: 停止したことが利用者に見えるか', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('停止の警告は turn_end として通知される（本命）', async () => {
    const h = createHarness({ maxContinuousTools: 1 });

    const atLimit = await h.runCycleAt(1);
    expect(atLimit.stopped).toBe(true);
    // 履歴には積まれている（ここまでは欠陥のある実装でも成立していた）
    expect(h.alertCount()).toBe(1);

    // 画面へ届いたか。届いていなければ、利用者にとっては黙って止まったのと同じ。
    const delivered = h.deliveredAlerts();
    expect(delivered.length).toBe(1);
    expect(delivered[0].role).toBe('system');
    expect(delivered[0].turn.content).toContain(`(1)`);
  });

  it('通知も1連続につき1回だけ（画面が警告で埋まらない）', async () => {
    const h = createHarness({ maxContinuousTools: 1 });
    await h.runCycleAt(1);

    await h.pingAgain();
    await h.pingAgain();
    await h.flush();

    expect(h.deliveredAlerts().length).toBe(1);
  });

  it('警告文に、再開のしかたと上限の変え方が書かれている', async () => {
    // 「止まった」だけでは利用者は次に何をすればよいか分からない。
    // 特に「上限を上げても再開しない」は仕様であって、書かなければ伝わらない。
    const h = createHarness({ maxContinuousTools: 3 });
    const atLimit = await h.runCycleAt(3);

    expect(atLimit.alert).toContain('Send a message in this chat to resume');
    expect(atLimit.alert).toContain('does NOT resume');
    expect(atLimit.alert).toContain('Autonomous Loop Limit');
  });
});

/**
 * 「置くだけ」の user ターン（T-0215）。
 *   アプリのシステムタスクの前に心構えを置きたいとき、チャット欄に user ターンを積むと
 *   常に LLM が起きてしまっていた（_evaluateWakeUp は user ターンを無条件に起床の理由にしていた）。
 *   守りたいのは2点:
 *     1. trigger_llm: false を明示した user ターンは、単独では LLM を起こさない
 *     2. そのあと普通の user ターン（または trigger_llm: true のターン）が来れば起きる
 *        —— 置いたターンは消えず、次の起床で一緒に読まれる
 */
describe('Engine: LLM を起こさずに user ターンを置く', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function silentHarness() {
    const h = createHarness({});
    // 直前に自分（model）の思考があった状態にする。ここより前の user ターンは起床の理由にならない
    h.appendTurn('model', { type: 'model_thought', trigger_llm: false });
    return h;
  }

  it('trigger_llm: false の user ターンだけでは起きない', async () => {
    const h = silentHarness();
    h.appendTurn('user', { type: 'user_input', trigger_llm: false });
    await h.flush();
    expect(h.reachedProjector()).toBe(false);
  });

  it('置いたあとに普通の user ターンが来れば起きる', async () => {
    const h = silentHarness();
    h.appendTurn('user', { type: 'user_input', trigger_llm: false });
    await h.flush();
    expect(h.reachedProjector()).toBe(false);

    h.appendTurn('user', { type: 'user_input', trigger_llm: true });
    await h.flush();
    expect(h.reachedProjector()).toBe(true);
  });

  it('置いたあとにシステムタスク（trigger_llm: true の system ターン）が来れば起きる', async () => {
    const h = silentHarness();
    h.appendTurn('user', { type: 'user_input', trigger_llm: false });
    h.appendTurn('system', { type: 'event_log', trigger_llm: true });
    await h.flush();
    expect(h.reachedProjector()).toBe(true);
  });
});

describe('Engine: 起床までのデバウンス（起因で待ち幅を分ける）', () => {
  // 背景（T-0301）:
  //   ツールは並行して走り、1 つ終わるたびに共有ターンが update されて trigger_llm が立つ。
  //   すべての履歴変更を同じ 1.5 秒で起こしていたため、残りが [Pending] のまま起きていた。
  //   通常は 10 秒待ち、meta.wake === 'fast' を名乗ったターンだけ 1.5 秒で起こす。
  //   どのツールが速いかを Engine は知らない（利用者の発言・system_task・set_timer が自分で名乗る）。
  //   予約は「早い締切が勝つ」。
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 利用者の発言（injectUserTurn が wake: 'fast' を名乗る） */
  const userTurn = (h: ReturnType<typeof createHarness>) =>
    (h as any).appendTurn('user', { trigger_llm: true, wake: 'fast' });

  it('ツールの結果では 1.5 秒で起きず、10 秒で起きる（本命）', async () => {
    const h = createHarness({});
    h.appendTurn('system');
    await vi.advanceTimersByTimeAsync(1600);
    expect(h.reachedProjector()).toBe(false);
    await vi.advanceTimersByTimeAsync(9000);
    expect(h.reachedProjector()).toBe(true);
  });

  it('利用者の発言は従来どおり 1.5 秒で起きる（injectUserTurn が名乗る）', async () => {
    const h = createHarness({});
    await h.engine.injectUserTurn('hi');
    await vi.advanceTimersByTimeAsync(1600);
    expect(h.reachedProjector()).toBe(true);
  });

  it('wake: fast を名乗ったツールの結果も 1.5 秒で起きる（特別扱いはツール側の名乗りで決まる）', async () => {
    const h = createHarness({});
    h.appendTurn('system', { trigger_llm: true, wake: 'fast' });
    await vi.advanceTimersByTimeAsync(1600);
    expect(h.reachedProjector()).toBe(true);
  });

  it('名乗らない user ターンは通常の待ち（Engine は役割で特別扱いしない）', async () => {
    const h = createHarness({});
    h.appendTurn('user', { trigger_llm: true });
    await vi.advanceTimersByTimeAsync(1600);
    expect(h.reachedProjector()).toBe(false);
  });

  it('10 秒待ちの途中に利用者が発言したら、発言から 1.5 秒で起きる', async () => {
    const h = createHarness({});
    h.appendTurn('system');
    await vi.advanceTimersByTimeAsync(5000);
    userTurn(h);
    await vi.advanceTimersByTimeAsync(1400);
    expect(h.reachedProjector()).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.reachedProjector()).toBe(true);
  });

  it('起こさない変更（halt した結果など）は 10 秒待たずに止まる（画面の Processing が残らない）', async () => {
    const h = createHarness({});
    // 直前に自分の思考があった状況（そこより後ろだけが起床の判定に入る）
    h.appendTurn('model', { type: TurnType.MODEL_THOUGHT });
    h.appendTurn('system', { trigger_llm: false });
    await vi.advanceTimersByTimeAsync(1600);
    expect(h.reachedProjector()).toBe(false);
    expect(h.stops.some((s: any) => s.reason === 'idle')).toBe(true);
  });

  it('起こさない変更は、起こす変更が置いた 10 秒の締切を縮めない', async () => {
    const h = createHarness({});
    h.appendTurn('system', { trigger_llm: true });
    await vi.advanceTimersByTimeAsync(2000);
    h.appendTurn('system', { trigger_llm: false });
    await vi.advanceTimersByTimeAsync(1600);
    expect(h.reachedProjector()).toBe(false);
    await vi.advanceTimersByTimeAsync(7000);
    expect(h.reachedProjector()).toBe(true);
  });

  it('発言のあとに来たツールの結果で締切を後ろへ押さない', async () => {
    const h = createHarness({});
    userTurn(h);
    await vi.advanceTimersByTimeAsync(500);
    h.appendTurn('system');
    await vi.advanceTimersByTimeAsync(1100);
    expect(h.reachedProjector()).toBe(true);
  });
});
