/**
 * src/core/control/Engine.ts
 * Itera OS v2: Autonomous Execution Loop
 */

import type { HistoryManager, Turn, TurnContent, TurnMeta } from '../state/HistoryManager';
import type { ToolExecutionEntry, ToolResult } from '../types/tools';
import type { VfsService } from '../vfs/VfsService';
import type { EngineConfigReader } from '../sys/engineConfig';
import { DEFAULT_MAX_CONTINUOUS_TOOLS } from '../sys/ConfigManager';
import type { Projector } from '../cognitive/Projector';
import { LLM_CALLER_ROOT, type BaseLLMAdapter, type LlmResult } from '../cognitive/adapters/BaseAdapter';
import type { Translator, ParsedAction } from '../cognitive/Translator';
import type { ToolView } from './ToolRegistry';
import type { ToolContext } from './ToolContext';
import { RESERVED_SYSTEM_TAGS } from '../cognitive/Translator';
import { WAKE_POLICY, WAKE_DEBOUNCE_MS, type WakePolicy } from '../../config/wake_policy';

export const TurnType = {
  USER_INPUT: 'user_input',
  MODEL_THOUGHT: 'model_thought',
  TOOL_EXECUTION: 'tool_execution',
  ERROR: 'error',
};

export interface EngineState {
  history: HistoryManager;
  vfs: VfsService;
  /** このエンジンが読む設定（OS の設定、またはそれに上書きを重ねたもの。engineConfig.ts） */
  configManager: EngineConfigReader;
}

/**
 * 返っていないツールの枠に入れる文（モデルに見える）。
 * 枠は投影に入ったあとも書き換えないので、送った時点でもあとから読み返しても正しい文に固定する（T-0597）。
 * 間に合えば枠は本物の結果で埋まり、この文は送られない。間に合わなければ、結果は新しいターンに届く。
 */
export const PENDING_LOG = '[Pending] Still running. The result will come in a later turn.';

/**
 * ルートのエンジン（OS のチャット）の id。個体の印として使う（T-0903）。
 * LLM の台帳に名乗る名前（LLM_CALLER_ROOT）と同じ値 —— エンジンは台帳に自分の id を名乗る。文字はあちらに 1 つだけ置く。
 */
export const ROOT_ENGINE_ID = LLM_CALLER_ROOT;

/** 誰が止めたか（止めた知らせの文に入る。T-0918）。知っている呼び手だけが渡す */
export type StopOrigin = { kind: 'user' } | { kind: 'app'; pid: string } | { kind: 'owner' };

export interface StopOptions {
  /** 誰が止めたか。省けば書かない */
  by?: StopOrigin;
  /** 止めた知らせを積まない（reset・dispose。会話ごと消える） */
  quiet?: boolean;
}

/** 止めた知らせの種類（`<event type>`・meta.eventType。T-0918） */
export const STOPPED_EVENT_TYPE = 'stopped';

/** 書き留めるだけの要素。道具としては投げない（結果も返らない） */
const NOTE_TAGS = new Set(['thinking', 'memo', 'plan']);

export class Engine {
  public state: EngineState;
  public projector: Projector | null;
  public llm: BaseLLMAdapter | null;
  public translator: Translator;
  /** このエンジンに見える道具（探す順と台帳は ToolRegistry.ts の ToolView が持つ） */
  public tools: ToolView;
  /**
   * このエンジンの id（生きている間だけの名前。ホストが振る）。LLM の台帳に名乗り、道具の記録と VFS の個体の印に出る（T-0903）。
   * 省いたときはルート —— 作るのは束を作る関数（EngineBundle.ts）で、そこは必ず渡す。
   */
  public readonly id: string;
  /** 道具に渡す取っ手のうち、自分が持っているもの（engine・tools）以外。組み立てが差す（ToolContext.ts） */
  public extraContext: Partial<Omit<ToolContext, 'engine' | 'tools'>>;
  /**
   * いまの会話（セッション）の id を答える口。台帳の行の `tag` に入る（T-0806）。
   * 知っているのは SessionManager なので、組み立て（SystemBootstrapper）が差す。無ければ tag は書かれない。
   */
  public sessionTag: (() => string | null) | null = null;

  public isRunning: boolean = false;
  private abortController: AbortController | null = null;

  /**
   * 走っているか: ストリーミング中か、自分が投げたツールの結果をまだ待っているか（T-0613）。
   * 会話を差し替える側（SessionManager）がこれを見て断る。走っている束を見捨てると、その結果が別の会話に落ちる。
   */
  public isBusy(): boolean {
    return this.isRunning || this.outstandingTools > 0;
  }
  private listeners: Record<string, Function[]> = {
    turn_start: [],
    stream_chunk: [],
    turn_end: [],
    loop_stop: [],
  };

