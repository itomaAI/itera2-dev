// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { ChatPanel } from './ChatPanel';
import indexHtml from '../../../index.html?raw';

/**
 * 入力欄の高さのつまみ（T-0884）。
 * 履歴と入力欄の境界をドラッグすると、#chat-input の CSS 変数 `--chat-input-h` が変わる。
 * 下限・上限は CSS（src/style.css）が決める。jsdom は描画しないので、ここでは実寸を試験が決め、
 * 「何を変数に書くか」の規則だけを押さえる。見た目と実際の寸法は実ブラウザで見る。
 */

function mount(): void {
  const m = /<body[^>]*>([\s\S]*)<\/body>/.exec(indexHtml);
  if (!m) throw new Error('index.html に body が無い');
  document.body.innerHTML = m[1];
  document.body.className = '';
  document.body.style.cursor = '';
}

const input = () => document.getElementById('chat-input') as HTMLTextAreaElement;
const handle = () => document.getElementById('chat-input-resizer') as HTMLElement;
const overlay = () => document.getElementById('resize-overlay') as HTMLElement;
const varH = () => input().style.getPropertyValue('--chat-input-h');

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

const mouse = (target: EventTarget, type: string, clientY = 0) =>
  target.dispatchEvent(new MouseEvent(type, { clientY, bubbles: true, cancelable: true }));

describe('ChatPanel 入力欄の高さのつまみ', () => {
  beforeEach(() => {
    mount();
    fakeBox(112);
    new ChatPanel();
  });

  it('index.html: つまみは履歴と入力欄の間に在り、PC でだけ出る', () => {
    expect(handle()).not.toBeNull();
    expect(handle().previousElementSibling?.id).toBe('chat-history');
    expect(handle().nextElementSibling?.id).toBe('chat-composer');
    expect(handle().classList.contains('resizer-h')).toBe(true);
    expect(handle().classList.contains('hidden')).toBe(true);
    expect(handle().classList.contains('md:block')).toBe(true);
  });

  it('つかむ前は何も書かない（既定の高さのまま）', () => {
    mouse(document, 'mousemove', 100);
    expect(varH()).toBe('');
  });

  it('上へ動かした分だけ高くなり、下へ戻せば低くなる', () => {
    mouse(handle(), 'mousedown', 500);
    mouse(document, 'mousemove', 400);
    expect(varH()).toBe('212px');
    mouse(document, 'mousemove', 450);
    expect(varH()).toBe('162px');
    mouse(document, 'mouseup');
    expect(varH()).toBe('162px');
    // 離したあとの動きは拾わない
    mouse(document, 'mousemove', 100);
    expect(varH()).toBe('162px');
  });

  it('ドラッグ中だけ、覆いが出てカーソルが上下になる', () => {
    expect(overlay().classList.contains('hidden')).toBe(true);
    mouse(handle(), 'mousedown', 500);
    expect(overlay().classList.contains('hidden')).toBe(false);
    expect(overlay().style.cursor).toBe('row-resize');
    expect(document.body.style.cursor).toBe('row-resize');
    expect(handle().classList.contains('resizing')).toBe(true);
    mouse(document, 'mouseup');
    expect(overlay().classList.contains('hidden')).toBe(true);
    expect(overlay().style.cursor).toBe('');
    expect(document.body.style.cursor).toBe('');
    expect(handle().classList.contains('resizing')).toBe(false);
  });

  it('窓がフォーカスを失ったら、つかんだままにしない', () => {
    mouse(handle(), 'mousedown', 500);
    window.dispatchEvent(new Event('blur'));
    expect(overlay().classList.contains('hidden')).toBe(true);
    mouse(document, 'mousemove', 100);
    expect(varH()).toBe('');
  });

  it('上限を越えて引いても、離したとき変数は実際に効いた高さになる。次は そこから始まる', () => {
    mouse(handle(), 'mousedown', 500);
    mouse(document, 'mousemove', -2000);
    expect(varH()).toBe('2612px'); // ドラッグ中は丸めない（効く高さは CSS が決める）
    mouse(document, 'mouseup');
    expect(varH()).toBe('600px');
    mouse(handle(), 'mousedown', 100);
    mouse(document, 'mousemove', 150);
    expect(varH()).toBe('550px');
    mouse(document, 'mouseup');
  });

  it('下限より下へ引いても同じ（離したとき下限になる）', () => {
    mouse(handle(), 'mousedown', 500);
    mouse(document, 'mousemove', 900);
    expect(varH()).toBe('0px');
    mouse(document, 'mouseup');
    expect(varH()).toBe('72px');
  });

  it('動かさずに離したら、変数を書かない', () => {
    mouse(handle(), 'mousedown', 500);
    mouse(document, 'mouseup');
    expect(varH()).toBe('');
  });
});
