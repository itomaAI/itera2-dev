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

/**
 * 自動スクロールの塩梅（T-0068）
 *
 * 依頼:
 *   「AI やシステムが新しい出力をしたとき・人間が書き込んだときは最新まで自動スクロールしてほしいが、
 *     過去の発言を見返しているときに最新までスクロールされると困る」
 *
 * 直す前の状態:
 *   番人（下端にいるかの判定）は既にあったが、**呼び出しの大半が force=true で素通り**していた。
 *   さらに判定そのものが **DOM を足したあと**に測っており、
 *   追加された高さが許容幅（100px）を超えると、下端に貼り付いていても
 *   「過去を読んでいる」に化けて**追従が黙って止まった**。
 *
 * したがってここで守るのは二方向である:
 *   1. 遡って読んでいる間は、AI の出力で**動かさない**
 *   2. 下端にいる間は、長い出力でも**追従する**（片方だけ直すと、もう片方が壊れる）
 */

/** jsdom は採寸しないので、寸法は自分で持つ。 */
function makeScrollablePanel(opts: { atBottom: boolean }) {
  const { panel, history } = makePanel();
  let scrollHeight = 1000;
  const clientHeight = 500;

  Object.defineProperty(history, 'scrollHeight', { get: () => scrollHeight, configurable: true });
  Object.defineProperty(history, 'clientHeight', { get: () => clientHeight, configurable: true });

  // 下端 … 1000 - 500 = 500 <= 500 + 100 ✓ ／ 上の方 … 1000 - 0 = 1000 > 600 ✗
  history.scrollTop = opts.atBottom ? 500 : 0;

  /** 出力が積まれて画面が伸びるのをまねる。 */
  const grow = (px: number) => {
    scrollHeight += px;
  };
  return { panel, history, grow, height: () => scrollHeight };
}

const modelTurn = (id: string) => ({ id, role: 'model', content: 'output' }) as any;
const userTurn = (id: string) => ({ id, role: 'user', content: 'hello' }) as any;

describe('ChatPanel: 自動スクロールの塩梅', () => {
  it('下端にいるとき、AI の新しいターンで追従する（足したあとに測る実装だと落ちる・本命）', () => {
    const { panel, history, grow } = makeScrollablePanel({ atBottom: true });
    // 追加で 400px 伸びる＝許容幅 100px を大きく超える。
    // 「足したあとに測る」実装は、ここで過去を読んでいると誤判定して追従をやめる。
    panel._appendTurn = () => grow(400);

    panel.appendTurn(modelTurn('m1'));

    expect(history.scrollTop).toBe(1400);
  });

  it('遡って読んでいるとき、AI の新しいターンでは動かさない（依頼の中心）', () => {
    const { panel, history, grow } = makeScrollablePanel({ atBottom: false });
    panel._appendTurn = () => grow(400);

    panel.appendTurn(modelTurn('m1'));

    expect(history.scrollTop).toBe(0);
  });

  it('遡って読んでいても、自分が送ったものは最下部まで送る', () => {
    const { panel, history, grow } = makeScrollablePanel({ atBottom: false });
    panel._appendTurn = () => grow(200);

    panel.appendTurn(userTurn('u1'));

    expect(history.scrollTop).toBe(1200);
  });

  it('下端にいるとき、長いチャンクの追記でも追従する', () => {
    const { panel, history, grow } = makeScrollablePanel({ atBottom: true });
    panel.currentStreamEl = document.createElement('div');
    panel.currentStreamContent = '';
    panel._renderLpmlInto = () => {
      grow(600); // コード塊のような大きな追記
      return true;
    };

    panel.updateStreaming('a'.repeat(2000));

    expect(history.scrollTop).toBe(1600);
  });

  it('遡って読んでいるとき、生成中の追記では動かさない', () => {
    const { panel, history, grow } = makeScrollablePanel({ atBottom: false });
    panel.currentStreamEl = document.createElement('div');
    panel.currentStreamContent = '';
    panel._renderLpmlInto = () => {
      grow(600);
      return true;
    };

    panel.updateStreaming('chunk');

    expect(history.scrollTop).toBe(0);
  });

  it('生成の開始でも、遡って読んでいるなら引き戻さない', () => {
    const { panel, history, grow } = makeScrollablePanel({ atBottom: false });
    panel._createStreamElement = () => grow(120);

    panel.startStreaming('t1');

    expect(history.scrollTop).toBe(0);
  });

  it('生成の終了でも、遡って読んでいるなら引き戻さない', () => {
    const { panel, history } = makeScrollablePanel({ atBottom: false });
    panel.currentStreamEl = null;
    panel.currentStreamContent = '';

    panel.finalizeStreaming();

    expect(history.scrollTop).toBe(0);
  });

  it('履歴の作り直しは最下部へ送る（innerHTML を空にした時点で位置は失われている）', () => {
    const { panel, history } = makeScrollablePanel({ atBottom: false });

    panel.renderHistory([]);

    expect(history.scrollTop).toBe(history.scrollHeight);
  });

  it('境界: 許容幅（100px）のうちは「下端にいる」、超えたら「遡っている」', () => {
    const inside = makeScrollablePanel({ atBottom: true });
    // 1000 - 400 = 600 <= 500 + 100 … ちょうど許容の端
    inside.history.scrollTop = 400;
    inside.panel._appendTurn = () => inside.grow(50);
    inside.panel.appendTurn(modelTurn('m1'));
    expect(inside.history.scrollTop).toBe(1050);

    const outside = makeScrollablePanel({ atBottom: true });
    // 1000 - 399 = 601 > 600 … 1px 超えたら追従しない
    outside.history.scrollTop = 399;
    outside.panel._appendTurn = () => outside.grow(50);
    outside.panel.appendTurn(modelTurn('m1'));
    expect(outside.history.scrollTop).toBe(399);
  });
});
