/**
 * src/core/control/ToolRegistry.ts
 * Itera OS v2: Tool and ToolSet Registry
 */

import type { AppRegistry } from '../sys/AppRegistry';
import type { GuestToolInvoker } from './GuestToolInvoker';
import type { ToolExecutionRecorder } from './ToolExecutionRecorder';
import { normalizeDynamicToolResult } from './ToolResultNormalizer';
import type { ToolParams, ToolResult } from '../types/tools';
import type { ToolContext } from './ToolContext';
import { RESERVED_SYSTEM_TAGS } from '../cognitive/Translator';
import { asToolFailure, isToolError } from './ToolError';

export interface ToolDef {
  name: string;
  description: string;
  definition?: string;
  impl?: (params: ToolParams, context: ToolContext) => Promise<ToolResult | null>;
}

export interface ToolSet {
  id: string; // "system:fs", "app_tasks" など
  kind: 'system' | 'dynamic';
  name: string; // "System: File Operations", "App: Tasks" など
  description?: string;
  tools: Map<string, ToolDef>;
}

export interface DynamicToolDefinition {
  description?: string;
  definition?: string;
}

/**
 * 登録されていないタグを呼んだときの結果（T-0593）。
 *
 * 以前は UnknownToolError を投げ、Engine の catch が別に syntax_warning のターンを積んでいた。
 * いまは他の失敗（ツールが例外を出した）と同じく、失敗した 1 本の結果として返す。
 * 違いは文面だけ: OS しか出さないタグ（<tool_output> など）なら「システム専用のタグで、書いても機能しない」と伝える。
 * 文言は英語（LLM に読ませる文。itera2 系とミャク楽で共通）。
 */
export function unknownToolResult(actionType: string): ToolResult {
  if (RESERVED_SYSTEM_TAGS.has(actionType)) {
    return {
      log: [
        `[LPML Protocol Violation] <${actionType}> is a system-only tag that only the OS may inject.`,
        `It has no effect when you write it: the tag was rejected, and its inner content was kept as plain text (NOT interpreted, NOT executed).`,
        `NEVER generate this tag yourself.`,
      ].join('\n'),
      ui: `❌ Error: <${actionType}> is reserved for the OS`,
      error: true,
    };
  }
  return {
    log: [
      `[LPML Syntax Violation] Unknown Tool: <${actionType}> is not registered or not available.`,
      `You can only use the tags explicitly defined in your instructions or currently registered dynamic tools.`,
    ].join('\n'),
    ui: `❌ Error: Unknown tool <${actionType}>`,
    error: true,
  };
}

/**
 * 閉じていない要素を呼んだときの結果（T-0878）。
 *
 * LPML で効力を持つのは閉じた要素だけ（`<x />` か、`<x>` と自分の `</x>`）。閉じていない要素は実行しない ——
 * 出力が途中で切れた、閉じタグを書き忘れた、のどちらでも、書き手の意図した中身かどうかが分からないため。
 * 未登録のタグと同じく、失敗した 1 本の結果として返す（モデルは次のターンで、どのタグが実行されなかったかを読める）。
 * 文言は英語（LLM に読ませる文。itera2 系とミャク楽で共通）。
 */
export function unclosedTagResult(actionType: string): ToolResult {
  return {
    log: [
      `[LPML Syntax] <${actionType}> was not closed, so it was not executed.`,
      `A tag takes effect only when it is closed: with \`</${actionType}>\`, or written as \`<${actionType} ... />\` when it has no content. What followed the opening tag was read as its content, so no tag in there was executed either.`,
      `Nothing else is affected. If you still need it, write the tag again and close it (if your output was cut off, in smaller parts).`,
    ].join('\n'),
    ui: `❌ Error: <${actionType}> was not closed`,
    error: true,
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) return String((err as { message: unknown }).message);
  return String(err);
}

/** 実行する 1 本（パーサーが切り出したもの） */
export interface ToolAction {
  type: string;
  params: ToolParams;
  closed?: boolean;
}

/** 道具の組の要約（一覧の 1 件） */
export interface ToolSetSummary {
  id: string;
  kind: 'system' | 'dynamic';
  name: string;
  description?: string;
  tools: Array<{ name: string; description: string; hasDefinition: boolean }>;
}

