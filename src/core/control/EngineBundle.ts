/**
 * src/core/control/EngineBundle.ts
 * 束 —— エンジン 1 つと、それが生きるのに要るものを 1 か所で組む（T-0903）。
 *
 * エンジンは複数作れる形をしているが、作る手順（どの道具が見えるか・どの取っ手を道具に渡すか・
 * 何と名乗るか）が組み立てに散っていると、2 つ目を作るときに同じ手順をもう一度書くことになる。
 * この関数が決めるのは:
 *   - 道具の見え方 … システムの道具 → 自分の台帳 → 与えられた組（作る者が渡す。T-0912）
 *   - 道具に渡す取っ手 … fs（役割と個体の印が焼き込まれている）と、会話の口のうち道具に見せる分
 *   - 名乗り … LLM の台帳と道具の記録に出る id、生成に添える会話の id
 *   - 道具の定義を会話に置く … 登録で台帳に「待ち」が出来たら、少し待ってまとめて置く（T-0912 段 3。起こさない）
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
import { TOOL_ANNOUNCE_DELAY_MS } from '../../config/tool_announce';
import { toolsRegisteredEvent } from '../state/conversationEvents';
import { Engine, type StopOptions } from './Engine';
import type { ToolGrant, ToolRegistry, ToolView } from './ToolRegistry';
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
  /** 与えられた組（T-0912）。省けば、見えるのはシステムの道具と自分の台帳だけ（ルートは省く） */
  grant?: ToolGrant;
  /** VFS の取っ手。このエンジンの役割と個体の印が焼き込まれている */
  fs: VfsHandle;
  conversation: BundleConversation;
  /** いま選んでいるモデルの文脈の上限（無ければ null） */
  contextLimit: () => Promise<number | null>;
  /** 起床の方針とデバウンス。省けば配布物の定数（試験だけが差し替える） */
  wakePolicy?: WakePolicy;
  wakeDebounceMs?: number;
  /** 登録された道具の定義を会話に置くまでの待ち。省けば配布物の定数（試験だけが差し替える） */
  toolAnnounceDelayMs?: number;
}

/** 状態の材料（MetaOS.chat.status・/status が同じ形に整える） */
export interface EngineStatusInput {
  engine: { running: boolean; busy: boolean; outstandingTools: number; scheduled: boolean };
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
  stop(options?: StopOptions): void;
  /** 止めて、止まりきってから会話を空にする。起こさない（申し送りは次に起きたときに読まれる） */
  reset(options?: { summary?: string; restoreTools?: boolean }): Promise<unknown>;
  statusInput(): Promise<EngineStatusInput>;
  on(event: EngineBundleEvent, callback: (data?: any) => void): void;
  /** 畳む。エンジンを止めて台帳を捨てる。以後、置く口は断る */
  dispose(): void;
}

export function createEngineBundle(spec: EngineBundleSpec): EngineBundle {
  const { id, role, history, conversation } = spec;
  const afterReset = ROLE_PARTS[role].afterReset;

  // 見えるのは システムの道具 → 自分の台帳 → 与えられた組（同名なら先のものが動く）。
  // ルートの台帳を並べる継承は無い（T-0912）: サブに見えるルートの道具は、作る者が与えたものだけ
  const tools = spec.registry.viewFor(id, spec.grant);

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
  /** 会話に system のターンを置いて知らせる（外から置く口と、道具の定義の知らせが通る） */
  const place = (content: TurnContent, meta: TurnMeta): Turn => {
    const turn = history.append('system', content, meta);
    emit('turn_placed', { turn });
    return turn;
  };

  // 道具の定義を会話に置く（T-0912 段 3）。登録で台帳に待ちが出来たら、少し待って（1 つのプロセスが続けて登録する分をまとめる。
  // 締切は先着で、あとの登録では延びない）、待ちを引いて 1 つのターンに置く。同じ定義の登録し直しは待ちにならないので、何も置かない
  const announceDelay = spec.toolAnnounceDelayMs ?? TOOL_ANNOUNCE_DELAY_MS;
  let announceTimer: ReturnType<typeof setTimeout> | null = null;
  tools.onDefinitionsPending(() => {
    if (disposed || announceTimer !== null) return;
    announceTimer = setTimeout(() => {
      announceTimer = null;
      if (disposed) return;
      const event = toolsRegisteredEvent(tools.takePendingDefinitions());
      if (event) place(event.content, event.meta);
    }, announceDelay);
  });
  // 会話が空になった・入れ替わったら、渡した定義はもう会話に無いので、控えを捨てる（見るのは履歴の出来事で、文ではない）。
  // 積み直すなら、会話の口がこのあと全部引く（restoreDefinitions）ので、控えは入り直す
  const stopWatchingHistory = history.on('change', (change) => {
    if (change.type === 'clear' || change.type === 'load') tools.forgetGivenDefinitions();
  });

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
      const turn = place(content, meta);
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

    stop(options) {
      engine.stop(options);
    },

    async reset(options = {}) {
      assertAlive();
      // LLM が応答できない状態（文脈の溢れ）でも効くように、busy は見ない。走っている束は見捨てる。
      // 生成の回の中なら、止まりきる（model のターンの更新と loop_stop(abort)）のを待ってから空にする。
      // 待たないと、止めた回の書き込みが新しい会話に落ちる（T-0918）
      engine.stop({ quiet: true });
      await engine.settled();
      assertAlive();
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
      if (announceTimer !== null) clearTimeout(announceTimer);
      announceTimer = null;
      stopWatchingHistory();
      engine.dispose();
      tools.dispose();
      own.turn_placed.length = 0;
      own.wake_requested.length = 0;
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
