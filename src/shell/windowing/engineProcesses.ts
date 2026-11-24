/**
 * src/shell/windowing/engineProcesses.ts
 * 道具に渡す、プロセスの取っ手（T-0908）。エンジンごとに 1 つ作る。
 *
 * 道具は ProcessManager を丸ごとは掴まない。この取っ手が決めるのは:
 *   - 道具が起こすプロセスは、このエンジンに仕える
 *   - 動かせる（終わらせる・コードを差す・名指しで再開／起こし直す）のは、自分に仕えるプロセスだけ。
 *     OS のチャットのエンジン（ルート）は全部を動かせる
 *   - 見る（一覧・画面写真）のは全部
 * 窓の上限は ProcessManager が見る（ゲストが起こすときも同じ所を通る）。断られたら、道具の失敗として返す。
 */

import { ROOT_ENGINE_ID } from '../../core/control/Engine';
import { ToolError } from '../../core/control/ToolError';
import type { ToolProcesses } from '../../core/control/ToolContext';
import { SpawnRefusedError, type Process, type SpawnOptions } from './ProcessManager';

/** 取っ手が使う分（ProcessManager と HostTransport が満たす） */
export interface EngineProcessesDeps {
  processManager: {
    processes: ReadonlyMap<string, Process>;
    spawn(options: SpawnOptions): Promise<void>;
    kill(pid: string): boolean;
    captureScreenshot(pid?: string, timeoutMs?: number): Promise<string>;
  };
  transport: {
    invokeGuest(pid: string, action: string, payload: unknown, targetWindow: Window): Promise<unknown>;
  };
}

export function createEngineProcesses(deps: EngineProcessesDeps, engineId: string): ToolProcesses {
  const { processManager: pm, transport } = deps;
  const movable = (proc: Process) => engineId === ROOT_ENGINE_ID || proc.engine === engineId;
  const notYours = (proc: Process, what: string) =>
    new ToolError(`Process "${proc.pid}" serves another engine ("${proc.engine}"). This engine cannot ${what} it.`);

  return {
    async spawn(options) {
      if (options.pid) {
        // 名指し: 居れば、そこへの再開か起こし直しになる
        const holder = pm.processes.get(options.pid);
        if (holder && !movable(holder)) throw notYours(holder, 'resume or restart');
      }
      try {
        await pm.spawn({ ...options, engine: engineId });
      } catch (e) {
        if (e instanceof SpawnRefusedError) throw new ToolError(e.message, { cause: e });
        throw e;
      }
    },

    kill(pid) {
      const proc = pm.processes.get(pid);
      if (!proc) return false;
      if (!movable(proc)) throw notYours(proc, 'kill');
      return pm.kill(pid);
    },

    list() {
      return Array.from(pm.processes.values()).map((proc) => ({
        pid: proc.pid,
        path: proc.path,
        type: proc.type,
        state: proc.state,
        engine: proc.engine,
        mine: proc.engine === engineId,
      }));
    },

    capture(pid, timeoutMs) {
      return pm.captureScreenshot(pid, timeoutMs);
    },

    async evalJs(pid, code) {
      const proc = pm.processes.get(pid);
      if (!proc || !proc.iframe || !proc.iframe.contentWindow) {
        throw new ToolError(`Target process '${pid}' is not running.`);
      }
      if (!movable(proc)) throw notYours(proc, 'run code in');
      return transport.invokeGuest(pid, 'eval_js', { code }, proc.iframe.contentWindow);
    },
  };
}
