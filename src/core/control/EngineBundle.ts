/**
 * src/core/control/EngineBundle.ts
 * 束 —— エンジン 1 つと、それが生きるのに要るものを 1 か所で組む（T-0903）。
 *
 * エンジンは複数作れる形をしているが、作る手順（どの道具が見えるか・どの取っ手を道具に渡すか・
 * 何と名乗るか）が組み立てに散っていると、2 つ目を作るときに同じ手順をもう一度書くことになる。
 * この関数が決めるのは:
 *   - 道具の見え方 … システムの道具 → 自分の台帳 →（ルートでなければ）ルートの台帳
 *   - 道具に渡す取っ手 … fs（役割と個体の印が焼き込まれている）と、会話の口のうち道具に見せる分
 *   - 名乗り … LLM の台帳と道具の記録に出る id、生成に添える会話の id
 * プロンプトと上流（engine.projector・engine.llm）は、設定を知る側（CognitiveManager）が差す。
 * 画面とプロセス（extraContext.shell）はエンジンのものではないので、組み立てが後から差す。
 *
 * 束の口は、外からこのエンジンに働きかけるときの入口:
 *   post … 会話にターンを置く（外から置く口はこれ 1 つ）。起こすかは meta.trigger_llm === true
 *   wake / stop / reset / statusInput
 *   on   … エンジンの 4 つの知らせ ＋ turn_placed・wake_requested
 * 束は画面を知らない。描く側が on で聞く。
 */

import type { HistoryManager, Turn, TurnContent, TurnMeta } from '../state/HistoryManager';
import type { VfsService } from '../vfs/VfsService';
import type { VfsHandle } from '../vfs/VfsHandle';
import type { EngineConfigReader } from '../sys/engineConfig';
import type { Translator } from '../cognitive/Translator';
import type { WakePolicy } from '../../config/wake_policy';
import { ROLE_PARTS, type PromptRole } from '../../config/system_prompts';
import { Engine, ROOT_ENGINE_ID } from './Engine';
import type { ToolRegistry, ToolView } from './ToolRegistry';
import type { ToolConversation } from './ToolContext';

/** 会話の名前（状態として外へ出す分） */
export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: number;
}

/**
 * 束が握る、このエンジンの会話の口。道具に見せるのは ToolConversation の分だけ。
 * リセットのあとの 1 行（afterReset）は会話のものではなく役割のものなので、束が足す
 */
export interface BundleConversation extends Omit<ToolConversation, 'afterReset'> {
  /** いまの会話。無ければ null */
  current(): Promise<ConversationSummary | null>;
  /** いまの会話の id（同期。生成の台帳の行に添える）。無ければ null */
  currentId(): string | null;
}

export interface EngineBundleSpec {
  /** エンジンの id。振るのはホスト（ルートは ROOT_ENGINE_ID） */
  id: string;
  /** 役割: OS のチャットのエンジン（root）か、アプリが作ったエンジン（sub）か。プロンプトの役割ごとの部分と同じ語 */
  role: PromptRole;
  /** このエンジンの会話 */
  history: HistoryManager;
  vfs: VfsService;
  /** このエンジンが読む設定。ルートは OS の設定そのもの、ほかは上書きを重ねたもの（engineConfig.ts） */
  configManager: EngineConfigReader;
  translator: Translator;
  /** 道具の台帳（全エンジンで 1 つ）。このエンジンの口は束が作る */
  registry: ToolRegistry;
  /** VFS の取っ手。このエンジンの役割と個体の印が焼き込まれている */
  fs: VfsHandle;
  conversation: BundleConversation;
  /** いま選んでいるモデルの文脈の上限（無ければ null） */
  contextLimit: () => Promise<number | null>;
  /** 起床の方針とデバウンス。省けば配布物の定数（試験だけが差し替える） */
  wakePolicy?: WakePolicy;
  wakeDebounceMs?: number;
}

/** 状態の材料（MetaOS.chat.status・/status が同じ形に整える） */
export interface EngineStatusInput {
  engine: { running: boolean; busy: boolean; outstandingTools: number };
  turns: Turn[];
  session: ConversationSummary | null;
  contextLimit: number | null;
}

/**
 * 束の知らせ。
 *   turn_start / stream_chunk / turn_end / loop_stop … エンジンのもの（中身はそのまま）
 *   turn_placed    … 外から system のターンを置いた（`{ turn }`）。発言（user）はエンジンが置くので turn_end で届く
 *   wake_requested … 外から「起こす」と決めた（post の trigger_llm・wake）。起きるかどうかはエンジンが履歴で決める
 * turn_placed を turn_end に相乗りさせない —— 画面は turn_end で印（Thinking／Processing）を判定している。
 */