/** 1 つの道具の在り処と定義 */
export interface ToolDefinitionInfo {
  setId: string;
  setName: string;
  kind: 'system' | 'dynamic';
  definition: string | null;
}

/**
 * エンジンから見える道具（T-0903）。
 *
 * 道具は 2 種類ある。システムの道具は 1 組を全エンジンが共有する。動的な道具（アプリ・デーモンが登録したもの）は、
 * 登録したプロセスが仕えるエンジンの台帳に入る。エンジンに見えるのは「システムの道具 → 自分の台帳 → 口を作るときに並べた
 * ほかの台帳」の順で、同じ名前が複数あれば最初に当たったものが動く。どの台帳を並べるかは口を作る側が決める
 * （束を作る関数は、ルートでないエンジンにルートの台帳を並べる —— ルートに仕えるデーモンの道具は、どのエンジンからも使える）。
 *
 * どの台帳か（エンジンの id）はこの口に焼き込んである。使う側（エンジン・会話の積み直し・ゲストの登録の口）は id を書かない。
 */
export interface ToolView {
  readonly engineId: string;
  /** 見えている道具の名前（パーサーの保護の対象） */
  getRegisteredToolNames(): string[];
  /** 名前で探して実行する。記録（tool_events）には、このエンジンの id が付く */
  execute(action: ToolAction, context: ToolContext): Promise<ToolResult | null>;
  /** 一覧（既定は動的な道具だけ） */
  listToolSets(includeSystem?: boolean): ToolSetSummary[];
  /** 1 つの道具の定義。見えていなければ null */
  getToolDefinition(toolName: string): ToolDefinitionInfo | null;
  /** 見えている動的な道具の定義を、組ごとの <toolset> にして返す（会話を空にしたあとの積み直し） */
  getActiveDynamicToolDefinitions(): string[];
  /** このエンジンの台帳に登録する（sourcePid は登録したプロセス） */
  registerDynamicTool(toolName: string, sourcePid: string, payload: DynamicToolDefinition): void;
  unregisterDynamicTool(toolName: string, sourcePid: string): void;
  /** このエンジンの台帳を捨てる（エンジンを畳むとき） */
  dispose(): void;
}

export class ToolRegistry {
  /** システムの道具の組（全エンジンで共有。作った順） */
  private systemSets: Map<string, ToolSet> = new Map();
  /** 動的な道具の台帳: エンジンの id → そのエンジンに仕えるプロセスの組（組の id は pid。作った順） */
  private ledgers: Map<string, Map<string, ToolSet>> = new Map();
  private appRegistry: AppRegistry | null = null;
  private guestToolInvoker: GuestToolInvoker | null = null;
  private executionRecorder: ToolExecutionRecorder | null = null;

  constructor(appRegistry?: AppRegistry, executionRecorder?: ToolExecutionRecorder) {
    if (appRegistry) {
      this.appRegistry = appRegistry;
    }
    if (executionRecorder) {
      this.executionRecorder = executionRecorder;
    }
  }

  setGuestToolInvoker(invoker: GuestToolInvoker): void {
    this.guestToolInvoker = invoker;
  }

  /**
   * あるエンジンから見える道具の口を作る。口は台帳を写さない（呼ぶたびに引く）ので、あとからの登録・解除もそのまま見える。
   * `inherits` は、自分の台帳の後ろに見せるほかのエンジンの台帳（この順）。登録・解除は自分の台帳だけに効く。
   */
  viewFor(engineId: string, inherits: readonly string[] = []): ToolView {
    const visible = () => this._visibleSets(engineId, inherits);
    return {
      engineId,
      getRegisteredToolNames: () => this._names(visible()),
      execute: (action, context) => this._execute(engineId, visible(), action, context),
      listToolSets: (includeSystem = false) => this._listToolSets(visible(), includeSystem),
      getToolDefinition: (toolName) => this._getToolDefinition(visible(), toolName),
      getActiveDynamicToolDefinitions: () => this._activeDynamicToolDefinitions(visible()),
      registerDynamicTool: (toolName, sourcePid, payload) =>
        this._registerDynamicTool(engineId, toolName, sourcePid, payload),
      unregisterDynamicTool: (toolName, sourcePid) => this._unregisterDynamicTool(engineId, toolName, sourcePid),
      dispose: () => {
        this.ledgers.delete(engineId);
      },
    };
  }

