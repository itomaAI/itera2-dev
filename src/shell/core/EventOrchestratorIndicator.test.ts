import { describe, it, expect } from 'vitest';
import { decideIndicatorOnTurnEnd } from './EventOrchestrator';

/**
 * ターン終了時に待機表示をどうするか（T-0028）
 *
 * Engine の流れ:
 *   turn_start(model) → stream → turn_end(model)
 *   → ツールがあれば _dispatchActions（await されない）
 *   → finally で isRunning=false
 *   → 各ツール結果が turn_end(system) を出す
 *   → 最後に loop_stop
 *
 * ★ 以前は「isRunning が false なら消す」だけだった。ツール実行は isRunning=false に
 *   なった**後**に走るため、最初のツール結果が届いた時点で待機表示が消えていた。
 *   文言以前に、"Processing..." が出る余地が無かった。
 *
 * Engine 側（デバウンス付き非同期実行）には一切手を触れず、表示の判断だけをここで持つ。
 */

describe('turn_end のときに待機表示をどうするか', () => {
  it('モデルのターンが終わったらツール実行帯に入る（本命）', () => {
    // ツールが無ければ Engine が同じ同期ブロックで loop_stop を出すので、
    // 画面に Processing... が見えることはない。
    expect(decideIndicatorOnTurnEnd('model', true, false)).toBe('processing');
  });

  it('ツール実行中のツール結果では消さない（本命 / ここで消えていた）', () => {
    // ツール実行中は isRunning=false。ここを 'hide' にすると元の欠陥に戻る。
    expect(decideIndicatorOnTurnEnd('system', false, true)).toBe('keep');
  });

  it('何も走っていないときの system ターンは消す（取り残し防止）', () => {
    // 背景の ai.log などでターンだけ積まれた場合。出しっぱなしにしない。
    expect(decideIndicatorOnTurnEnd('system', false, false)).toBe('hide');
  });

  it('まだ走っているなら触らない', () => {
    expect(decideIndicatorOnTurnEnd('system', true, false)).toBe('keep');
    expect(decideIndicatorOnTurnEnd('user', true, false)).toBe('keep');
  });

  it('ツール実行帯でなく、停止済みなら user ターンでも消す', () => {
    expect(decideIndicatorOnTurnEnd('user', false, false)).toBe('hide');
  });
});
