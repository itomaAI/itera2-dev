/**
 * src/core/control/Engine.ts
 * Itera OS v2: Autonomous Execution Loop
 */

import type { HistoryManager, Turn, TurnContent, TurnMeta } from '../state/HistoryManager';
import type { ToolExecutionEntry } from '../types/tools';
import type { VfsService } from '../vfs/VfsService';
import type { ConfigManager } from '../sys/ConfigManager';
import { DEFAULT_MAX_CONTINUOUS_TOOLS } from '../sys/ConfigManager';
import type { BaseProjector } from '../cognitive/Projector';
import type { BaseLLMAdapter } from '../cognitive/adapters/BaseAdapter';
import type { Translator, ParsedAction } from '../cognitive/Translator';
import type { ToolRegistry } from './ToolRegistry';
import { RESERVED_SYSTEM_TAGS } from '../cognitive/Translator';

/**
 * 起床までのデバウンス（ms）。
 * 通常は長めに待つ —— ツールは並行して走り、1 つ終わるたびに共有ターンが update されて
 * trigger_llm が立つので、短いと残りが [Pending] のまま起きてしまう。
 * meta.wake === 'fast' を名乗ったターンだけ短く待つ。どのツールが速いかを Engine は知らない
 * （利用者の発言・system_task・set_timer などが自分で名乗る）。
 */
export const WAKE_DEBOUNCE_MS = 10000;
export const FAST_WAKE_DEBOUNCE_MS = 1500;

export const TurnType = {
  USER_INPUT: 'user_input',
  MODEL_THOUGHT: 'model_thought',
  TOOL_EXECUTION: 'tool_execution',
  ERROR: 'error',
};

export interface EngineState {
  history: HistoryManager;
  vfs: VfsService;
  configManager: ConfigManager;
}

export class Engine {
  public state: EngineState;
  public projector: BaseProjector | null;
  public llm: BaseLLMAdapter | null;
  public translator: Translator;
  public registry: ToolRegistry;
  public extraContext: Record<string, any>;

  public isRunning: boolean = false;
  private abortController: AbortController | null = null;
  private listeners: Record<string, Function[]> = {
    turn_start: [],
    stream_chunk: [],
    turn_end: [],
    loop_stop: [],
  };

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** 予約済みの起床時刻（epoch ms）。早い締切が勝つ判定に使う。0 は未予約 */
  private debounceDeadline: number = 0;
  private continuousToolCount: number = 0;
  private hasPendingEvents: boolean = false;
  /** 連続実行の上限に達して停止中か。解除は利用者の発言（と明示的なタスク要求）だけ。 */
  private haltedByToolCap: boolean = false;
  /** ユーザーが明示的に停止を要求したか（デバウンス待機中・ツール実行中の停止を成立させるため） */
  private stopRequested: boolean = false;

