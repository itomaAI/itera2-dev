// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { ChatPanel } from './ChatPanel';

/**
 * 「その変化が自分の絵に効くか」を判定するのは ChatPanel である（T-0304）。
 *
 * 履歴の作り直し（renderHistory）は innerHTML を空にして全ターンを描き直し、最下部へ強制的に送る。
 * 設定ファイルが書かれるたびにこれが走っていたため、チャット欄が上下していた。
 * 描き直しが要るかどうかは「自分の絵が何に依存しているか」で決まり、それを知るのは描く側だけである。
 */

function makePanel() {
  document.body.innerHTML = '<div id="history"></div>';
  const panel: any = Object.create(ChatPanel.prototype);
  panel.els = { HISTORY: document.getElementById('history') as HTMLElement };
  panel.events = {};
  panel.renderer = null;
  panel.hiddenEventTypes = new Set();
  return panel;
}

describe('ChatPanel: 描かないイベント種別の差し替え', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('同じ集合を渡し直しても「変わっていない」と答える（描き直しは要らない）', () => {
    const panel = makePanel();

    expect(panel.setHiddenEventTypes(['tool_available'])).toBe(true);
    expect(panel.setHiddenEventTypes(['tool_available'])).toBe(false);
  });

  it('設定していない環境では、何度渡されても「変わっていない」と答える', () => {
    const panel = makePanel();

    // preferences に hiddenEventTypes が無い環境（undefined が渡り続ける）
    expect(panel.setHiddenEventTypes(undefined)).toBe(false);
    expect(panel.setHiddenEventTypes(undefined)).toBe(false);
    expect(panel.setHiddenEventTypes([])).toBe(false);
  });

  it('並びが違うだけなら「変わっていない」（集合であって列ではない）', () => {
    const panel = makePanel();

    panel.setHiddenEventTypes(['tool_available', 'info']);
    expect(panel.setHiddenEventTypes(['info', 'tool_available'])).toBe(false);
  });

  it('増えた・減った・入れ替わったときは「変わった」と答える', () => {
    const panel = makePanel();

    expect(panel.setHiddenEventTypes(['info'])).toBe(true);
    expect(panel.setHiddenEventTypes(['info', 'tool_available'])).toBe(true); // 増えた
    expect(panel.setHiddenEventTypes(['info'])).toBe(true); // 減った
    expect(panel.setHiddenEventTypes(['tool_available'])).toBe(true); // 入れ替わった
    expect(panel.setHiddenEventTypes([])).toBe(true); // 空へ戻した
  });

  it('「変わった」と答えたあとは、実際に描かれ方が変わっている', () => {
    const panel = makePanel();
    const turn = { id: 'e1', role: 'system', content: 'x', meta: { eventType: 'info' } };

    panel._appendTurn(turn);
    expect(document.getElementById('turn-e1')).toBeTruthy();

    document.body.innerHTML = '<div id="history"></div>';
    panel.els.HISTORY = document.getElementById('history') as HTMLElement;

    expect(panel.setHiddenEventTypes(['info'])).toBe(true);
    panel._appendTurn(turn);
    expect(document.getElementById('turn-e1')).toBeNull();
  });
});
