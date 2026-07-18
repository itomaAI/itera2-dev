/**
 * src/shell/services/ProcessEventRecorder.ts
 * Itera OS v2: Process Event Logger
 */

import type { ProcessManager, Process } from '../windowing/ProcessManager';
import type { SystemLogger } from '../../core/state/SystemLogger';

export class ProcessEventRecorder {
  private processManager: ProcessManager;
  private logger: SystemLogger;

  constructor(processManager: ProcessManager, logger: SystemLogger) {
    this.processManager = processManager;
    this.logger = logger;
  }

  public start(): void {
    this.processManager.on('process_spawned', (proc: Process) => {
      this._logEvent('spawned', proc);
    });

    this.processManager.on('process_resumed', (proc: Process) => {
      this._logEvent('resumed', proc);
    });

    this.processManager.on('process_killed', (pid: string, proc?: Process) => {
      // kill時は既にプロセス情報が失われている場合に備えてフォールバックを用意
      this._logEvent('killed', proc || ({ pid, type: 'unknown', path: 'unknown', mode: 'unknown' } as unknown as Process));
    });

    this.processManager.on('process_error', (proc: Process, errorData: any) => {
      this._logEvent('error', proc, errorData);
    });
  }

  private _logEvent(action: string, proc: Process, errorData?: any): void {
    if (!proc) return;

    const payload = {
      action,
      pid: proc.pid,
      type: proc.type,
      path: proc.path,
      mode: proc.mode,
      ...(proc.args ? { args: proc.args } : {}),
      ...(errorData ? { error: errorData } : {})
    };

    this.logger.log('process_events', payload);
  }
}