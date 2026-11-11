/**
 * デザインキャンバス — 画面を PNG にする
 *
 * 画面を実寸（1px = 1px）で窓の全面に描き、MetaOS.system.capture()（自分の窓の PNG を base64 で返す）で撮る。
 * 画面が窓より大きいときは、ずらしながら何枚かに分けて撮り、1 枚の canvas につなぐ。
 * 撮っているあいだは窓の全面を覆うので、利用者には一瞬だけ画面が切り替わって見える。
 */
(function (global) {
  'use strict';

  const say = global.DesignI18n.t; // 言葉の表（i18n.js）

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 窓が見えていないとき（裏にある・画面の外）は requestAnimationFrame が呼ばれないことがあるので、時間でも抜ける
  const frame = () =>
    new Promise((r) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          r();
        }
      };
      requestAnimationFrame(finish);
      setTimeout(finish, 50);
    });

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(say('err.imageLoad')));
      img.src = src;
    });
  }

  /** 画面を実寸の要素にする（プレビューと同じ描き方。押す処理は付けない） */
  function buildPage(sc) {
    const page = document.createElement('div');
    page.className = `overflow-hidden ${DesignParts.BG[sc.bg] || 'bg-app'}`;
    Object.assign(page.style, { position: 'absolute', left: '0', top: '0', width: `${sc.w}px`, height: `${sc.h}px` });
    for (const p of sc.parts) {
      const box = document.createElement('div');
      Object.assign(box.style, {
        position: 'absolute',
        left: `${p.x}px`,
        top: `${p.y}px`,
        width: `${p.w}px`,
        height: `${p.h}px`,
      });
      box.appendChild(DesignParts.render(p));
      page.appendChild(box);
    }
    return page;
  }

  /**
   * 1 枚の画面を PNG にする。
   * @returns {Promise<Uint8Array>} PNG のバイト列
   */
  async function screenToPng(sc) {
    const cover = document.createElement('div');
    Object.assign(cover.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      right: '0',
      bottom: '0',
      zIndex: '100',
      overflow: 'hidden',
    });
    cover.className = 'bg-app';
    const page = buildPage(sc);
    cover.appendChild(page);
    document.body.appendChild(cover);
    try {
      // Tailwind の CDN が新しいクラスを用意するのを待つ
      await frame();
      await frame();
      await sleep(150);

      const vw = cover.clientWidth;
      const vh = cover.clientHeight;
      const canvas = document.createElement('canvas');
      canvas.width = sc.w;
      canvas.height = sc.h;
      const ctx = canvas.getContext('2d');

      for (let ty = 0; ty < sc.h; ty += vh) {
        for (let tx = 0; tx < sc.w; tx += vw) {
          page.style.transform = `translate(${-tx}px, ${-ty}px)`;
          await frame();
          await sleep(60);
          const b64 = await MetaOS.system.capture();
          const img = await loadImage(`data:image/png;base64,${b64}`);
          // 撮った画像は窓の大きさと同じとは限らない（画面の拡大率）。比で直す
          const rx = img.naturalWidth / global.innerWidth;
          const ry = img.naturalHeight / global.innerHeight;
          const w = Math.min(vw, sc.w - tx);
          const h = Math.min(vh, sc.h - ty);
          ctx.drawImage(img, 0, 0, w * rx, h * ry, tx, ty, w, h);
        }
      }
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      return new Uint8Array(await blob.arrayBuffer());
    } finally {
      cover.remove();
    }
  }

  /**
   * 設計のすべての画面を PNG にして、dir に「画面の id.png」で書く。
   * @returns {Promise<Array<{screen, path}>>}
   */
  async function writeAll(doc, dir, onProgress) {
    const out = [];
    let i = 0;
    for (const sc of doc.screens) {
      i++;
      if (onProgress) onProgress(i, doc.screens.length, sc);
      const bytes = await screenToPng(sc);
      const path = `${dir}/${sc.id}.png`;
      await MetaOS.fs.write(path, bytes, { overwrite: true });
      out.push({ screen: sc, path });
    }
    return out;
  }

  global.DesignSnapshot = { screenToPng, writeAll };
})(window);
