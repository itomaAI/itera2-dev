/**
 * src/core/control/ToolRegistry.ts
 * Itera OS v2: Tool and ToolSet Registry
 */

import type { AppRegistry } from '../sys/AppRegistry';
import type { GuestToolInvoker } from './GuestToolInvoker';
import { normalizeDynamicToolResult } from './ToolResultNormalizer';
import type { ToolParams, ToolResult } from '../types/tools';

export interface ToolDef {
  name: string;
  description: string;
  definition?: string;
  impl?: (params: ToolParams, context: any) => Promise<ToolResult | null>;
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

export class UnknownToolError extends Error {
  readonly code = 'UNKNOWN_TOOL';
  readonly actionType: string;

  constructor(actionType: string) {
    super(`Unknown Tool: <${actionType}> is not registered or not available.`);
    this.actionType = actionType;
  }
}

export class ToolRegistry {
  private toolSets: Map<string, ToolSet> = new Map();
  private appRegistry: AppRegistry | null = null;
  private guestToolInvoker: GuestToolInvoker | null = null;

  constructor(appRegistry?: AppRegistry) {
    if (appRegistry) {
      this.appRegistry = appRegistry;
    }
  }

  setGuestToolInvoker(invoker: GuestToolInvoker): void {
    this.guestToolInvoker = invoker;
  }

  // ==========================================
  // System Tools Management
  // ==========================================

  /**
   * システムツールセット（カテゴリ）を作成または取得する
   */
  private _getOrCreateSystemToolSet(setId: string, setName: string, description?: string): ToolSet {
    if (!this.toolSets.has(setId)) {
      this.toolSets.set(setId, {
        id: setId,
        kind: 'system',
        name: setName,
        description,
        tools: new Map(),
      });
    }
    return this.toolSets.get(setId)!;
  }

  /**
   * システムツール（固定）を特定のカテゴリに登録する
   */
  registerSystemTool(setId: string, setName: string, toolDef: ToolDef): void {
    const toolSet = this._getOrCreateSystemToolSet(setId, setName);
    toolSet.tools.set(toolDef.name, toolDef);
  }

  // ==========================================
  // Dynamic (Guest) Tools Management
  // ==========================================

  /**
   * ゲストアプリからの動的ツールを登録する
   * sourcePidからよしなにアプリ情報を解決し、Toolsetに自動分類する
   */
  registerDynamicTool(toolName: string, sourcePid: string, payload: DynamicToolDefinition): void {
    const setId = sourcePid;
    let toolSet = this.toolSets.get(setId);

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
      this.toolSets.set(setId, toolSet);
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
  unregisterDynamicTool(toolName: string, sourcePid: string): void {
    const toolSet = this.toolSets.get(sourcePid);
    if (toolSet && toolSet.tools.has(toolName)) {
      toolSet.tools.delete(toolName);
      console.log(`[ToolRegistry] Unregistered dynamic tool: <${toolName}> from PID: ${sourcePid}`);

      // グループが空になったらToolsetごと消す
      if (toolSet.tools.size === 0) {
        this.toolSets.delete(sourcePid);
      }
    }
  }

  /**
   * 特定のPIDに紐づくすべての動的ツールを一括で削除する（プロセスキル時のクリーンアップ用）
   */
  removeToolsByPid(pid: string): void {
    if (this.toolSets.has(pid)) {
      const toolSet = this.toolSets.get(pid)!;
      const count = toolSet.tools.size;
      this.toolSets.delete(pid);
      if (count > 0) {
        console.log(`[ToolRegistry] Removed ToolSet [${toolSet.name}] (${count} tools) due to process termination.`);
      }
    }
  }

  // ==========================================
  // Query & Execution
  // ==========================================

  /**
   * 現在登録されているすべての動的ツールを <toolset> タグでグループ化して出力する
   * セッションリセット時やシステムプロンプトの注入用
   */
  getActiveDynamicToolDefinitions(): string[] {
    const output: string[] = [];

    for (const toolSet of this.toolSets.values()) {
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
   * 登録されているすべてのツール名（タグ名）の配列を取得する（Parserの保護対象指定用）
   */
  getRegisteredToolNames(): string[] {
    const names: string[] = [];
    for (const toolSet of this.toolSets.values()) {
      for (const name of toolSet.tools.keys()) {
        names.push(name);
      }
    }
    return names;
  }

  /**
   * アクションを検索して実行する
   */
  async execute(
    action: { type: string; params: ToolParams },
    context: { shell: any; engine: any } & Record<string, any>,
  ): Promise<ToolResult | null> {
    // 1. 全Toolsetから対象のツールを検索する
    let foundTool: ToolDef | null = null;
    let foundSet: ToolSet | null = null;

    for (const toolSet of this.toolSets.values()) {
      if (toolSet.tools.has(action.type)) {
        foundTool = toolSet.tools.get(action.type)!;
        foundSet = toolSet;
        break;
      }
    }

    if (!foundTool || !foundSet) {
      throw new UnknownToolError(action.type);
    }

    // 2. システムツールの実行
    if (foundSet.kind === 'system') {
      if (!foundTool.impl) {
        throw new Error(`[ToolRegistry] System tool <${action.type}> has no implementation.`);
      }
      try {
        return await foundTool.impl(action.params, context);
      } catch (err: any) {
        console.error(`[ToolRegistry] Error executing system tool <${action.type}>:`, err);
        return {
          log: `Error executing <${action.type}>: ${err.message}`,
          ui: `❌ Error: ${err.message}`,
          error: true,
        };
      }
    }

    // 3. ゲストツールの実行 (逆方向RPC)
    try {
      const pid = foundSet.id; // ゲストツールの場合は SetID が PID そのもの
      if (!this.guestToolInvoker) {
        throw new Error('ProcessManager not connected to Shell context.');
      }

      const result = await this.guestToolInvoker.invokeTool(pid, action.type, action.params);
      return normalizeDynamicToolResult(result, action.type);
    } catch (err: any) {
      console.error(`[ToolRegistry] Error executing dynamic tool <${action.type}>:`, err);
      return {
        log: `Error executing dynamic tool <${action.type}>: ${err.message}`,
        ui: `❌ Error: ${err.message}`,
        error: true,
      };
    }
  }
}
