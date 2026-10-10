/**
 * src/shell/commands/CommandDispatcher.ts
 * チャット欄のコマンド（T-0634）— 判定は 1 か所（`tryDispatch`）。呼ぶのは `EventOrchestrator._handleChatSend` の先頭だけ。
 *
 * 組み込みの実体は MetaOS.chat と同じホストの関数（Engine / SessionManager / ProcessManager / ConfigManager）。
 * 設定は ConfigManager が持つホストの状態として扱う（どのファイルに在るかはコマンドは知らない。T-0636）。
 * 結果は `<event type="command">` の system ターンとして履歴に置く（LLM は起こさない。次に起きたときに読む）。
 * ゲストにコマンド文字列を解釈する口は出さない（ゲストは MetaOS.chat を直接呼ぶ）。
 */

import type { Turn, TurnContent, TurnMeta } from '../../core/state/HistoryManager';
import {
  buildChatStatus,
  buildResetPlan,
  formatChatStatus,
  readLatestContextUsage,
  STATUS_LABELS_EN,
  type StatusLabels,
  type UsageLogReader,
} from '../../api/chatApi';
import {
  COMMAND_TEXTS_EN,
  commandEventText,
  helpText,
  parseCommandLine,
  type CommandSpec,
  type CommandTexts,
  type ParsedCommand,
} from './commandLine';

export interface CommandResult {
  ok: boolean;
  text: string;
}

export interface Command extends CommandSpec {
  run(cmd: ParsedCommand): Promise<CommandResult>;
}

export interface CommandDeps {
  engine: {
    stop(): void;
    status(): { running: boolean; busy: boolean; outstandingTools: number };
  };
  history: {
    get(): Turn[];
    append(role: 'system', content: TurnContent, meta: TurnMeta): Turn;
  };
  sessionManager: {
    clearSession(opts: { summary?: string; triggerLlm?: boolean; restoreTools?: boolean }): Promise<unknown>;
    currentSession(): Promise<{ id: string; title: string; createdAt: number }>;
  };
  processManager: { list(): Array<{ pid: string; path: string; type: string; state: string }> };
  /** 設定（層の合成・書き先・読み直しは ConfigManager の責任） */
  config: {
    get(category: 'llm'): { model?: string } | undefined;
    update(category: 'llm', updates: { model: string }): Promise<void>;
  };
  vfs: UsageLogReader;
  /** パス（関連付けのアプリ）または `metaos://…` を開く */
  open(target: string): void;
  /** 結果のターンを画面に出す */
  show(turn: Turn): void;
  now?: () => number;
  /** 画面に出る文言（既定は英語） */
  texts?: CommandTexts;
  statusLabels?: StatusLabels;
}

export class CommandDispatcher {
  private readonly commands = new Map<string, Command>();
  private readonly deps: CommandDeps;

  constructor(deps: CommandDeps) {
    this.deps = deps;
    for (const c of this._builtins()) this.register(c);
  }

  /** 組み込みと同じ名前は登録できない（後勝ちにしない） */
  register(cmd: Command): void {
    const name = cmd.name.toLowerCase();
    if (this.commands.has(name)) throw new Error(`Command already registered: /${name}`);
    this.commands.set(name, { ...cmd, name });
  }

  has(name: string): boolean {
    return this.commands.has(name.toLowerCase());
  }

  specs(): CommandSpec[] {
    return [...this.commands.values()].map(({ name, usage, summary }) => ({ name, usage, summary }));
  }