  /** 起床の方針。既定は配布物の定数（試験だけが差し替える） */
  private readonly wakePolicy: WakePolicy;
  /** 起床までのデバウンス（ms）。既定は配布物の定数（試験だけが差し替える） */
  private readonly wakeDebounceMs: number;

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private continuousToolCount: number = 0;
  /** 前回の評価以降に履歴が変わったか（実行中・ツール待ちの間に来た変更を、あとで拾うため） */
  private hasPendingEvents: boolean = false;
  /** 自分が投げたツールのうち、まだ結果が返っていない本数 */
  private outstandingTools: number = 0;
  /** 前回の評価以降に、ツールの結果を待たずに起きてよい変更（方針次第。利用者の発言など）が来たか */
  private overtakeRequested: boolean = false;
  /** ツールの束の世代。stop() で見捨てた束の遅い結果が、いまの本数を減らさないようにする */
  private batchSerial: number = 0;
  /**
   * 「閉じた」束の世代（これ以下の世代は閉じている）。
   * 束は、次の投影（createContext）を取った瞬間と stop() で閉じる。
   * 閉じた束の遅い結果は枠を埋めず、返ったその時刻に新しい system ターンとして積む ——
   * モデルが一度読んだターンは、あとから変わらない（時間の順序を壊さない）。T-0326
   */
  private closedBatchSerial: number = 0;
  /** 連続実行の上限に達して停止中か。解除は利用者の発言（と明示的なタスク要求）だけ。 */
  private haltedByToolCap: boolean = false;
  /** ユーザーが明示的に停止を要求したか（デバウンス待機中・ツール実行中の停止を成立させるため） */
  private stopRequested: boolean = false;
  /**
   * いまの回（_ping）が止められ、loop_stop(abort) をまだ出していないか（T-0918）。
   * 立てるのは回の中の stop()、倒すのは _announceAbort だけ。だから回ごとにちょうど 1 度
   */
  private abortToAnnounce: boolean = false;
  /**
   * stop() が見捨てた束の世代（これ以下の束の、まだ始まっていない道具は始めない。T-0918）。
   * stopRequested は次の発言・知らせで解けるので、それで見ると見捨てた道具が走り出す
   */
  private stoppedBatchSerial: number = 0;
  /** いまの回（_ping）の終わり。回の外では null（settled() が待つ。T-0918） */
  private cycleEnded: Promise<void> | null = null;
  /** いまの回の model のターンを生成中か（束を作る前まで）。止めた知らせの文を選ぶ（T-0918） */
  private generating: boolean = false;
  /** いちばん新しい束の道具の名前と、始まったか。止めた知らせの「Not run」に使う（T-0918） */
  private lastBatch: { serial: number; names: string[]; started: boolean[] } | null = null;
  /** 履歴を聞くのをやめる口（dispose が呼ぶ） */
  private unsubscribeHistory: (() => void) | undefined;
  /** 自分が預かっているタイマー（scheduleSystemEvent）。dispose で全部取り消す */
  private readonly eventTimers = new Set<ReturnType<typeof setTimeout>>();
  /** 畳まれたか（dispose）。畳んだあとは起きず、遅い結果も積まない */
  private disposed: boolean = false;

  constructor(
    state: EngineState,
    projector: Projector | null,
    llm: BaseLLMAdapter | null,
    translator: Translator,
    tools: ToolView,
    extraContext: Partial<Omit<ToolContext, 'engine' | 'tools'>> = {},
    wakePolicy: WakePolicy = WAKE_POLICY,
    wakeDebounceMs: number = WAKE_DEBOUNCE_MS,
    id: string = ROOT_ENGINE_ID,
  ) {
    this.id = id;
    this.state = state;
    this.projector = projector;
    this.llm = llm;
    this.translator = translator;
    this.tools = tools;
    this.extraContext = extraContext;
    this.wakePolicy = wakePolicy;
    this.wakeDebounceMs = wakeDebounceMs;

    // Historyの変更を監視し、非同期でトリガーする。聞くのをやめる口は dispose が呼ぶ
    this.unsubscribeHistory = this.state.history.on('change', (payload) => this._onHistoryChange(payload));
  }

  on(event: string, callback: Function): void {
    if (this.listeners[event]) this.listeners[event].push(callback);
  }

  private _emit(event: string, data?: any): void {
    if (this.listeners[event]) {
      this.listeners[event].forEach((cb) => cb(data));
    }
  }

  /**
   * 自律ループで連続実行できるツール回数の上限。
   * `system/config/preferences.json` の `maxContinuousTools` を毎サイクル読むので、
   * 設定の変更は再起動なしで効く。**0 以下は「上限なし」を意味する。**
   *
   * 読めない値（未設定・空文字・NaN など）は「上限なし」ではなく既定値へ倒す。
   * 設定の失敗が、そのまま暴走の許可に化けるのを避けるため。
   */
  private get maxContinuousTools(): number {
    // 型は number だが、手書きの JSON では文字列など何が入っていてもおかしくない。
    // unknown として受けて、実行時に判定する。
    const raw: unknown = this.state.configManager?.get('preferences')?.maxContinuousTools;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string' && raw.trim() !== '') {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
    return DEFAULT_MAX_CONTINUOUS_TOOLS;
  }

  /**
   * システム／アプリからの明示のタスク要求（ai.task → `<event type="system_task">`）か。
   * 正は meta.eventType（chat.append が付ける）。eventType の無い古い形は本文で拾う。
   * 🔴 本文は chat.append（T-0634）が常に [{ text }] に正規化するので、文字列だけを見ると一度も当たらない
   *   （#158 以降 ai.task が連続実行の上限を解けなくなっていた。T-0638）。配列なら text を連ねて見る。
   */
  static isSystemTask(turn: Turn): boolean {
    const meta: any = turn.meta || {};
    if (meta.type !== 'event_log') return false;
    if (meta.eventType === 'system_task') return true;
    return Engine.textOf(turn.content).includes('<event type="system_task">');
  }

