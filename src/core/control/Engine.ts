/**
 * src/core/control/Engine.ts
 * Itera OS v2: Autonomous Execution Loop
 */

import type { HistoryManager, Turn, TurnMeta } from '../state/HistoryManager';
import type { VfsService } from '../vfs/VfsService';
import type { ConfigManager } from '../sys/ConfigManager';
import type { BaseProjector } from '../cognitive/Projector';
import type { BaseLLMAdapter } from '../cognitive/adapters/BaseAdapter';
import type { Translator, ParsedAction } from '../cognitive/Translator';
import type { ToolRegistry } from './ToolRegistry';

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
  private continuousToolCount: number = 0;
  private readonly MAX_CONTINUOUS_TOOLS: number = 50;
  private hasPendingEvents: boolean = false;

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
        }
      }

      // 自分自身の思考更新はトリガー要因にしない
      if (turn.role === 'model') return;

      // どんな履歴の変更であれ、一旦保留イベントとしてスケジュールする
      this.hasPendingEvents = true;
      this._schedulePing();
    }
  }

  private _schedulePing(): void {
    if (this.isRunning) return;

    if (this.debounceTimer) clearTimeout(this.debounceTimer);

    this.debounceTimer = setTimeout(() => {
      this.hasPendingEvents = false;
      this._ping();
    }, 1500);
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

    // 【最強トリガー】 ユーザーの入力があれば問答無用で発火する
    if (recentTurns.some((t) => t.role === 'user')) {
      return true;
    }

    // 【通常トリガー】 ツールの実行結果など、trigger_llm が true のターンが1つでもあれば発火する
    return recentTurns.some((t) => t.meta && t.meta.trigger_llm === true);
  }

  async injectUserTurn(inputContent: any, meta: TurnMeta = {}): Promise<void> {
    const turnMeta: TurnMeta = {
      type: TurnType.USER_INPUT,
      trigger_llm: true,
      ...meta,
    };
    const turn = this.state.history.append('user', inputContent, turnMeta);

    this._emit('turn_end', { role: 'user', turn });
  }

  /**
   * システムからの非同期割り込みイベントを注入する（タイマーやデーモンからの通知など）
   */
  injectSystemEvent(actionType: string, message: string, meta: TurnMeta = {}): void {
    const turnMeta: TurnMeta = {
      type: TurnType.TOOL_EXECUTION,
      trigger_llm: true,
      ...meta,
    };

    const turnContent = [
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

    try {
      if (!this._evaluateWakeUp()) {
        return; // 起床条件を満たさない場合は静かに待機
      }

      if (!this.projector || !this.llm) {
        console.warn('[Engine] Projector or LLM Adapter is not configured yet.');
        return;
      }

      // 暴走チェック
      if (this.MAX_CONTINUOUS_TOOLS > 0 && this.continuousToolCount >= this.MAX_CONTINUOUS_TOOLS) {
        this.state.history.append(
          'system',
          `<event type="system_alert">\nSystem Alert: Max continuous tool executions (${this.MAX_CONTINUOUS_TOOLS}) reached. Auto-trigger paused.\n</event>`,
          {
            type: TurnType.ERROR,
            trigger_llm: false,
          },
        );
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
        this._schedulePing();
      }
    }
  }

  private _dispatchActions(actions: ParsedAction[]): void {
    const context = {
      vfs: this.state.vfs,
      config: this.state.configManager,
      history: this.state.history,
      engine: this,
      ...this.extraContext,
    };

    const combinedResults = actions.map((action) => {
      const { content, ...safeParams } = action.params || {};
      return {
        actionType: action.type,
        originalIndex: action.originalIndex,
        params: safeParams,
        output: {
          log: `[Pending] Executing ${action.type}...`,
          ui: `⚙️ Executing ${action.type}...`,
          trigger_llm: false,
        } as any,
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
        });

        if (updatedTurn) {
          this._emit('turn_end', { role: 'system', turn: updatedTurn });
        }

        if (err.code === 'UNKNOWN_TOOL') {
          const warningMsg = [
            `<system type="syntax_warning">`,
            `[LPML Syntax Violation] You used an undefined or prohibited tag: <${err.actionType}>.`,
            `ABSOLUTE PROHIBITION: You can only use the tags explicitly defined in your instructions or currently registered dynamic tools.`,
            `</system>`,
          ].join('\n');

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
    if (this.abortController) {
      this.abortController.abort();
    }
  }
}
