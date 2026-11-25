/**
 * プロセスの関所の規則（T-0912）: OS と利用者は全部・ルートは全部・ほかのエンジンは自分に仕えるプロセスだけ。
 */
import { describe, expect, it } from 'vitest';
import { OS_MOVER, USER_MOVER, ProcessRefusedError, canMove, engineMover } from './processGate';
import { ROOT_ENGINE_ID } from '../../core/control/Engine';

const targets = [{ engine: ROOT_ENGINE_ID }, { engine: 'eng-a' }, { engine: 'eng-b' }];
const row = (mover: Parameters<typeof canMove>[0]) => targets.map((t) => canMove(mover, t));

describe('processGate: 動かしてよいか', () => {
  it('OS と利用者は全部', () => {
    expect(row(OS_MOVER)).toEqual([true, true, true]);
    expect(row(USER_MOVER)).toEqual([true, true, true]);
  });

  it('ルートのエンジンは全部', () => {
    expect(row(engineMover(ROOT_ENGINE_ID))).toEqual([true, true, true]);
  });

  it('ほかのエンジンは、自分に仕えるプロセスだけ', () => {
    expect(row(engineMover('eng-a'))).toEqual([false, true, false]);
    expect(row(engineMover('eng-b'))).toEqual([false, false, true]);
    // 仕える者の居ないエンジンは、何も動かせない
    expect(row(engineMover('eng-c'))).toEqual([false, false, false]);
  });

  it('エンジンに仕えるゲストのプロセスは、そのエンジンとして（経由した pid は判定に効かない）', () => {
    expect(row(engineMover('eng-a', 'some_app'))).toEqual([false, true, false]);
    expect(row(engineMover(ROOT_ENGINE_ID, 'home'))).toEqual([true, true, true]);
    expect(engineMover('eng-a', 'some_app')).toEqual({ kind: 'engine', engine: 'eng-a', via: 'some_app' });
    expect(engineMover('eng-a')).toEqual({ kind: 'engine', engine: 'eng-a' });
  });

  it('断りの文は、相手・その仕える先・しようとしたこと', () => {
    const e = new ProcessRefusedError({ pid: 'notes', engine: 'root' }, 'kill');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ProcessRefusedError');
    expect(e.message).toBe('Process "notes" serves another engine ("root"). This engine cannot kill it.');
  });
});
