/**
 * src/shell/services/ProcessEventRecorder.ts
 * Itera OS v2: Process Event Logger
 */

import type { ProcessManager, Process } from '../windowing/ProcessManager';
import type { SystemLogger } from '../../core/state/SystemLogger';
import { describeMover, type Mover } from '../windowing/processGate';

export class ProcessEventRecorder {
  private processManager: ProcessManager;
  private logger: SystemLogger;

  constructor(processManager: ProcessManager, logger: SystemLogger) {
    this.processManager = processManager;
    this.logger = logger;
  }

  public start(): void {
    // by: 誰が動かしたか（T-0912。ProcessManager が、起こす・再開する・終わらせる の知らせに載せる）
    this.processManager.on('process_spawned', (proc: Process, by?: Mover) => {
      this._logEvent('spawned', proc, by);
    });

    this.processManager.on('process_resumed', (proc: Process, by?: Mover) => {
      this._logEvent('resumed', proc, by);
    });

    this.processManager.on('process_killed', (pid: string, proc?: Process, by?: Mover) => {
      // kill時は既にプロセス情報が失われている場合に備えてフォールバックを用意
      this._logEvent(
        'killed',
        proc || ({ pid, type: 'unknown', path: 'unknown', mode: 'unknown' } as unknown as Process),
        by,
      );
    });

    this.processManager.on('process_error', (proc: Process, errorData: any) => {
      this._logEvent('error', proc, undefined, errorData);
    });
  }

  private _logEvent(action: string, proc: Process, by?: Mover, errorData?: any): void {
    if (!proc) return;

    const payload = {
      action,
      pid: proc.pid,
      // 何のアプリの個体か・どのエンジンに仕えていたか（pid から読み取らなくて済むように。T-0903）
      app: proc.app,
      engine: proc.engine,
      // 誰が動かしたか: by は os / user / engine。engine のときは byEngine（その id）と、ゲストが頼んだなら via（その pid）
      ...(by ? describeMover(by) : {}),
      type: proc.type,
      path: proc.path,
      state: proc.state,
      ...(proc.args ? { args: proc.args } : {}),
      ...(errorData ? { error: errorData } : {}),
    };

    this.logger.log('process_events', payload);
  }
}
