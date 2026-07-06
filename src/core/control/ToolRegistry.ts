/**
 * src/core/control/ToolRegistry.ts
 * Itera OS v2: Tool and ToolSet Registry
 */

import type { AppRegistry } from "../sys/AppRegistry";
import type { ShellController } from "../../shell/core/ShellController";

export interface ToolDef {
  name: string;
  description: string;
  definition?: string;
  impl?: (params: any, context: any) => Promise<any>;
}

export interface ToolSet {
  id: string; // "system:fs", "app_tasks" など
  name: string; // "System: File Operations", "App: Tasks" など
  description?: string;
  tools: Map<string, ToolDef>;
}

export class ToolRegistry {
  private toolSets: Map<string, ToolSet> = new Map();
  private appRegistry: AppRegistry | null = null;

  constructor(appRegistry?: AppRegistry) {
    if (appRegistry) {
      this.appRegistry = appRegistry;
    }
  }

  // ==========================================
  // System Tools Management
  // ==========================================

  /**
   * システムツールセット（カテゴリ）を作成または取得する
   */
  private _getOrCreateSystemToolSet(
    setId: string,
    setName: string,
    description?: string,
  ): ToolSet {
    if (!this.toolSets.has(setId)) {
      this.toolSets.set(setId, {
        id: setId,
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
  registerDynamicTool(toolName: string, sourcePid: string, payload: any): void {
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
              sourcePid.includes(a.id) ||
              sourcePid.includes(
                a.path.split(/[?#]/)[0].replace(/[^a-zA-Z0-9_-]/g, "_"),
              ),
          );
        if (appInfo) {
          setName = `App: ${appInfo.name} (${appInfo.icon})`;
          if (appInfo.description) description = appInfo.description;
        }
      }

      toolSet = { id: setId, name: setName, description, tools: new Map() };
      this.toolSets.set(setId, toolSet);
    }

    toolSet.tools.set(toolName, {
      name: toolName,
      description: payload.description || "",
      definition: payload.definition,
    });

    console.log(
      `[ToolRegistry] Registered dynamic tool: <${toolName}> into ToolSet: [${toolSet.name}]`,
    );
  }

  /**
   * 動的ツールを明示的に解除する
   */
  unregisterDynamicTool(toolName: string, sourcePid: string): void {
    const toolSet = this.toolSets.get(sourcePid);
    if (toolSet && toolSet.tools.has(toolName)) {
      toolSet.tools.delete(toolName);
      console.log(
        `[ToolRegistry] Unregistered dynamic tool: <${toolName}> from PID: ${sourcePid}`,
      );

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
        console.log(
          `[ToolRegistry] Removed ToolSet [${toolSet.name}] (${count} tools) due to process termination.`,
        );
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
      // システムツール（"system:" 始まり）は除外し、動的ツールのみを抽出
      if (toolSet.id.startsWith("system:")) continue;
      if (toolSet.tools.size === 0) continue;

      let block = `<toolset name="${toolSet.name}" pid="${toolSet.id}"${toolSet.description ? ` description="${toolSet.description}"` : ""}>\n`;
      for (const tool of toolSet.tools.values()) {
        if (tool.definition) {
          // インデントをつけて整形
          block +=
            tool.definition
              .split("\n")
              .map((line) => `  ${line}`)
              .join("\n") + "\n";
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
    action: { type: string; params: any },
    context: { shell: ShellController; engine: any } & Record<string, any>,
  ): Promise<any> {
    // 1. 全Toolsetから対象のツールを検索する
    let foundTool: ToolDef | null = null;
    let foundSetId: string | null = null;

    for (const toolSet of this.toolSets.values()) {
      if (toolSet.tools.has(action.type)) {
        foundTool = toolSet.tools.get(action.type)!;
        foundSetId = toolSet.id;
        break;
      }
    }

    if (!foundTool || !foundSetId) {
      const err: any = new Error(
        `Unknown Tool: <${action.type}> is not registered or not available.`,
      );
      err.code = "UNKNOWN_TOOL";
      err.actionType = action.type;
      throw err;
    }

    // 2. システムツールの実行
    if (foundSetId.startsWith("system:")) {
      if (!foundTool.impl) {
        throw new Error(
          `[ToolRegistry] System tool <${action.type}> has no implementation.`,
        );
      }
      try {
        return await foundTool.impl(action.params, context);
      } catch (err: any) {
        console.error(
          `[ToolRegistry] Error executing system tool <${action.type}>:`,
          err,
        );
        return {
          log: `Error executing <${action.type}>: ${err.message}`,
          ui: `❌ Error: ${err.message}`,
          error: true,
        };
      }
    }

    // 3. ゲストツールの実行 (逆方向RPC)
    try {
      const pid = foundSetId; // ゲストツールの場合は SetID が PID そのもの
      const pm = context.shell["processManager"]; // Privateアクセスを回避するためブラケット記法

      if (!pm)
        throw new Error("ProcessManager not connected to Shell context.");

      const proc = pm.processes.get(pid);
      if (!proc || !proc.iframe || !proc.iframe.contentWindow) {
        throw new Error(`Target process '${pid}' is no longer available.`);
      }

      // Shellが保持しているHostTransportを利用する
      const transport = context.shell["transport"];
      if (!transport)
        throw new Error("HostTransport not connected to Shell context.");

      let result = await transport.invokeGuest(
        pid,
        "execute_tool",
        { name: action.type, params: action.params },
        proc.iframe.contentWindow,
      );

      // 戻り値の正規化
      if (typeof result !== "object" || result === null) {
        result = { log: String(result), ui: `⚙️ ${action.type}` };
      } else if (result.log === undefined) {
        result.log = JSON.stringify(result);
      }
      if (!result.ui) result.ui = `⚙️ ${action.type}`;

      return result;
    } catch (err: any) {
      console.error(
        `[ToolRegistry] Error executing dynamic tool <${action.type}>:`,
        err,
      );
      return {
        log: `Error executing dynamic tool <${action.type}>: ${err.message}`,
        ui: `❌ Error: ${err.message}`,
        error: true,
      };
    }
  }
}
