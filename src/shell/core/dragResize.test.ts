// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { bindDragResize } from './dragResize';

/**
 * ドラッグの骨組み（T-0885）。つまみがポインタを捕まえるので、出来事はすべてつまみに届く。
 * jsdom に setPointerCapture は無いので、試験が差す。実際の捕捉（iframe の上でも続く・dblclick が届く）は実ブラウザで見る。
 */

const ptr = (type: string, init: PointerEventInit = {}) =>
  new PointerEvent(type, { pointerId: 1, button: 0, buttons: 1, bubbles: true, cancelable: true, ...init });

describe('bindDragResize', () => {
  let handle: HTMLElement;
  let capture: ReturnType<typeof vi.fn>;
  let log: string[];

  beforeEach(() => {
    document.body.innerHTML = '<div id="h"></div>';
    document.body.style.cursor = '';
    handle = document.getElementById('h') as HTMLElement;
    capture = vi.fn();
    (handle as unknown as { setPointerCapture: unknown }).setPointerCapture = capture;
    log = [];
    bindDragResize(handle, {
      cursor: 'col-resize',
      onStart: (e) => log.push(`start:${e.clientX}`),
      onMove: (e) => log.push(`move:${e.clientX}`),
      onEnd: () => log.push('end'),
    });
  });

  it('つかむと、つまみがそのポインタを捕まえる', () => {
    const e = ptr('pointerdown', { pointerId: 7, clientX: 100 });
    handle.dispatchEvent(e);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(7);
    expect(log).toEqual(['start:100']);
    expect(handle.classList.contains('resizing')).toBe(true);
    expect(document.body.style.cursor).toBe('col-resize');
    expect(e.defaultPrevented).toBe(true);
  });

  it('動きは、つかんでいる間の、つかんだポインタのものだけを拾う', () => {
    handle.dispatchEvent(ptr('pointermove', { clientX: 90 }));
    expect(log).toEqual([]);
    handle.dispatchEvent(ptr('pointerdown', { clientX: 100 }));
    handle.dispatchEvent(ptr('pointermove', { clientX: 120 }));
    handle.dispatchEvent(ptr('pointermove', { pointerId: 2, clientX: 300 }));
    expect(log).toEqual(['start:100', 'move:120']);
  });

  it('離すと終わる。印とカーソルを戻し、以後の動きは拾わない', () => {
    handle.dispatchEvent(ptr('pointerdown', { clientX: 100 }));
    handle.dispatchEvent(ptr('pointerup', { clientX: 130 }));
    expect(log).toEqual(['start:100', 'end']);
    expect(handle.classList.contains('resizing')).toBe(false);
    expect(document.body.style.cursor).toBe('');
    handle.dispatchEvent(ptr('pointermove', { clientX: 140 }));
    expect(log).toEqual(['start:100', 'end']);
  });

  it('取り消し・捕捉が外れたときも終わる。終わりは 1 回のドラッグに 1 回だけ', () => {
    handle.dispatchEvent(ptr('pointerdown'));
    handle.dispatchEvent(ptr('pointercancel'));
    expect(log.filter((x) => x === 'end')).toHaveLength(1);
    handle.dispatchEvent(ptr('lostpointercapture'));
    expect(log.filter((x) => x === 'end')).toHaveLength(1);

    handle.dispatchEvent(ptr('pointerdown'));
    handle.dispatchEvent(ptr('lostpointercapture'));
    expect(log.filter((x) => x === 'end')).toHaveLength(2);
    expect(handle.classList.contains('resizing')).toBe(false);

    handle.dispatchEvent(ptr('pointerdown'));
    handle.dispatchEvent(ptr('pointerup'));
    handle.dispatchEvent(ptr('lostpointercapture'));
    expect(log.filter((x) => x === 'end')).toHaveLength(3);
  });

  it('主ボタン以外では始めない', () => {
    handle.dispatchEvent(ptr('pointerdown', { button: 2 }));
    expect(capture).not.toHaveBeenCalled();
    expect(log).toEqual([]);
    expect(handle.classList.contains('resizing')).toBe(false);
  });

  it('別のポインタが離れても終わらない', () => {
    handle.dispatchEvent(ptr('pointerdown', { pointerId: 1, clientX: 100 }));
    handle.dispatchEvent(ptr('pointerup', { pointerId: 2 }));
    handle.dispatchEvent(ptr('pointermove', { pointerId: 1, clientX: 110 }));
    expect(log).toEqual(['start:100', 'move:110']);
  });

  it('主ボタンが離れている動きが来たら終わる（離したのを受け取れなかったとき）', () => {
    handle.dispatchEvent(ptr('pointerdown', { clientX: 100 }));
    handle.dispatchEvent(ptr('pointermove', { clientX: 120 }));
    handle.dispatchEvent(ptr('pointermove', { clientX: 300, buttons: 0 }));
    expect(log).toEqual(['start:100', 'move:120', 'end']);
    expect(handle.classList.contains('resizing')).toBe(false);
    expect(document.body.style.cursor).toBe('');
    // 副ボタンだけが押されている動きも、主ボタンは離れている
    handle.dispatchEvent(ptr('pointerdown', { clientX: 100 }));
    handle.dispatchEvent(ptr('pointermove', { clientX: 120, buttons: 2 }));
    expect(log.filter((x) => x === 'end')).toHaveLength(2);
  });

  it('次に押されたら、前のドラッグを終えてから始める（終わりを受け取れなくても固まらない）', () => {
    handle.dispatchEvent(ptr('pointerdown', { pointerId: 1, clientX: 100 }));
    handle.dispatchEvent(ptr('pointerdown', { pointerId: 2, clientX: 500 }));
    expect(log).toEqual(['start:100', 'end', 'start:500']);
    expect(capture).toHaveBeenLastCalledWith(2);
    handle.dispatchEvent(ptr('pointermove', { pointerId: 2, clientX: 510 }));
    handle.dispatchEvent(ptr('pointerup', { pointerId: 2 }));
    expect(log).toEqual(['start:100', 'end', 'start:500', 'move:510', 'end']);
  });

  it('onStart・onEnd は無くてもよい', () => {
    document.body.innerHTML = '<div id="g"></div>';
    const g = document.getElementById('g') as HTMLElement;
    (g as unknown as { setPointerCapture: unknown }).setPointerCapture = vi.fn();
    const moves: number[] = [];
    bindDragResize(g, { cursor: 'row-resize', onMove: (e) => moves.push(e.clientY) });
    g.dispatchEvent(ptr('pointerdown', { clientY: 10 }));
    expect(document.body.style.cursor).toBe('row-resize');
    g.dispatchEvent(ptr('pointermove', { clientY: 20 }));
    g.dispatchEvent(ptr('pointerup'));
    expect(moves).toEqual([20]);
  });
});