  /** あるエンジンに見える組: システムの道具 → 自分の台帳 → 並べたほかの台帳（探す順でもある） */
  private _visibleSets(engineId: string, inherits: readonly string[]): ToolSet[] {
    const sets = [...this.systemSets.values()];
    for (const id of [engineId, ...inherits.filter((other) => other !== engineId)]) {
      const ledger = this.ledgers.get(id);
      if (ledger) sets.push(...ledger.values());
    }
    return sets;
  }

  // ==========================================
  // System Tools Management
  // ==========================================

  /**
   * システムツールセット（カテゴリ）を作成または取得する
   */
  private _getOrCreateSystemToolSet(setId: string, setName: string, description?: string): ToolSet {
    if (!this.systemSets.has(setId)) {
      this.systemSets.set(setId, {
        id: setId,
        kind: 'system',
        name: setName,
        description,
        tools: new Map(),
      });
    }
    return this.systemSets.get(setId)!;
  }

  /**
   * システムツール（固定）を特定のカテゴリに登録する。実体は全エンジンで 1 組（エンジンごとに違うのは、渡される文脈だけ）
   */
  registerSystemTool(setId: string, setName: string, toolDef: ToolDef): void {
    const toolSet = this._getOrCreateSystemToolSet(setId, setName);
    toolSet.tools.set(toolDef.name, toolDef);
  }

  // ==========================================
  // Dynamic (Guest) Tools Management
  // ==========================================

