// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChatPanel } from './ChatPanel';
import indexHtml from '../../../index.html?raw';

/**
 * チャットのつまみ: 入力欄の高さ（T-0884）と、パネルの幅。ドラッグの骨組みは shell/core/dragResize.ts（T-0885）。
 *
 * 入力欄の高さは #chat-input の CSS 変数 `--chat-input-h`、幅は #chat-panel の `--chat-w` に書く。
 * 高さの下限・上限は CSS（src/style.css）が決める。jsdom は描画しないので、ここでは実寸を試験が決め、
 * 「何を変数に書くか」の規則だけを押さえる。見た目・実際の寸法・ダブルクリックが届くことは実ブラウザで見る。
 */

function mount(): void {
  const m = /<body[^>]*>([\s\S]*)<\/body>/.exec(indexHtml);
  if (!m) throw new Error('index.html に body が無い');
  document.body.innerHTML = m[1];
  document.body.className = '';
  document.body.style.cursor = '';
}

const el = (id: string) => document.getElementById(id) as HTMLElement;
const input = () => el('chat-input') as HTMLTextAreaElement;
const handle = () => el('chat-input-resizer');
const varH = () => input().style.getPropertyValue('--chat-input-h');
const varW = () => el('chat-panel').style.getPropertyValue('--chat-w');

/** 実寸の代わり。変数が無ければ base、在れば CSS の下限・上限に当たる lo〜hi へ丸めた値 */
function fakeBox(base: number, lo = 72, hi = 600): void {
  Object.defineProperty(input(), 'offsetHeight', {
    configurable: true,
    get: () => {
      const v = varH();
      return Math.min(hi, Math.max(lo, v ? parseFloat(v) : base));
    },
  });
}

const ptr = (target: EventTarget, type: string, init: PointerEventInit = {}) =>
  target.dispatchEvent(
    new PointerEvent(type, { pointerId: 1, button: 0, buttons: 1, bubbles: true, cancelable: true, ...init }),
  );
const down = (t: EventTarget, clientY: number) => ptr(t, 'pointerdown', { clientY });
const move = (t: EventTarget, clientY: number) => ptr(t, 'pointermove', { clientY });
const up = (t: EventTarget) => ptr(t, 'pointerup');

let savedCapture: PropertyDescriptor | undefined;
beforeEach(() => {
  // jsdom に setPointerCapture は無い
  savedCapture = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'setPointerCapture');
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() });
  mount();
});
afterEach(() => {
  if (savedCapture) Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', savedCapture);
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>).setPointerCapture;
});

describe('index.html のつまみ', () => {
  it('入力欄のつまみは履歴と入力欄の間に在り、PC でだけ出る', () => {
    expect(handle()).not.toBeNull();
    expect(handle().previousElementSibling?.id).toBe('chat-history');
    expect(handle().nextElementSibling?.id).toBe('chat-composer');
    expect(handle().classList.contains('resizer-h')).toBe(true);
    expect(handle().classList.contains('hidden')).toBe(true);
    expect(handle().classList.contains('md:block')).toBe(true);
  });

  it('画面を覆う要素は無い（在ると、つまみの click・dblclick がつまみに届かない・T-0885）', () => {
    expect(document.getElementById('resize-overlay')).toBeNull();
    for (const id of ['explorer-resizer', 'chat-resizer', 'chat-input-resizer']) {
      expect(document.getElementById(id), id).not.toBeNull();
    }
  });
});

describe('ChatPanel 入力欄の高さのつまみ', () => {
  beforeEach(() => {
    fakeBox(112);
    new ChatPanel();
  });

  it('つかむ前は何も書かない（既定の高さのまま）', () => {
    move(handle(), 100);
    expect(varH()).toBe('');
  });

  it('上へ動かした分だけ高くなり、下へ戻せば低くなる', () => {
    down(handle(), 500);
    move(handle(), 400);
    expect(varH()).toBe('212px');
    move(handle(), 450);
    expect(varH()).toBe('162px');
    up(handle());
    expect(varH()).toBe('162px');
    // 離したあとの動きは拾わない
    move(handle(), 100);
    expect(varH()).toBe('162px');
  });

  it('ドラッグ中だけ、印が付いてカーソルが上下になる', () => {
    down(handle(), 500);
    expect(document.body.style.cursor).toBe('row-resize');
    expect(handle().classList.contains('resizing')).toBe(true);
    up(handle());
    expect(document.body.style.cursor).toBe('');
    expect(handle().classList.contains('resizing')).toBe(false);
  });

  it('捕捉が外れたら、つかんだままにしない', () => {
    down(handle(), 500);
    ptr(handle(), 'lostpointercapture');
    move(handle(), 100);
    expect(varH()).toBe('');
  });

  it('上限を越えて引いても、離したとき変数は実際に効いた高さになる。次は そこから始まる', () => {
    down(handle(), 500);
    move(handle(), -2000);
    expect(varH()).toBe('2612px'); // ドラッグ中は丸めない（効く高さは CSS が決める）
    up(handle());
    expect(varH()).toBe('600px');
    down(handle(), 100);
    move(handle(), 150);
    expect(varH()).toBe('550px');
    up(handle());
  });

  it('下限より下へ引いても同じ（離したとき下限になる）', () => {
    down(handle(), 500);
    move(handle(), 900);
    expect(varH()).toBe('0px');
    up(handle());
    expect(varH()).toBe('72px');
  });

  it('動かさずに離したら、変数を書かない', () => {
    down(handle(), 500);
    up(handle());
    expect(varH()).toBe('');
  });

  it('ダブルクリックで既定に戻る', () => {
    down(handle(), 500);
    move(handle(), 300);
    up(handle());
    expect(varH()).toBe('312px');
    // ダブルクリック＝押して離すを 2 回、そのあと dblclick
    down(handle(), 300);
    up(handle());
    down(handle(), 300);
    up(handle());
    handle().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(varH()).toBe('');
  });
});

describe('ChatPanel 幅のつまみ', () => {
  const resizer = () => el('chat-resizer');
  const at = (clientX: number) => ({ clientX });

  beforeEach(() => {
    Object.defineProperty(document.body, 'clientWidth', { configurable: true, get: () => 1400 });
    new ChatPanel();
  });

  it('窓の右端からポインタまでが幅になる（300 より大きく 800 より小さい間だけ）', () => {
    ptr(resizer(), 'pointerdown', at(1000));
    ptr(resizer(), 'pointermove', at(900));
    expect(varW()).toBe('500px');
    ptr(resizer(), 'pointermove', at(1200)); // 200: 狭すぎる
    expect(varW()).toBe('500px');
    ptr(resizer(), 'pointermove', at(500)); // 900: 広すぎる
    expect(varW()).toBe('500px');
    ptr(resizer(), 'pointermove', at(650));
    expect(varW()).toBe('750px');
    ptr(resizer(), 'pointerup');
    ptr(resizer(), 'pointermove', at(900));
    expect(varW()).toBe('750px');
  });

  it('ドラッグ中だけ、印が付いてカーソルが左右になる', () => {
    ptr(resizer(), 'pointerdown', at(1000));
    expect(document.body.style.cursor).toBe('col-resize');
    expect(resizer().classList.contains('resizing')).toBe(true);
    ptr(resizer(), 'pointerup');
    expect(document.body.style.cursor).toBe('');
    expect(resizer().classList.contains('resizing')).toBe(false);
  });
});
