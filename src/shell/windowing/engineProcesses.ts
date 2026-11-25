/**
 * src/shell/windowing/engineProcesses.ts
 * 道具に渡す、プロセスの取っ手（T-0908）。エンジンごとに 1 つ作る。
 *
 * 道具は ProcessManager を丸ごとは掴まない。この取っ手は「誰が」（このエンジン）を焼き込んで、関所（ProcessManager）へ渡すだけ。
 * 動かしてよいかを決めるのは関所（規則は processGate.ts。T-0912）:
 *   - 道具が起こすプロセスは、このエンジンに仕える
 *   - 動かせる（終わらせる・コードを差す・名指しで再開／起こし直す）のは、自分に仕えるプロセスだけ。
 *     OS のチャットのエンジン（ルート）は全部を動かせる
 *   - 見る（一覧・画面写真）のは全部
 * 関所に断られたら（動かせない相手・窓の上限）、道具の失敗として返す。
 */

import { ToolError } from '../../core/control/ToolError';
import type { ToolProcesses } from '../../core/control/ToolContext';
import { SpawnRefusedError, type Process, type SpawnOptions } from './ProcessManager';
import { ProcessRefusedError, engineMover, type Mover } from './processGate';

/** 取っ手が使う分（ProcessManager が満たす） */
export interface EngineProcessesDeps {
  processManager: {
    processes: ReadonlyMap<string, Process>;
    spawn(mover: Mover, options: SpawnOptions): Promise<void>;
    kill(mover: Mover, pid: string): boolean;
    captureScreenshot(pid?: string, timeoutMs?: number): Promise<string>;
    isReachable(pid: string): boolean;
    evalIn(mover: Mover, pid: string, code: string): Promise<unknown>;
  };
}

/** 関所の断りは、道具の失敗（ToolError）にする。ほかの例外はそのまま通す */
function refusalAsToolError(e: unknown): never {
  if (e instanceof ProcessRefusedError || e instanceof SpawnRefusedError) {
    throw new ToolError(e.message, { cause: e });
  }
  throw e;
}

export function createEngineProcesses(deps: EngineProcessesDeps, engineId: string): ToolProcesses {
  const { processManager: pm } = deps;
  const me = engineMover(engineId);

  return {
    async spawn(options) {
      try {
        await pm.spawn(me, options);
      } catch (e) {
        refusalAsToolError(e);
      }
    },

    kill(pid) {
      try {
        return pm.kill(me, pid);
      } catch (e) {
        return refusalAsToolError(e);
      }
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
      if (!pm.isReachable(pid)) throw new ToolError(`Target process '${pid}' is not running.`);
      try {
        return await pm.evalIn(me, pid, code);
      } catch (e) {
        return refusalAsToolError(e);
      }
    },
  };
}