export type EngineBundleEvent =
  'turn_start' | 'stream_chunk' | 'turn_end' | 'loop_stop' | 'turn_placed' | 'wake_requested';

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface EngineBundle {
  readonly id: string;
  readonly role: PromptRole;
  /** リセットのあと、この役割のエンジンがすること（外からリセットする口が、申し送りの頭に置く 1 行） */
  readonly afterReset: string;
  readonly engine: Engine;
  readonly history: HistoryManager;
  /** このエンジンに見える道具（ゲストの道具の登録もここへ） */
  readonly tools: ToolView;
  /**
   * 会話にターンを置く。起こすのは meta.trigger_llm === true のときだけ（省けば置くだけ）。
   *   user   … エンジンが置く（停止要求を解く）
   *   system … 置いて turn_placed を知らせる。起こすなら停止要求を解いて評価を頼む
   */
  post(role: 'user' | 'system', content: TurnContent, meta?: TurnMeta): Promise<Turn>;
  /** 評価を頼む。未読が無ければ idle で終わる（空の応答は作らない） */
  wake(): void;
  stop(): void;
  /** 止めてから会話を空にする。起こさない（申し送りは次に起きたときに読まれる） */
  reset(options?: { summary?: string; restoreTools?: boolean }): Promise<unknown>;
  statusInput(): Promise<EngineStatusInput>;
  on(event: EngineBundleEvent, callback: (data?: any) => void): void;
  /** 畳む。エンジンを止めて台帳を捨てる。以後、置く口は断る */
  dispose(): void;
}

export function createEngineBundle(spec: EngineBundleSpec): EngineBundle {
  const { id, role, history, conversation } = spec;
  const afterReset = ROLE_PARTS[role].afterReset;

  // ルートでないエンジンには、自分の台帳の後ろにルートの台帳が見える（同名なら自分のものが動く）
  const tools = spec.registry.viewFor(id, id === ROOT_ENGINE_ID ? [] : [ROOT_ENGINE_ID]);

  const engine = new Engine(
    { history, vfs: spec.vfs, configManager: spec.configManager },
    null,
    null,
    spec.translator,
    tools,
    {
      fs: spec.fs,
      // 道具に見せるのは、空にする・添付を置く の 2 つと、リセットのあとの 1 行だけ
      conversation: {
        afterReset,
        reset: (options) => conversation.reset(options),
        putAttachment: (name, blob) => conversation.putAttachment(name, blob),
      },
    },
    spec.wakePolicy,
    spec.wakeDebounceMs,
    id,
  );
  engine.sessionTag = () => conversation.currentId();

  const own: Record<'turn_placed' | 'wake_requested', Array<(data?: any) => void>> = {
    turn_placed: [],
    wake_requested: [],
  };
  const emit = (event: 'turn_placed' | 'wake_requested', data?: any) => own[event].forEach((cb) => cb(data));
  let disposed = false;
  const assertAlive = () => {
    if (disposed) throw new Error(`Engine "${id}" has been disposed.`);
  };

  return {
    id,
    role,
    afterReset,
    engine,
    history,
    tools,

    async post(role, content, meta = {}) {
      assertAlive();
      const wake = meta.trigger_llm === true;
      if (role === 'user') {
        // 発言はエンジンが置く。画面には、その turn_end(user) で載る
        const turn = await engine.injectUserTurn(content, { ...meta, trigger_llm: wake });
        if (wake) emit('wake_requested');
        return turn;
      }
      const turn = history.append('system', content, meta);
      emit('turn_placed', { turn });
      if (wake) {
        // 積んだだけでは、停止のあと予約が捨てられる（stopRequested）。起こす契約なので、停止要求を解いて評価を頼む（T-0638）
        engine.requestEvaluation();
        emit('wake_requested');
      }
      return turn;
    },

    wake() {
      if (disposed) return;
      engine.requestEvaluation();
      emit('wake_requested');
    },

    stop() {
      engine.stop();
    },

    async reset(options = {}) {
      assertAlive();
      // LLM が応答できない状態（文脈の溢れ）でも効くように、busy は見ない。走っている束は見捨てる
      engine.stop();
      return conversation.reset({ summary: options.summary, triggerLlm: false, restoreTools: options.restoreTools });
    },

    async statusInput() {
      let session: ConversationSummary | null = null;
      try {
        const current = await conversation.current();
        session = current ? { id: current.id, title: current.title, createdAt: current.createdAt } : null;
      } catch {
        session = null;
      }
      return {
        engine: engine.status(),
        turns: history.get(),
        session,
        contextLimit: await spec.contextLimit(),
      };
    },

    on(event, callback) {
      if (event === 'turn_placed' || event === 'wake_requested') own[event].push(callback);
      else engine.on(event, callback);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      engine.dispose();
      tools.dispose();
      own.turn_placed.length = 0;
      own.wake_requested.length = 0;
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