  private static textOf(content: TurnContent): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map((p: any) => (p && typeof p.text === 'string' ? p.text : '')).join('\n');
  }

  private _onHistoryChange(payload: any): void {
    if ((payload.type === 'append' || payload.type === 'update') && payload.turn) {
      const turn: Turn = payload.turn;

      // ユーザーの直接入力、またはシステム/アプリからの明示的なタスク要求の場合はカウントをリセットする
      if (payload.type === 'append') {
        if (turn.role === 'user' || Engine.isSystemTask(turn)) {
          this.continuousToolCount = 0;
          // 上限による停止も、ここで一緒に解除する。
          // 【重要】この解除は下の _schedulePing() より前に置くこと。
          // 後ろに置くと、解除した本人のターンでは起床できない。
          this.haltedByToolCap = false;
        }
      }

      // 自分自身の思考更新はトリガー要因にしない
      if (turn.role === 'model') return;

      // どんな履歴の変更であれ、一旦保留イベントとして覚える。
      // 起こす変更か（trigger_llm）どうかは、予約のときではなく評価（_evaluateWakeUp）で見る。
      // 起こさない変更でも評価は要る —— halt した結果や [Pending] の枠のあとに
      // loop_stop(idle) を出さないと、画面の Processing が残り続ける。
      this.hasPendingEvents = true;
      if (this._canOvertakeTools(turn)) this.overtakeRequested = true;
      this._scheduleEvaluation();
    }
  }

  /**
   * この変更は、自分が投げたツールの結果を待たずに起きてよいものか。
   * 方針は配布物ごとの定数（config/wake_policy.ts）。判定はここ 1 か所に置く。
   */
  private _canOvertakeTools(turn: Turn): boolean {
    // 起こさない変更（置くだけの発言・halt した結果・trigger_llm:false のログ・自分が積む [Pending] の枠）は
    // 追い越す理由にならない。束が返ってから評価する（そこで loop_stop(idle) が出る）
    if (turn.meta?.trigger_llm !== true) return false;
    if (this.wakePolicy === 'realtime') return true;
    // 'batch': 利用者の発言だけは追い越せる。ツールの結果・デーモンの通知は束の終わりを待つ
    return turn.role === 'user';
  }

  /**
   * 履歴の評価（→ 起床）を予約する。予約が既にあれば何もしない（締切は先着で決まる）。
   * 実行中なら finally が、ツールを待っているなら束の最後の結果が、それぞれ拾う。
   */
  private _scheduleEvaluation(): void {
    // 畳んだエンジンは起きない（stopRequested と違い、発言や wake でも解けない）
    if (this.disposed) return;
    if (this.isRunning) return;
    // 自分のツールが返るのを待っている。追い越してよい変更が来ていなければ、束の終わりを待つ
    if (this.outstandingTools > 0 && !this.overtakeRequested) return;
    // ユーザーが停止を要求した後は、実行中だったツールの結果更新などで
    // ループが自動的に再開してしまわないようにする
    if (this.stopRequested) return;
    // 連続実行の上限で停止した後は、利用者が明示的に発言するまで起床しない。
    // ここを通していると「止まった」と表示しながら回り続ける。また、設定値を
    // 上げただけで停止中のループが不意に走り出す（実測）。
    // 起床を予約する経路はここ1箇所なので、判定もここに集約する。
    if (this.haltedByToolCap) return;
    if (this.debounceTimer) return;

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.hasPendingEvents = false;
      this.overtakeRequested = false;
      this._ping();
    }, this.wakeDebounceMs);
  }

  /**
   * 起床判定ロジック：直近の履歴を評価し、LLMを発火させるべきか判断する
   */
  private _evaluateWakeUp(): boolean {
    const historyTurns = this.state.history.get();
    const lastModelIdx = historyTurns.findLastIndex(
      (t) => t.role === 'model' && t.meta && t.meta.type === TurnType.MODEL_THOUGHT,
    );

    // 自分が最後に思考を開始して以降のターンを抽出
    const recentTurns = lastModelIdx === -1 ? historyTurns : historyTurns.slice(lastModelIdx + 1);

    // 【最強トリガー】 ユーザーの入力があれば発火する。
    // ただし trigger_llm: false を明示した user ターン（「置くだけ」送信）は除く。
    // 置いたターンは履歴に残るので、次に誰かが起こしたときに一緒に読まれる。
    if (recentTurns.some((t) => t.role === 'user' && !(t.meta && t.meta.trigger_llm === false))) {
      return true;
    }

    // 【通常トリガー】 ツールの実行結果など、trigger_llm が true のターンが1つでもあれば発火する
    return recentTurns.some((t) => t.meta && t.meta.trigger_llm === true);
  }

  async injectUserTurn(inputContent: TurnContent, meta: TurnMeta = {}): Promise<Turn> {
    // 明示的な新規要求なので、以前の停止要求は解除する。
    // append() は同期的に _schedulePing() を呼ぶため、必ず append の前に解除すること。
    this.stopRequested = false;

    const turnMeta: TurnMeta = {
      type: TurnType.USER_INPUT,
      trigger_llm: true,
      ...meta,
    };
    const turn = this.state.history.append('user', inputContent, turnMeta);

    this._emit('turn_end', { role: 'user', turn });
    return turn;
  }

  /**
   * 外から評価を頼む（MetaOS.chat.wake。T-0634）。
   * 停止要求を解除し、保留として予約する。起床するかどうかは評価（_evaluateWakeUp）が履歴だけで決めるので、
   * 最後の model ターンより後ろに未読が無ければ loop_stop(idle) で終わる（空の応答は作らない）。
   * 連続実行の上限による停止（haltedByToolCap）はここでは解除しない —— それを解くのは利用者の発言だけ。
   * 自分のツールを待っている間は追い越さない（束の終わりに評価される）。
   */
  requestEvaluation(): void {
    this.stopRequested = false;
    this.hasPendingEvents = true;
    this._scheduleEvaluation();
  }

  /**
   * いまの状態（MetaOS.chat.status。T-0634）。busy はストリーミング中か結果待ちの束がある。
   * scheduled は評価の予約が在る（T-0910）: 発言や束の最後の結果のあと、起きるまでの待ち（wakeDebounceMs）の間。
   * この間は running も busy も false なので、これが無いと「止まっている」と区別が付かない。評価は idle で終わることもある。
   * 何も進んでいないのは busy も scheduled も false のとき。isBusy()（会話の差し替えを断る門）には入れない。
   */
  status(): { running: boolean; busy: boolean; outstandingTools: number; scheduled: boolean } {
    return {
      running: this.isRunning,
      busy: this.isBusy(),
      outstandingTools: this.outstandingTools,
      scheduled: this.debounceTimer !== null,
    };
  }

  /**
   * いまの回（_ping）が終わるのを待つ。回の外ならすぐ解決する（T-0918）。
   * 止めた回は、終わるまでに model のターンの更新と loop_stop(abort) を済ませる。会話を差し替える側（束の reset）は、
   * これを待ってから差し替える（待たないと、止めた回の書き込みが新しい会話に落ちる）。
   * 回が終わるのはアダプタが返ったとき。返らないアダプタでは解決しない
   */
  settled(): Promise<void> {
    return this.cycleEnded ?? Promise.resolve();
  }

  /**
   * システムからの非同期割り込みイベントを注入する（タイマーやデーモンからの通知など）
   */
  injectSystemEvent(actionType: string, message: string, meta: TurnMeta = {}): void {
    if (this.disposed) return;
    // タイマーやデーモンからの明示的な起床要求。停止によってこれらが
    // 永久に無視されてしまわないよう、ここでも停止要求を解除する。
    this.stopRequested = false;

    const turnMeta: TurnMeta = {
      type: TurnType.TOOL_EXECUTION,
      trigger_llm: true,
      ...meta,
    };

    const turnContent: ToolExecutionEntry[] = [
      {
        actionType: actionType,
        output: {
          ui: `⏰ ${message}`,
          log: `[ASYNC EVENT: ${actionType}] ${message}`,
        },
      },
    ];

    const turn = this.state.history.append('system', turnContent, turnMeta);

    this._emit('turn_end', { role: 'system', turn });
  }

  /**
   * あとで自分に知らせる（set_timer）。タイマーはエンジンが預かる ——
   * 道具が素の setTimeout でエンジンを掴むと、エンジンを畳んだあとにも鳴る（T-0903）。
   * stop() では消さない（停止のあとでも鳴って起こす。injectSystemEvent が停止要求を解く）。消すのは dispose だけ。
   */
  scheduleSystemEvent(delayMs: number, actionType: string, message: string): void {
    if (this.disposed) return;
    const timer = setTimeout(() => {
      this.eventTimers.delete(timer);
      this.injectSystemEvent(actionType, message);
    }, delayMs);
    this.eventTimers.add(timer);
  }

  private async _ping(): Promise<void> {
    this.isRunning = true;
    const controller = new AbortController();
    this.abortController = controller;
    const signal = controller.signal;
    this.abortToAnnounce = false;
    let endCycle: () => void = () => {};
    this.cycleEnded = new Promise<void>((resolve) => (endCycle = resolve));
    // 新しいサイクルを開始するため、前回の停止要求はここで解除する
    this.stopRequested = false;
    /** 止められていたら先へ進まない（中断として catch へ）。アダプタが中断を黙って普通に終えても、ここで拾う（T-0918） */
    const throwIfStopped = () => {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    };

    try {
      if (!this._evaluateWakeUp()) {
        // 【重要】ここで何も emit せずに return すると、送信時に立てられた
        // setProcessing(true) を解除する者がいなくなり "Processing..." が永久に残る
        this._emit('loop_stop', { reason: 'idle' });
        return; // 起床条件を満たさない場合は静かに待機
      }

      if (!this.projector || !this.llm) {
        console.warn('[Engine] Projector or LLM Adapter is not configured yet.');
        this._emit('loop_stop', { reason: 'not_configured' });
        return;
      }

      // 暴走チェック
      const maxContinuousTools = this.maxContinuousTools;
      if (maxContinuousTools > 0 && this.continuousToolCount >= maxContinuousTools) {
        // 【重要】警告は1連続につき1回だけ積む。
        // 警告自身も履歴の変更なので _onHistoryChange → _schedulePing を呼ぶ。
        // 無条件に積むと「警告を積む → 起床 → また上限 → 警告を積む」が延々と回る
        // （上限1で実測したとき、約40件が1.5秒間隔で積まれ続けた）。
        if (!this.haltedByToolCap) {
          this.haltedByToolCap = true;
          // 【重要】積むだけでは画面に出ない。チャット欄は履歴を直接見ておらず、
          // turn_end → EventOrchestrator → ChatPanel.appendTurn の経路でしか描かれない。
          // ここで emit を落としていたため、利用者からは「黙って止まった」ようにしか見えなかった。
          // 停止の理由は、止まった当人（AI）ではなく利用者に届かなければ意味がない。
          const alertTurn = this.state.history.append(
            'system',
            `<event type="system_alert">\nSystem Alert: Max continuous tool executions (${maxContinuousTools}) reached. Auto-trigger paused.\nSend a message in this chat to resume. Raising the limit alone does NOT resume it.\nThe limit can be changed in Settings > Autonomous Loop Limit (0 = unlimited).\n</event>`,
            {
              type: TurnType.ERROR,
              trigger_llm: false,
            },
          );
          this._emit('turn_end', { role: 'system', turn: alertTurn });
        }
        // loop_stop は毎回 emit する。ここを黙って return すると
        // UI の "Processing..." を解除する者がいなくなる。
        this._emit('loop_stop', { reason: 'max_tools' });
        return;
      }

      // ここで束を閉じる。この投影に入らなかった結果は、枠ではなく新しいターンへ届く
      this.closedBatchSerial = this.batchSerial;
      const messages = await this.projector.createContext(this.state, signal);
      // 畳まれた: 回の残りは何も書かず、何も知らせない（loop_stop(abort) は dispose が出した。T-0918）
      if (this.disposed) return;
      // 投影の中で止められた: 空の model のターンを積まず、アダプタも呼ばない
      throwIfStopped();

      // 空のMODELターンをHistoryに追加 (自己トリガーを防ぐため trigger_llm: false)
      const modelTurn = this.state.history.append('model', '', {
        type: TurnType.MODEL_THOUGHT,
        trigger_llm: false,
      });
      this.generating = true;

      this._emit('turn_start', { role: 'model', turnId: modelTurn.id });

      let rawResponse = '';
      let streamError: any = null;
      let result: LlmResult | null = null;

      try {
        result =
          (await this.llm.generateStream(
            messages,
            (chunk: string) => {
              rawResponse += chunk;
              this._emit('stream_chunk', chunk);
            },
            signal,
            { caller: this.id, engineTurn: true, tag: this.sessionTag ? this.sessionTag() : null },
          )) || null;
      } catch (err) {
        streamError = err;
      }
      if (this.disposed) return;
      // 止めた回は、アダプタが普通に返しても中断として扱う（AbortError の道と同じ形で残す。T-0918）
      if (!streamError && signal.aborted) {
        streamError = new DOMException('Aborted', 'AbortError');
        result = null;
      }

      // 生成の結果（使ったトークン・止まった理由）は、その生成が作ったターンに置く（T-0806）。
      // 「この会話の文脈はいま何トークンか」は履歴から答える（chat.status）。台帳は読み戻さない。
      // 失敗・中断のときは結果が無いので何も置かない。
      const updatedTurn = this.state.history.update(modelTurn.id, rawResponse, {
        status: streamError ? 'error' : 'completed',
        ...(result
          ? { model: result.model, stopReason: result.stopReason, ...(result.usage ? { usage: result.usage } : {}) }
          : {}),
      });

      if (updatedTurn) {
        this._emit('turn_end', { role: 'model', turn: updatedTurn });
      }

      if (streamError) throw streamError;
      // turn_end(model) の聞き手の中で止められた
      throwIfStopped();

      // ツール解釈とアクションの抽出
      const registeredTools = this.tools.getRegisteredToolNames();
      const actions = this.translator.parse(rawResponse, registeredTools);

      // 終端タグより後ろの出力（T-0593）。
      // 以前はここで履歴のモデルのターンを終端タグまでに切り詰めていた（古い LLM では、
      // 偽装した <tool_output> などが履歴に残ること自体が次の誤りを誘ったため）。
      // しかし履歴を書き換えると、モデルが実際に出した文字列と履歴が食い違い、プロンプトの
      // キャッシュが当たらなくなる。いまは出力をそのまま残し、後ろは解釈も実行もせず、
      // LPML 違反と同じく system の警告を積む。後ろが空白だけなら何もしない。
      const trailingWarning = Engine.trailingWarning(actions);
      if (trailingWarning) {
        const warningTurn = this.state.history.append('system', trailingWarning, {
          type: TurnType.ERROR,
          trigger_llm: false,
        });
        this._emit('turn_end', { role: 'system', turn: warningTurn });
      }

      // 生テキストの漏洩（LPML文法違反）のパッシブ警告
      if (actions.hasLeak) {
        const warningMsg = [
          `<system type="syntax_warning">`,
          `[LPML Syntax Violation] You output raw text outside of valid tags.`,
          `ABSOLUTE PROHIBITION: All responses must be enclosed in valid tags (e.g., <memo>, <report>, <yield />). Raw text is ignored.`,
          `</system>`,
        ].join('\n');

        const warningTurn = this.state.history.append('system', warningMsg, {
          type: TurnType.ERROR,
          trigger_llm: false,
        });

        this._emit('turn_end', { role: 'system', turn: warningTurn });
      }

      // 書き留めるだけの要素は投げない。ただし閉じていない要素は、種類を問わず投げる（T-0878）:
      // 実行はされず、ToolRegistry が「閉じていない」という失敗の結果を返す。ここで黙って落とすと、
      // 閉じ忘れた memo が後ろのタグを中身として飲み込んだことが、モデルに伝わらない
      const validActions = actions.filter((a) => !a.closed || !NOTE_TAGS.has(a.type));
      // 警告の turn_end の聞き手の中で止められた: 束を作らない
      throwIfStopped();
      this.generating = false;

      if (validActions.length > 0) {
        this.continuousToolCount++;
        // 枠の turn_end の聞き手・最初の道具の execute の中で止められたら、知らせは finally が出す
        this._dispatchActions(validActions);
      } else {
        this.continuousToolCount = 0;
        this._emit('loop_stop', { reason: 'idle' });
      }
    } catch (error: any) {
      if (this.disposed) return;
      if (error.name === 'AbortError' || signal.aborted) {
        console.log('[Engine] Aborted.');
        // stop() を通らずに来た AbortError も、いままでどおり abort として 1 度知らせる
        this.abortToAnnounce = true;
        this._announceAbort();
      } else {
        console.error('[Engine] Error:', error);
        const errTurn = this.state.history.append(
          'system',
          `<event type="system_error">\nSystem Error: ${error.message}\n</event>`,
          {
            type: TurnType.ERROR,
            trigger_llm: false,
          },
        );
        this._emit('turn_end', { role: 'system', turn: errTurn });
        this._emit('loop_stop', { reason: 'error', error });
      }
    } finally {
      this.generating = false;
      // 止められたのにまだ知らせていなければ、ここで出す（流れのあとの同期の窓で止めた場合）
      this._announceAbort();
      this.isRunning = false;
      this.abortController = null;
      this.cycleEnded = null;
      endCycle();
      // 実行中に来た変更を拾う。ツールを投げた直後は outstandingTools > 0 なので、
      // 追い越せる変更（方針次第）が来ていなければ、ここでは予約されず、束の最後の結果が拾う
      if (this.hasPendingEvents) this._scheduleEvaluation();
    }
  }

  /**
   * 終端タグより後ろに何か書かれていたときの警告。後ろが空白だけ（または終端タグが無い）なら null。
   * 後ろに OS しか出さないタグ（<tool_output> など）があれば「システム専用のタグを書いた」として、そうでなければ
   * 「終端タグの後ろは無視した」として返す。文言は英語（LLM に読ませる文。itera2 系とミャク楽で共通）
   */
  static trailingWarning(actions: {
    terminalTag?: string | null;
    trailingText?: string;
    trailingTags?: string[];
  }): string | null {
    const text = actions.trailingText ?? '';
    if (!actions.terminalTag || !text.trim()) return null;
    const term = actions.terminalTag === 'ask' ? '</ask>' : `<${actions.terminalTag} />`;
    const tags = actions.trailingTags ?? [];
    const forged = tags.filter((t) => RESERVED_SYSTEM_TAGS.has(t));
    if (forged.length) {
      // 口調は穏やかに（T-0858。山内さん「自罰的になられても意味がない。システムは無視する、やっちゃったらいい感じに
      // リカバリしてね、くらいの温度感で」）。事実（無視した・実行していない・結果はシステムが次のターンに出す）は落とさない
      return [
        `<system type="syntax_warning">`,
        `Your last turn went on after its terminal tag ${term} and wrote ${forged.map((t) => `<${t}>`).join(', ')}, which only the system writes. That part was ignored and not executed; everything before ${term} ran as usual, and your text stays in the history as you wrote it.`,
        `Tool results always come from the system in the next turn, so there is no need to write them yourself. Continue from the real results.`,
        `</system>`,
      ].join('\n');
    }
    const shown = tags.slice(0, 8).map((t) => `<${t}>`);
    return [
      `<system type="syntax_warning">`,
      `Your last turn went on after its terminal tag ${term}. That part was ignored and not executed${shown.length ? ` (including ${shown.join(', ')}${tags.length > shown.length ? ', ...' : ''})` : ''}; everything before ${term} ran as usual, and your text stays in the history as you wrote it.`,
      `No harm done. If you still need any of those actions, request them in this turn.`,
      `</system>`,
    ].join('\n');
  }

  private _dispatchActions(actions: ParsedAction[]): void {
    // 【重要】このメソッドは await されずに呼ばれるため、実際にツールが動き出す頃には
    // _ping() の finally が this.abortController = null を実行済みになっている。
    // そのため this.abortController を後から参照する中断チェックは常に無効(undefined)だった。
    // 呼び出し時点（まだ非null）でシグナルをローカルに捕捉しておく。
    const signal = this.abortController?.signal;

    // 道具に渡すのは取っ手だけ（T-0903。ToolContext.ts）。VFS・設定・履歴そのものは渡さない
    const context = { engine: this, tools: this.tools, ...this.extraContext } as ToolContext;

    const combinedResults: ToolExecutionEntry[] = actions.map((action) => {
      const { content, ...safeParams } = action.params || {};
      return {
        actionType: action.type,
        originalIndex: action.originalIndex,
        params: safeParams,
        output: {
          log: PENDING_LOG,
          ui: `⚙️ Executing ${action.type}...`,
          trigger_llm: false,
        },
      };
    });

    const getSortedResults = () => {
      return [...combinedResults].sort((a, b) => (a.originalIndex ?? 0) - (b.originalIndex ?? 0));
    };

    // 束の本数を先に数える（枠を積む前に）。全部返るまで待つかどうかは方針（wakePolicy）が決める。
    // 世代（batchSerial）は stop() で見捨てた束の遅い結果を数えないため
    const batch = ++this.batchSerial;
    this.outstandingTools = actions.length;
    const record = { serial: batch, names: actions.map((a) => a.type), started: actions.map(() => false) };
    this.lastBatch = record;
    /** 1 本返った（または走らせなかった）。この束のものなら本数を減らす */
    const settleOne = () => {
      if (batch !== this.batchSerial) return;
      this.outstandingTools = Math.max(0, this.outstandingTools - 1);
      // 履歴を更新しない経路（停止で走らせなかった）でも、待っていた変更を取り残さない
      if (this.outstandingTools === 0 && this.hasPendingEvents) this._scheduleEvaluation();
    };

    const sharedTurn = this.state.history.append('system', getSortedResults(), {
      type: TurnType.TOOL_EXECUTION,
      trigger_llm: false,
    });

    const sharedTurnId = sharedTurn.id;

    // 【重要】[Pending] の枠も、この時点で画面へ出す。
    // 出さないと、枠は最初の結果が届くまで描かれず、その前に次のモデルの発話が始まると
    // 画面では MODEL → USER → MODEL → SYSTEM の順になる（履歴の中の順は正しいのに）。T-0326
    this._emit('turn_end', { role: 'system', turn: sharedTurn });

    /** 結果の集まりが LLM を起こすか。エラーが 1 つでもあれば起こす。halt があれば起こさない */
    const triggerOf = (outputs: ToolResult[]) => {
      let willTrigger = false;
      let isHalted = false;
      let hasError = false;

      outputs.forEach((o) => {
        if (o.trigger_llm !== false) willTrigger = true;
        if (o.halt_loop === true) isHalted = true;
        if (o.error === true) hasError = true;
      });

      if (hasError) return true;
      return isHalted ? false : willTrigger;
    };
    const calcTurnTrigger = () => triggerOf(combinedResults.map((r) => r.output));

    /**
     * 返った結果を届ける。束が開いていれば枠を埋める。
     * 閉じていれば（次の投影が取られたあと・停止のあと）、枠には「あとで返った」の印だけを置き、
     * 結果そのものは返ったこの時刻に新しい system ターンとして積む。
     * 投影は最後の model ターンより後ろのターンを起床の理由に数えるので、これで遅い結果も起こせる。
     *
     * 【重要】失敗した結果でも、ターンの type は TOOL_EXECUTION のまま変えない（T-0593）。
     * Projector は type が tool_execution の配列ターンしか <tool_output> に組まない。
     * 以前は失敗が 1 本あるとターンを ERROR にしていたため、同じ束の成功した結果ごと
     * 文脈から消えていた。失敗は各結果の error（→ status="error"）で伝わる。
     */
    const deliver = (index: number, output: ToolResult) => {
      // 畳んだあとに返った結果は捨てる。届け先の会話は、もうこのエンジンのものではない
      if (this.disposed) return;
      // 本数を減らしてから履歴を更新する。最後の 1 本なら、この更新の変更通知が起床を予約する
      settleOne();
      if (batch > this.closedBatchSerial) {
        combinedResults[index].output = output;
        const updatedTurn = this.state.history.update(sharedTurnId, getSortedResults(), {
          trigger_llm: calcTurnTrigger(),
        });
        if (updatedTurn) this._emit('turn_end', { role: 'system', turn: updatedTurn });
        return;
      }

      // 画面の印だけを変える。log（モデルに見える文）は [Pending] のまま触らない（T-0597）。
      // この枠はもう投影に入って送られている。log を書き換えると、次の投影で過去の文字列が変わり、
      // 前置の一致で引き当てるセッションの再利用やプロンプトキャッシュがそこから外れていた。
      // PENDING_LOG は「あとで返る」としか言わないので、書き換えなくても嘘にならない。
      // meta も触らない（起こす理由は下の新しいターンが持つ）
      combinedResults[index].output = {
        ...combinedResults[index].output,
        ui: `⏩ Returned later`,
        trigger_llm: false,
      };
      const markedTurn = this.state.history.update(sharedTurnId, getSortedResults());
      if (markedTurn) this._emit('turn_end', { role: 'system', turn: markedTurn });

      const lateEntry: ToolExecutionEntry = {
        ...combinedResults[index],
        output: {
          ...output,
          log: `[Late result of the tool dispatched in an earlier turn]\n${output.log ?? ''}`,
        },
      };
      const lateTurn = this.state.history.append('system', [lateEntry], {
        type: TurnType.TOOL_EXECUTION,
        trigger_llm: triggerOf([output]),
      });
      this._emit('turn_end', { role: 'system', turn: lateTurn });
    };

    actions.forEach(async (action, index) => {
      // ツール実行の順序をある程度維持するため、インデックスに応じて開始をわずかに遅らせる (50ms間隔)
      if (index > 0) {
        await new Promise((resolve) => setTimeout(resolve, index * 50));
      }

      // 待機中に止められた束の道具は始めない。見るのは束の世代（stop() が見捨てた束か。T-0918）。
      // 回の中で止めた場合は、捕捉済みの signal も aborted
      if (batch <= this.stoppedBatchSerial || signal?.aborted || this.disposed) {
        settleOne();
        return;
      }

      record.started[index] = true;
      try {
        const result = await this.tools.execute(action, context);

        deliver(index, result ?? { log: '', trigger_llm: false });
      } catch (err: any) {
        // ツールの失敗（未登録のタグを含む）は ToolRegistry が結果として返す。
        // ここに来るのは想定外の例外だけ。それでも同じ形の失敗として届ける。
        deliver(index, {
          log: `Error: ${err.message}`,
          ui: `❌ Error: ${err.message}`,
          error: true,
          trigger_llm: true,
        });
      }
    });
  }

  stop(options: StopOptions = {}): void {
    // 止めた知らせの文は、止める前の様子（何が動いていたか）で決める
    const notice = options.quiet || this.disposed ? null : this._stoppedNotice(options.by);
    // 停止要求を記録する。ストリーミング中以外（デバウンス待機中・ツール実行中）でも
    // 確実に停止させるためのフラグ。
    this.stopRequested = true;

    // デバウンス待機中に押された場合、タイマーが生きていると1.5秒後に生成が始まってしまう
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    // 動いていたものを止めたら、新しい 1 ターンで伝える（起こさない。既存のターンは書き換えない）。
    // 止めた model のターン・枠の後ろ、loop_stop(abort) の前（T-0918）
    if (notice) {
      const turn = this.state.history.append('system', notice, {
        type: 'event_log',
        eventType: STOPPED_EVENT_TYPE,
        trigger_llm: false,
      });
      this._emit('turn_end', { role: 'system', turn });
    }
    this.hasPendingEvents = false;
    this.overtakeRequested = false;
    // 走っている束は見捨てる（閉じる）。遅れて届いた結果は新しいターンとして履歴に入るが、
    // 本数には数えず、利用者が次に発言するまで起こさない（stopRequested が予約を止める）。
    // まだ始まっていない道具は、あとの発言で stopRequested が解けても始めない（stoppedBatchSerial）
    this.closedBatchSerial = this.batchSerial;
    this.stoppedBatchSerial = this.batchSerial;
    this.batchSerial++;
    this.outstandingTools = 0;

    if (this.abortController) {
      // 回の中（投影・生成・流れのあとの同期の窓）: 中断を伝えるだけ。loop_stop(abort) は回の終わりが 1 度出す（_announceAbort）。
      // 2 度目の stop() は何もしない（T-0918）
      if (!this.abortController.signal.aborted) {
        this.abortToAnnounce = true;
        this.abortController.abort();
      }
    } else {
      // abortController が存在しない時間帯（デバウンス待機中／ツール実行中）は
      // 誰も loop_stop を emit しないため、UIが "Processing..." のまま固着する。
      // ここで明示的に emit して確実に解除する。
      this._emit('loop_stop', { reason: 'abort' });
    }
  }

  /** stop() が積む知らせ。何も動いていなければ null（T-0918） */
  private _stoppedNotice(by?: StopOrigin): string | null {
    const inCycle = this.abortController !== null && !this.abortController.signal.aborted;
    if (inCycle && this.generating) return Engine.stoppedEvent('generation', by);
    const batch = this.lastBatch;
    if (batch && batch.serial === this.batchSerial && this.outstandingTools > 0) {
      return Engine.stoppedEvent(
        'tools',
        by,
        batch.names.filter((_, i) => !batch.started[i]),
      );
    }
    return null;
  }

  /** 止めた知らせの文（T-0918。英語。モデルが読む） */
  static stoppedEvent(phase: 'generation' | 'tools', by?: StopOrigin, notRun: string[] = []): string {
    const who =
      by?.kind === 'user'
        ? ' by the user'
        : by?.kind === 'app'
          ? ` by an app (${by.pid})`
          : by?.kind === 'owner'
            ? ' by the owner'
            : '';
    const text =
      phase === 'generation'
        ? `Generation stopped${who}. Nothing in that turn was run.`
        : `Tool execution stopped${who}.${notRun.length ? ` Not run: ${notRun.join(', ')}.` : ''}`;
    return `<event type="${STOPPED_EVENT_TYPE}">\n${text}\n</event>`;
  }

  /** 止めた回の loop_stop(abort) を出す。出す番でなければ何もしない（T-0918） */
  private _announceAbort(): void {
    if (!this.abortToAnnounce) return;
    this.abortToAnnounce = false;
    this._emit('loop_stop', { reason: 'abort' });
  }

  /**
   * 畳む（T-0903）。止め、履歴を聞くのをやめ、預かったタイマーを取り消す。以後に返った道具の結果は捨てる。
   * stop() との違い: 止めたエンジンは次の発言で起き、遅い結果も新しいターンとして受け取る。畳んだエンジンは何もしない。
   * 畳むのは束（EngineBundle.ts）。ルートのエンジンは畳まれない。
   */
  dispose(): void {
    if (this.disposed) return;
    this.stop({ quiet: true });
    // 回の中でも、loop_stop(abort) はここで出す（止まっているときと同じく、畳んだ知らせより先。T-0918）
    this._announceAbort();
    this.disposed = true;
    this.unsubscribeHistory?.();
    this.unsubscribeHistory = undefined;
    for (const timer of this.eventTimers) clearTimeout(timer);
    this.eventTimers.clear();
  }
}
