// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { ChatPanel } from './ChatPanel';
// vite の ?raw。GuestCompiler.test.ts と同じ読み方（node:fs は agent 側の tsconfig に無い）
import indexHtml from '../../../index.html?raw';

/**
 * 自動スクロール（T-0068 の追従規則 ＋ T-0355 の 2 つの穴）
 *
 * 症状（山内さん 2026-09-05）:
 *   1. `<report>` の枠（SYSTEM → ITERA:REPORT）が下端まで出ず、手で送る必要がある
 *   2. 送信して USER 枠が出た段階で、少し足りない
 *
 * 機序（Chromium で再現。tmp/t0355/repro.mjs）:
 *   1. #chat-history の scroll-smooth。送りがアニメーションになり、10 ms 後に届く次のターンの
 *      「足す前の測定」が途中の位置を読んで wasAtBottom=false → 追従が止まる（200 px の枠が丸ごと隠れた）
 *   2. Thinking の印が #chat-composer に出ると器が 24 px 縮み、scrollTop はそのままなので下端が隠れる
 *
 * jsdom は描画しないので、ここでは寸法を持つ偽の器で「規則」を押さえる。
 *   - 器が縮んだとき、下端に居たなら送り直す（ResizeObserver）。過去を読んでいたなら動かさない
 *   - 箱があとから伸びたときも同じ
 *   - index.html の #chat-history に scroll-smooth が無い（付け直すと穴 1 が戻る）
 */

type Fake = {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  listeners: Record<string, Function[]>;
  addEventListener: (t: string, f: Function) => void;
  fire: (t: string) => void;
};
/** ブラウザと同じく scrollTop は 0〜(scrollHeight − clientHeight) に丸められる */
function fakeHistory(): Fake {
  let top = 600;
  const el: Fake = {
    scrollHeight: 1000,
    clientHeight: 400,
    get scrollTop() {
      return Math.min(top, Math.max(0, el.scrollHeight - el.clientHeight));
    },
    set scrollTop(v: number) {
      top = Math.min(Math.max(0, v), Math.max(0, el.scrollHeight - el.clientHeight));
    },
    listeners: {},
    addEventListener(t, f) {
      (el.listeners[t] ||= []).push(f);
    },
    fire(t) {
      for (const f of el.listeners[t] || []) f();
    },
  };
  return el;
}

/** ResizeObserver の偽物。観察対象と callback を記録し、試験から発火できる */
class FakeRO {
  static last: FakeRO | null = null;
  observed: any[] = [];
  cb: () => void;
  constructor(cb: () => void) {
    this.cb = cb;
    FakeRO.last = this;
  }
  observe(t: any) {
    this.observed.push(t);
  }
  disconnect() {
    this.observed = [];
  }
}

function makePanel(withRO = true) {
  const el = fakeHistory();
  const g: any = globalThis;
  if (withRO) g.ResizeObserver = FakeRO;
  else delete g.ResizeObserver;
  const panel: any = Object.create(ChatPanel.prototype);
  panel.els = { HISTORY: el };
  panel.events = {};
  panel.stickToBottom = true;
  panel.boxObserver = null;
  panel._initScrollTracking();
  return { panel, el, ro: FakeRO.last };
}
const gap = (el: Fake) => el.scrollHeight - el.scrollTop - el.clientHeight;

afterEach(() => {
  delete (globalThis as any).ResizeObserver;
  FakeRO.last = null;
});

describe('ChatPanel: 器の高さが変わったとき', () => {
  it('下端に居たなら、器が縮んでも（Thinking の印が出ても）下端が隠れない（本命 2）', () => {
    const { el, ro } = makePanel();
    expect(ro!.observed).toContain(el);
    // 送信直後: 下端に居る
    el.scrollTop = 600;
    el.fire('scroll');
    // 印が出て器が 24 px 縮む。scrollTop はそのまま → 24 px 隠れる
    el.clientHeight = 376;
    expect(gap(el)).toBe(24);
    ro!.cb();
    expect(gap(el)).toBe(0);
  });

  it('過去を読んでいる間は、器が縮んでも引き戻さない', () => {
    const { el, ro } = makePanel();
    el.scrollTop = 100; // 遡っている
    el.fire('scroll');
    el.clientHeight = 376;
    ro!.cb();
    expect(el.scrollTop).toBe(100);
  });

  it('自分が下端へ送ったあとは、scroll イベントが来なくても追従の意思が残る', () => {
    const { panel, el, ro } = makePanel();
    el.scrollTop = 100;
    el.fire('scroll'); // いったん遡った
    panel._scrollToBottom(true); // 利用者が送信した（必ず見せる）
    el.clientHeight = 376; // 直後に印が出る。器の縮みは scroll イベントを起こさない
    ro!.cb();
    expect(gap(el)).toBe(0);
  });

  it('ResizeObserver が無い環境でも壊れない（追従は従来どおり「足す前に測る」だけ）', () => {
    const { panel, ro } = makePanel(false);
    expect(ro).toBeNull();
    expect(panel.boxObserver).toBeNull();
  });
});

describe('ChatPanel: 箱があとから伸びたとき', () => {
  it('足した箱は観察され、伸びたら下端へ送る（MathJax・画像）', () => {
    const { panel, el, ro } = makePanel();
    document.body.innerHTML = '';
    const history = document.createElement('div');
    document.body.appendChild(history);
    // 偽の器の寸法を保ったまま、appendChild だけ本物に任せる
    Object.assign(el, { appendChild: (c: any) => history.appendChild(c) });
    panel.renderer = null;
    panel._appendTurn({ id: 't1', role: 'model', content: 'x' });
    const box = document.getElementById('turn-t1');
    expect(box).toBeTruthy();
    expect(ro!.observed).toContain(box);
    el.scrollTop = 600;
    el.fire('scroll');
    el.scrollHeight = 1300; // 箱が伸びた
    ro!.cb();
    expect(gap(el)).toBe(0);
  });
});

describe('index.html', () => {
  it('#chat-history に scroll-smooth を付けない（付けると穴 1 が戻る）', () => {
    const m = /<div id="chat-history"[^>]*>/.exec(indexHtml);
    expect(m).toBeTruthy();
    expect(m![0]).not.toContain('scroll-smooth');
  });
});