  /**
   * コマンドなら実行して true、通常の発言なら false（呼び手が LLM へ渡す）。
   * `//` で始まる文は `text` を 1 文字落とした形に書き換えて false を返す。
   */
  async tryDispatch(text: string): Promise<{ handled: true } | { handled: false; text: string }> {
    const parsed = parseCommandLine(text, (n) => this.commands.has(n));
    if (parsed.kind === 'text') return { handled: false, text: parsed.text };
    const line = text.trim();
    let result: CommandResult;
    try {
      result = await this.commands.get(parsed.name)!.run(parsed);
    } catch (e: any) {
      result = { ok: false, text: e?.message || String(e) };
    }
    // 結果を履歴に置く。/reset は会話が空になったあとに置くと新しい会話の先頭に残るので、記録しない（summary が担う）
    if (!(parsed.name === 'reset' && result.ok)) {
      const turn = this.deps.history.append('system', commandEventText(line, result), {
        type: 'event_log',
        eventType: 'command',
        trigger_llm: false,
      });
      this.deps.show(turn);
    }
    return { handled: true };
  }

  private _builtins(): Command[] {
    const d = this.deps;
    const now = () => (d.now ? d.now() : Date.now());
    const T = d.texts || COMMAND_TEXTS_EN;
    const L = d.statusLabels || STATUS_LABELS_EN;
    return [
      {
        name: 'help',
        usage: '/help [name]',
        summary: T.summary.help,
        run: async (c) => ({ ok: true, text: helpText(this.specs(), c.args[0], T) }),
      },
      {
        name: 'status',
        usage: '/status',
        summary: T.summary.status,
        run: async () => {
          let session: { id: string; title: string; createdAt: number } | null = null;
          try {
            session = await d.sessionManager.currentSession();
          } catch {
            session = null;
          }
          const s = buildChatStatus({
            engine: d.engine.status(),
            turns: d.history.get(),
            session,
            context: await readLatestContextUsage(d.vfs, now()),
          });
          return { ok: true, text: formatChatStatus(s, now(), L) };
        },
      },
      {
        name: 'stop',
        usage: '/stop',
        summary: T.summary.stop,
        run: async () => {
          d.engine.stop();
          return { ok: true, text: T.stopped };
        },
      },
      {
        name: 'reset',
        usage: '/reset [note]',
        summary: T.summary.reset,
        run: async (c) => {
          const plan = buildResetPlan({ summary: c.rest }, 'user command');
          // 起こさない（chat:reset と同じ。次の発言で AI が起きて申し送りを読む）
          d.engine.stop();
          await d.sessionManager.clearSession({
            summary: plan.summary,
            triggerLlm: false,
            restoreTools: plan.restoreTools,
          });
          return { ok: true, text: T.sessionReset };
        },
      },
      {
        name: 'ps',
        usage: '/ps',
        summary: T.summary.ps,
        run: async () => {
          const rows = d.processManager.list();
          if (rows.length === 0) return { ok: true, text: T.noProcesses };
          const w = Math.max(...rows.map((r) => r.pid.length));
          return {
            ok: true,
            text: rows
              .map((r) => `${r.pid.padEnd(w)}  ${r.type.padEnd(6)}  ${r.state.padEnd(10)}  ${r.path}`)
              .join('\n'),
          };
        },
      },
      {
        name: 'open',
        usage: '/open <path | metaos://…>',
        summary: T.summary.open,
        run: async (c) => {
          if (!c.rest) return { ok: false, text: T.openUsage };
          d.open(c.rest);
          return { ok: true, text: T.opening.replace('{target}', c.rest) };
        },
      },
      {
        name: 'model',
        usage: '/model [provider/model]',
        summary: T.summary.model,
        // 検証はしない（一覧に無い名前も置ける。動かなければ置き直す。山内さん 2026-10-10）。
        // 反映は CognitiveManager が ConfigManager の更新を購読して行う（T-0313）ので、ここでは置くだけ
        run: async (c) => {
          const current = (d.config.get('llm') || {}).model || '';
          const shown = current || T.modelUnset;
          if (c.args.length === 0) return { ok: true, text: T.modelCurrent.replace('{model}', shown) };
          if (c.args.length > 1) return { ok: false, text: T.modelUsage };
          const next = c.args[0];
          if (next === current) return { ok: true, text: T.modelCurrent.replace('{model}', shown) };
          await d.config.update('llm', { model: next });
          return { ok: true, text: T.modelChanged.replace('{from}', shown).replace('{to}', next) };
        },
      },
    ];
  }
}