  /**
   * ゲストアプリからの動的ツールを、エンジンの台帳に登録する
   * sourcePidからよしなにアプリ情報を解決し、Toolsetに自動分類する
   */
  private _registerDynamicTool(
    engineId: string,
    toolName: string,
    sourcePid: string,
    payload: DynamicToolDefinition,
  ): void {
    let ledger = this.ledgers.get(engineId);
    if (!ledger) {
      ledger = new Map();
      this.ledgers.set(engineId, ledger);
    }
    const setId = sourcePid;
    let toolSet = ledger.get(setId);

    // 新規プロセスからの登録ならToolsetを作成
    if (!toolSet) {
      let setName = `Process: ${sourcePid}`;
      let description = `Dynamic tools exposed by ${sourcePid}`;

      // AppRegistryが繋がっていれば、PIDからベースパスを推測してリッチな名前にする
      if (this.appRegistry) {
        // 例: "app_apps_tasks_html" -> "apps/tasks.html" のような推測は難しいため、
        // 登録されている全アプリのパスまたはIDと部分一致するか簡易チェックする
        const appInfo = this.appRegistry
          .getAllApps()
          .find(
            (a) =>
              sourcePid.includes(a.id) || sourcePid.includes(a.path.split(/[?#]/)[0].replace(/[^a-zA-Z0-9_-]/g, '_')),
          );
        if (appInfo) {
          setName = `App: ${appInfo.name} (${appInfo.icon})`;
          if (appInfo.description) description = appInfo.description;
        }
      }

      toolSet = { id: setId, kind: 'dynamic', name: setName, description, tools: new Map() };
      ledger.set(setId, toolSet);
    }

    toolSet.tools.set(toolName, {
      name: toolName,
      description: payload.description || '',
      definition: payload.definition,
    });

    console.log(`[ToolRegistry] Registered dynamic tool: <${toolName}> into ToolSet: [${toolSet.name}]`);
  }

  /**
   * 動的ツールを明示的に解除する
   */
  private _unregisterDynamicTool(engineId: string, toolName: string, sourcePid: string): void {
    const ledger = this.ledgers.get(engineId);
    const toolSet = ledger?.get(sourcePid);
    if (ledger && toolSet && toolSet.tools.has(toolName)) {
      toolSet.tools.delete(toolName);
      console.log(`[ToolRegistry] Unregistered dynamic tool: <${toolName}> from PID: ${sourcePid}`);

      // グループが空になったらToolsetごと消す
      if (toolSet.tools.size === 0) {
        ledger.delete(sourcePid);
      }
    }
  }

  /**
   * 特定のPIDに紐づくすべての動的ツールを一括で削除する（プロセスキル時のクリーンアップ用）。
   * pid は OS 全体で 1 つなので、どのエンジンの台帳に在っても消す
   */
  removeToolsByPid(pid: string): void {
    for (const ledger of this.ledgers.values()) {
      const toolSet = ledger.get(pid);
      if (!toolSet) continue;
      const count = toolSet.tools.size;
      ledger.delete(pid);
      if (count > 0) {
        console.log(`[ToolRegistry] Removed ToolSet [${toolSet.name}] (${count} tools) due to process termination.`);
      }
    }
  }

  // ==========================================
  // Query & Execution
  // ==========================================

  /**
   * 見えているすべての動的ツールを <toolset> タグでグループ化して出力する
   * セッションリセット時やシステムプロンプトの注入用
   */
  private _activeDynamicToolDefinitions(visible: ToolSet[]): string[] {
    const output: string[] = [];

    for (const toolSet of visible) {
      if (toolSet.kind === 'system') continue;
      if (toolSet.tools.size === 0) continue;

      let block = `<toolset name="${toolSet.name}" pid="${toolSet.id}"${toolSet.description ? ` description="${toolSet.description}"` : ''}>\n`;
      for (const tool of toolSet.tools.values()) {
        if (tool.definition) {
          // インデントをつけて整形
          block +=
            tool.definition
              .split('\n')
              .map((line) => `  ${line}`)
              .join('\n') + '\n';
        }
      }
      block += `</toolset>`;
      output.push(block);
    }

    return output;
  }

  /**
   * 道具の一覧（AI が自分で取りに来るための要約）。
   * 履歴が消えた・圧縮で定義の本文が落ちた・走っている間に定義が変わった、の 3 つの場面で
   * <tool_catalog action="list" /> から呼ばれる（T-0246）。既定では動的（アプリ・デーモン）だけ。
   */
  private _listToolSets(visible: ToolSet[], includeSystem: boolean): ToolSetSummary[] {
    const out: ToolSetSummary[] = [];
    for (const toolSet of visible) {
      if (toolSet.kind === 'system' && !includeSystem) continue;
      if (toolSet.tools.size === 0) continue;
      out.push({
        id: toolSet.id,
        kind: toolSet.kind,
        name: toolSet.name,
        description: toolSet.description,
        tools: Array.from(toolSet.tools.values()).map((t) => ({
          name: t.name,
          description: t.description || '',
          hasDefinition: !!t.definition,
        })),
      });
    }
    return out;
  }

  /**
   * 1 つの道具の定義（LPML の <define_tag>）を返す。無ければ null。
   * システムツールはシステムプロンプトに定義があり、ここには持っていない（definition が空）。
   */
  private _getToolDefinition(visible: ToolSet[], toolName: string): ToolDefinitionInfo | null {
    for (const toolSet of visible) {
      const t = toolSet.tools.get(toolName);
      if (t) return { setId: toolSet.id, setName: toolSet.name, kind: toolSet.kind, definition: t.definition || null };
    }
    return null;
  }

  /**
   * 見えているすべてのツール名（タグ名）の配列を取得する（Parserの保護対象指定用）
   */
  private _names(visible: ToolSet[]): string[] {
    const names: string[] = [];
    for (const toolSet of visible) {
      for (const name of toolSet.tools.keys()) {
        names.push(name);
      }
    }
    return names;
  }

  /**
   * アクションを検索して実行する
   */
  private async _execute(
    engineId: string,
    visible: ToolSet[],
    action: ToolAction,
    context: ToolContext,
  ): Promise<ToolResult | null> {
    const startedAt = Date.now();

    // 0. 閉じていない要素は実行しない（T-0878）。登録の有無より先に見る ——
    //    書き終えられていない要素は、どの道具としても扱えない。
    //    `closed` を持たない呼び出し（パーサーを通らないもの）は、閉じているものとして扱う
    if (action.closed === false) {
      const result = unclosedTagResult(action.type);
      this._recordExecution(engineId, action, null, startedAt, result);
      return result;
    }

    // 1. 見えているToolsetから対象のツールを検索する（最初に当たったもの）
    let foundTool: ToolDef | null = null;
    let foundSet: ToolSet | null = null;

    for (const toolSet of visible) {
      if (toolSet.tools.has(action.type)) {
        foundTool = toolSet.tools.get(action.type)!;
        foundSet = toolSet;
        break;
      }
    }

    // 失敗は投げずに結果として返す（下の 2 経路と同じ）。投げると Engine の catch に入り、
    // 想定外の例外と区別が付かなくなる。
    if (!foundTool || !foundSet) {
      const result = unknownToolResult(action.type);
      this._recordExecution(engineId, action, null, startedAt, result);
      return result;
    }

    // 2. システムツールの実行
    if (foundSet.kind === 'system') {
      if (!foundTool.impl) {
        const message = `System tool <${action.type}> has no implementation.`;
        const result: ToolResult = {
          log: `Error executing <${action.type}>: ${message}`,
          ui: `❌ Error: ${message}`,
          error: true,
        };
        this._recordExecution(engineId, action, foundSet, startedAt, result);
        return result;
      }
      try {
        const result = await foundTool.impl(action.params, context);
        this._recordExecution(engineId, action, foundSet, startedAt, result);
        return result;
      } catch (raw: unknown) {
        // 期待される失敗（ToolError。VFS の拒否もここで ToolError に揃う）は、結果と tool_events に残せば足りる。
        // コンソールに赤で出すのは実装の例外だけ（T-0677）。
        const err = asToolFailure(raw);
        this._logFailure('system tool', action.type, err);
        const result: ToolResult = {
          log: `Error executing <${action.type}>: ${errorMessage(err)}`,
          ui: `❌ Error: ${errorMessage(err)}`,
          error: true,
        };
        this._recordExecution(engineId, action, foundSet, startedAt, result, err);
        return result;
      }
    }

    // 3. ゲストツールの実行 (逆方向RPC)
    try {
      const pid = foundSet.id; // ゲストツールの場合は SetID が PID そのもの
      if (!this.guestToolInvoker) {
        throw new Error('ProcessManager not connected to Shell context.');
      }

      const rawResult = await this.guestToolInvoker.invokeTool(pid, action.type, action.params);
      const rawResultSnapshot = structuredClone(rawResult);
      const result = normalizeDynamicToolResult(rawResult, action.type);
      this._recordExecution(engineId, action, foundSet, startedAt, result, undefined, rawResultSnapshot);
      return result;
    } catch (err: unknown) {
      // ゲストの handler が投げた／error を返した失敗は、invoker が ToolError にして渡す（ゲストの契約上の答え）。
      // RPC の例外（プロセスが居ない・150 秒の timeout・transport）はそのまま届くので、実装の例外として赤で出す。
      this._logFailure('dynamic tool', action.type, err);
      const result: ToolResult = {
        log: `Error executing dynamic tool <${action.type}>: ${errorMessage(err)}`,
        ui: `❌ Error: ${errorMessage(err)}`,
        error: true,
      };
      this._recordExecution(engineId, action, foundSet, startedAt, result, err);
      return result;
    }
  }

  /**
   * 失敗の記録の出し分け（T-0677）。
   *   ToolError … 期待される失敗。結果（<tool_output status="error">）と tool_events に残る。コンソールは debug だけ
   *   それ以外 … 実装の例外。console.error（人の目に触れるべきもの）
   */
  private _logFailure(kind: 'system tool' | 'dynamic tool', toolName: string, err: unknown): void {
    if (isToolError(err)) {
      console.debug(`[ToolRegistry] <${toolName}> (${kind}) refused: ${err.message}`);
      return;
    }
    console.error(`[ToolRegistry] Error executing ${kind} <${toolName}>:`, err);
  }

  private _recordExecution(
    engineId: string,
    action: { type: string; params: ToolParams },
    toolSet: ToolSet | null,
    startedAt: number,
    result?: ToolResult | null,
    error?: unknown,
    rawResult?: unknown,
  ): void {
    if (!this.executionRecorder) return;

    const errorObject = error instanceof Error ? error : null;
    const errorRecord = error
      ? {
          name: errorObject?.name,
          message: errorObject?.message || String(error),
          stack: errorObject?.stack,
          code:
            typeof error === 'object' && error !== null && 'code' in error
              ? String((error as { code?: unknown }).code)
              : undefined,
        }
      : undefined;

    const completedAt = Date.now();

    this.executionRecorder.record({
      tool: action.type,
      engine: engineId,
      kind: toolSet?.kind || 'unknown',
      toolSetId: toolSet?.id,
      sourcePid: toolSet?.kind === 'dynamic' ? toolSet.id : undefined,
      params: action.params,
      status: error || result?.error ? 'error' : 'success',
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date(completedAt).toISOString(),
      durationMs: completedAt - startedAt,
      result,
      rawResult,
      error: errorRecord,
    });
  }
}
