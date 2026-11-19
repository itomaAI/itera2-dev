/**
 * src/shell/core/dragResize.ts
 * つまみをドラッグして寸法を変える操作の骨組み（エクスプローラの幅・チャットの幅・チャットの入力欄の高さが使う）。
 *
 * ドラッグの間、ポインタはつまみが捕まえる（setPointerCapture）。動きは iframe の上でもつまみに届くので、
 * 画面を覆う要素は要らない。以前は mousedown で全面の覆いを出していて、mouseup が覆いに落ちるため、
 * つまみの click・dblclick がつまみに届かなかった（ダブルクリックで畳む、が効いていなかった。T-0885）。
 *
 * 何を測り、どこへ書くかは使う側が決める。ここは「いつ始まり、いつ終わるか」だけを持つ。
 * 終わりは出来事から導く: 離した・取り消された・捕捉が外れた、のほかに、主ボタンが離れている動きが来たとき
 * （離したのを受け取れなかった）と、次に押されたとき。覚えている「つかんでいる」だけを信じて固まらないようにする。
 */
export interface DragResizeOptions {
  /** ドラッグ中のカーソル（つまみと同じ向き） */
  cursor: 'col-resize' | 'row-resize';
  /** つかんだとき（主ボタンだけ） */
  onStart?: (e: PointerEvent) => void;
  /** つかんでいる間の動き */
  onMove: (e: PointerEvent) => void;
  /** 離した・取り消された・捕捉が外れた。1 回のドラッグに 1 回だけ */
  onEnd?: () => void;
}

export function bindDragResize(handle: HTMLElement, opts: DragResizeOptions): void {
  /** つかんでいるポインタ。null ならつかんでいない */
  let active: number | null = null;

  const finish = () => {
    if (active === null) return;
    active = null;
    document.body.style.cursor = '';
    handle.classList.remove('resizing');
    opts.onEnd?.();
  };
  const end = (e: PointerEvent) => {
    if (e.pointerId === active) finish();
  };

  handle.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return;
    finish(); // 前のドラッグの終わりを受け取れていなかったら、ここで終える
    active = e.pointerId;
    handle.setPointerCapture(e.pointerId);
    document.body.style.cursor = opts.cursor;
    handle.classList.add('resizing');
    opts.onStart?.(e);
    e.preventDefault(); // 文字の選択を始めない
  });
  handle.addEventListener('pointermove', (e: PointerEvent) => {
    if (e.pointerId !== active) return;
    if ((e.buttons & 1) === 0) return finish(); // 主ボタンが離れている＝離したのを受け取れなかった
    opts.onMove(e);
  });
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('lostpointercapture', end);
}
