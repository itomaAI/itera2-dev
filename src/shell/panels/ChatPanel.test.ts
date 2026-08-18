// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { ChatPanel } from './ChatPanel';
import { LpmlRenderer } from '../services/LpmlRenderer';

/**
 * LPML タグ箱がどのレイヤの寸法で描かれるか。
 *
 * 背景: タグ箱は自分で寸法も書体も持たず、祖先から継承する（LpmlRenderer の設計）。
 * ターンの枠は2種類あり、会話レイヤ（chat-body）と機構レイヤ（chat-system-message）で
 * 寸法が違う。添付があるとユーザーターンの content が配列になり、
 * `<user_attachment>` の箱が会話レイヤの中に描かれるため、
 * MODEL 枠より大きな sans で出ていた。
 *
 * 実際の寸法は style.css の CSS 変数から入るので、ここでは計算値ではなく
 * 「その要素が機構レイヤを名乗っているか」を見る。名乗りが層の唯一の根拠である。
 */

const MECH = 'chat-system-message';

/**
 * ChatPanel のコンストラクタは入力欄・リサイザまで含めた DOM 一式を要求する。
 * ここで見たいのは描画経路だけなので、prototype から起こして必要な依存だけ与える。
 */
function makePanel() {
  document.body.innerHTML = '<div id="history"></div>';
  const history = document.getElementById('history') as HTMLElement;
  const panel: any = Object.create(ChatPanel.prototype);
  panel.renderer = new LpmlRenderer();
  panel.els = { HISTORY: history };
  panel.events = {};
  return { panel, history };
}

/** 添付つき送信で実際に積まれる content（EventOrchestrator._handleChatSend と同じ形） */
function attachmentTurn() {
  return {
    id: 'u1',
    role: 'user',
    content: [
      {
        text: '<user_attachment name="memo.md" path="system/temp/media/1_memo.md">\nこれは添付の中身\n</user_attachment>',
      },
      { text: 'この資料を読んでください' },
    ],
  };
}

describe('ChatPanel: LPML タグ箱のレイヤ', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('添付つきユーザーターンでも、タグ箱は機構レイヤの寸法で描かれる', () => {
    const { panel } = makePanel();
    panel._appendTurn(attachmentTurn());

    const turnDiv = document.getElementById('turn-u1') as HTMLElement;
    expect(turnDiv).toBeTruthy();
    // 前提: ユーザーターンの枠は会話レイヤである（ここが機構レイヤならこの試験は無意味になる）
    expect(turnDiv.className).toContain('chat-body');

    const boxes = turnDiv.querySelectorAll(`.${MECH}`);
    expect(boxes.length).toBe(1);
    expect(boxes[0].innerHTML).toContain('user_attachment');
  });

  it('利用者が打った文章は会話レイヤのまま（タグ箱に巻き込まれない）', () => {
    const { panel } = makePanel();
    panel._appendTurn(attachmentTurn());

    const turnDiv = document.getElementById('turn-u1') as HTMLElement;
    const plain = Array.from(turnDiv.querySelectorAll('div')).find((el) =>
      (el.textContent || '').includes('この資料を読んでください'),
    ) as HTMLElement;

    expect(plain).toBeTruthy();
    expect(plain.classList.contains(MECH)).toBe(false);
  });

  it('MODEL ターン（文字列 content）のタグ箱も機構レイヤを名乗る', () => {
    const { panel } = makePanel();
    panel._appendTurn({
      id: 'm1',
      role: 'model',
      content: '<thinking>\n考えている\n</thinking>',
    });

    const turnDiv = document.getElementById('turn-m1') as HTMLElement;
    const boxes = turnDiv.querySelectorAll(`.${MECH}`);
    expect(boxes.length).toBeGreaterThanOrEqual(1);
  });

  it('MODEL ターン（配列 content）のタグ箱も機構レイヤを名乗る', () => {
    const { panel } = makePanel();
    panel._appendTurn({
      id: 'm2',
      role: 'model',
      content: [{ text: '<yield />' }],
    });

    const turnDiv = document.getElementById('turn-m2') as HTMLElement;
    const boxes = turnDiv.querySelectorAll(`.${MECH}`);
    expect(boxes.length).toBe(1);
  });
});