  constructor(
    state: EngineState,
    projector: BaseProjector | null,
    llm: BaseLLMAdapter | null,
    translator: Translator,
    registry: ToolRegistry,
    extraContext: Record<string, any> = {},
  ) {
    this.state = state;
    this.projector = projector;
    this.llm = llm;
    this.translator = translator;
    this.registry = registry;
    this.extraContext = extraContext;

    // Historyの変更を監視し、非同期でトリガーする
    this.state.history.on('change', (payload) => this._onHistoryChange(payload));
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

  private _onHistoryChange(payload: any): void {
    if ((payload.type === 'append' || payload.type === 'update') && payload.turn) {
      const turn: Turn = payload.turn;

      // ユーザーの直接入力、またはシステム/アプリからの明示的なタスク要求の場合はカウントをリセットする
      if (payload.type === 'append') {
        if (
          turn.role === 'user' ||
          (turn.meta &&
            turn.meta.type === 'event_log' &&
            typeof turn.content === 'string' &&
            turn.content.includes('<event type="system_task">'))
        ) {
          this.continuousToolCount = 0;
          // 上限による停止も、ここで一緒に解除する。
          // 【重要】この解除は下の _schedulePing() より前に置くこと。
          // 後ろに置くと、解除した本人のターンでは起床できない。
          this.haltedByToolCap = false;
        }
      }

      // 自分自身の思考更新はトリガー要因にしない
      if (turn.role === 'model') return;

      // どんな履歴の変更であれ、一旦保留イベントとしてスケジュールする
      this.hasPendingEvents = true;
      this._schedulePing(turn.meta?.wake === 'fast' ? FAST_WAKE_DEBOUNCE_MS : WAKE_DEBOUNCE_MS);
    }
  }

  private _schedulePing(delay: number = WAKE_DEBOUNCE_MS): void {
    // 実行中に来た予約は finally で拾う。締切だけ手前へ寄せておく
    if (this.isRunning) {
      const deadline = Date.now() + delay;
      if (this.debounceDeadline === 0 || deadline < this.debounceDeadline) this.debounceDeadline = deadline;
      return;
    }
    // ユーザーが停止を要求した後は、実行中だったツールの結果更新などで
    // ループが自動的に再開してしまわないようにする
    if (this.stopRequested) return;
    // 連続実行の上限で停止した後は、利用者が明示的に発言するまで起床しない。
    // ここを通していると「止まった」と表示しながら回り続ける。また、設定値を
    // 上げただけで停止中のループが不意に走り出す（実測）。
    // 起床を予約する経路はここ1箇所なので、判定もここに集約する。
    if (this.haltedByToolCap) return;

    // 早い締切が勝つ。10 秒待ちの途中に利用者が発言したら 1.5 秒で起きる。
    // 逆に、発言のあとに来たツール結果で締切を後ろへ押さない
    const now = Date.now();
    const deadline = now + delay;
    if (this.debounceTimer && this.debounceDeadline !== 0 && this.debounceDeadline <= deadline) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);

    this.debounceDeadline = deadline;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.debounceDeadline = 0;
      this.hasPendingEvents = false;
      this._ping();
    }, delay);
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

  async injectUserTurn(inputContent: TurnContent, meta: TurnMeta = {}): Promise<void> {
    // 明示的な新規要求なので、以前の停止要求は解除する。
    // append() は同期的に _schedulePing() を呼ぶため、必ず append の前に解除すること。
    this.stopRequested = false;

    const turnMeta: TurnMeta = {
      type: TurnType.USER_INPUT,
      trigger_llm: true,
      wake: 'fast', // 利用者の発言は待たせない
      ...meta,
    };
    const turn = this.state.history.append('user', inputContent, turnMeta);

    this._emit('turn_end', { role: 'user', turn });
  }

  /**
   * システムからの非同期割り込みイベントを注入する（タイマーやデーモンからの通知など）
   */
  injectSystemEvent(actionType: string, message: string, meta: TurnMeta = {}): void {
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

  private async _ping(): Promise<void> {
    this.isRunning = true;
    this.abortController = new AbortController();
    // 新しいサイクルを開始するため、前回の停止要求はここで解除する
    this.stopRequested = false;

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

      const messages = await this.projector.createContext(this.state, this.abortController.signal);

      // 空のMODELターンをHistoryに追加 (自己トリガーを防ぐため trigger_llm: false)
      const modelTurn = this.state.history.append('model', '', {
        type: TurnType.MODEL_THOUGHT,
        trigger_llm: false,
      });

      this._emit('turn_start', { role: 'model', turnId: modelTurn.id });

      let rawResponse = '';
      let streamError: any = null;

      try {
        await this.llm.generateStream(
          messages,
          (chunk: string) => {
            rawResponse += chunk;
            this._emit('stream_chunk', chunk);
          },
          this.abortController.signal,
        );
      } catch (err) {
        streamError = err;
      }

      const updatedTurn = this.state.history.update(modelTurn.id, rawResponse, {
        status: streamError ? 'error' : 'completed',
      });

      if (updatedTurn) {
        this._emit('turn_end', { role: 'model', turn: updatedTurn });
      }

      if (streamError) throw streamError;

      // ツール解釈とアクションの抽出
      const registeredTools = this.registry.getRegisteredToolNames();
      const actions = this.translator.parse(rawResponse, registeredTools);

      // 終端タグによる切り詰めが発生した場合のリカバリ
      if (actions.isTruncated && actions.truncatedText) {
        const truncatedTurn = this.state.history.update(modelTurn.id, actions.truncatedText, { status: 'completed' });
        if (truncatedTurn) {
          this._emit('turn_end', { role: 'model', turn: truncatedTurn });
        }
      }

      // 生テキストの漏洩（LPML文法違反）のパッシブ警告
      if (actions.hasLeak) {
        const warningMsg = [
          `<system type="syntax_warning">`,
          `[LPML Syntax Violation] You output raw text outside of valid tags.`,
          `ABSOLUTE PROHIBITION: All responses must be enclosed in valid tags (e.g., <report>, <yield />). Raw text is ignored.`,
          `</system>`,
        ].join('\n');

        const warningTurn = this.state.history.append('system', warningMsg, {
          type: TurnType.ERROR,
          trigger_llm: false,
        });

        this._emit('turn_end', { role: 'system', turn: warningTurn });
      }

      const validActions = actions.filter((a) => a.type !== 'thinking' && a.type !== 'plan');

      if (validActions.length > 0) {
        this.continuousToolCount++;
        this._dispatchActions(validActions);
      } else {
        this.continuousToolCount = 0;
        this._emit('loop_stop', { reason: 'idle' });
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.log('[Engine] Aborted.');
        this._emit('loop_stop', { reason: 'abort' });
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
      this.isRunning = false;
      this.abortController = null;
      if (this.hasPendingEvents) {
        // 実行中に寄せておいた締切を引き継ぐ（無ければツール結果と同じ待ち）
        const carried = this.debounceDeadline;
        this.debounceDeadline = 0;
        this._schedulePing(carried > 0 ? Math.max(0, carried - Date.now()) : WAKE_DEBOUNCE_MS);
      } else {
        this.debounceDeadline = 0;
      }
    }
  }

  private _dispatchActions(actions: ParsedAction[]): void {
    // 【重要】このメソッドは await されずに呼ばれるため、実際にツールが動き出す頃には
    // _ping() の finally が this.abortController = null を実行済みになっている。
    // そのため this.abortController を後から参照する中断チェックは常に無効(undefined)だった。
    // 呼び出し時点（まだ非null）でシグナルをローカルに捕捉しておく。
    const signal = this.abortController?.signal;

    const context = {
      vfs: this.state.vfs,
      config: this.state.configManager,
      history: this.state.history,
      engine: this,
      ...this.extraContext,
    };

    const combinedResults: ToolExecutionEntry[] = actions.map((action) => {
      const { content, ...safeParams } = action.params || {};
      return {
        actionType: action.type,
        originalIndex: action.originalIndex,
        params: safeParams,
        output: {
          log: `[Pending] Executing ${action.type}...`,
          ui: `⚙️ Executing ${action.type}...`,
          trigger_llm: false,
        },
      };
    });

    const getSortedResults = () => {
      return [...combinedResults].sort((a, b) => (a.originalIndex ?? 0) - (b.originalIndex ?? 0));
    };

    const sharedTurn = this.state.history.append('system', getSortedResults(), {
      type: TurnType.TOOL_EXECUTION,
      trigger_llm: false,
    });

    const sharedTurnId = sharedTurn.id;

    /** 1 つでも 'fast' を名乗った結果があれば、そのターンは速く起こす（名乗りはツール側） */
    const calcTurnWake = (): TurnMeta => {
      const fast = combinedResults.some((r) => r.output.wake === 'fast');
      return fast ? { wake: 'fast' } : {};
    };

    const calcTurnTrigger = () => {
      let willTrigger = false;
      let isHalted = false;
      let hasError = false;

      combinedResults.forEach((r) => {
        if (r.output.trigger_llm !== false) willTrigger = true;
        if (r.output.halt_loop === true) isHalted = true;
        if (r.output.error === true) hasError = true;
      });

      if (hasError) return true;
      return isHalted ? false : willTrigger;
    };

    actions.forEach(async (action, index) => {
      // ツール実行の順序をある程度維持するため、インデックスに応じて開始をわずかに遅らせる (50ms間隔)
      if (index > 0) {
        await new Promise((resolve) => setTimeout(resolve, index * 50));
      }

      // 待機中にループが停止（Abort）された場合は実行をキャンセル。
      // this.abortController は既に null 化されている可能性があるため、
      // 捕捉済みの signal と停止フラグの両方を見る。
      if (signal?.aborted || this.stopRequested) {
        return;
      }

      try {
        // extraContext 経由で shell 等が注入されているため、anyキャストで型検査を通過させる
        const result = await this.registry.execute(action, context as any);

        if (!result) {
          combinedResults[index].output = { log: '', trigger_llm: false };
        } else {
          combinedResults[index].output = result;
        }

        const updatedTurn = this.state.history.update(sharedTurnId, getSortedResults(), {
          trigger_llm: calcTurnTrigger(),
          ...calcTurnWake(),
        });

        if (updatedTurn) {
          this._emit('turn_end', { role: 'system', turn: updatedTurn });
        }
      } catch (err: any) {
        combinedResults[index].output = {
          log: `Error: ${err.message}`,
          error: true,
          trigger_llm: true,
        };

        const updatedTurn = this.state.history.update(sharedTurnId, getSortedResults(), {
          type: TurnType.ERROR,
          trigger_llm: calcTurnTrigger(),
          ...calcTurnWake(),
        });

        if (updatedTurn) {
          this._emit('turn_end', { role: 'system', turn: updatedTurn });
        }

        if (err.code === 'UNKNOWN_TOOL') {
          const isReservedTag = RESERVED_SYSTEM_TAGS.has(err.actionType);
          const warningMsg = (
            isReservedTag
              ? [
                  `<system type="syntax_warning">`,
                  `[LPML Protocol Violation] You generated <${err.actionType}>, which is a tag that only the OS may inject.`,
                  `Forging it does not produce a result: the tag was rejected, and its inner content was kept as plain text (NOT interpreted, NOT executed).`,
                  `NEVER generate this tag yourself. Tool results are delivered to you by the system after <yield />.`,
                  `</system>`,
                ]
              : [
                  `<system type="syntax_warning">`,
                  `[LPML Syntax Violation] You used an undefined or prohibited tag: <${err.actionType}>.`,
                  `ABSOLUTE PROHIBITION: You can only use the tags explicitly defined in your instructions or currently registered dynamic tools.`,
                  `</system>`,
                ]
          ).join('\n');

          const warningTurn = this.state.history.append('system', warningMsg, {
            type: TurnType.ERROR,
            trigger_llm: false,
          });

          this._emit('turn_end', { role: 'system', turn: warningTurn });
        }
      }
    });
  }

  stop(): void {
    // 停止要求を記録する。ストリーミング中以外（デバウンス待機中・ツール実行中）でも
    // 確実に停止させるためのフラグ。
    this.stopRequested = true;

    // デバウンス待機中に押された場合、タイマーが生きていると1.5秒後に生成が始まってしまう
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.debounceDeadline = 0;
    this.hasPendingEvents = false;

    if (this.abortController) {
      // ストリーミング中: abort() 経由で AbortError が発生し、catch側が loop_stop を emit する
      this.abortController.abort();
    } else {
      // abortController が存在しない時間帯（デバウンス待機中／ツール実行中）は
      // 誰も loop_stop を emit しないため、UIが "Processing..." のまま固着する。
      // ここで明示的に emit して確実に解除する。
      this._emit('loop_stop', { reason: 'abort' });
    }
  }
}
