/**
 * デザインキャンバス — プレビュー
 *
 * 1 枚の画面を全面に表示する。移動を付けた部品を押すと、その画面へ移る（「戻る」は一つ前へ）。
 * 編集はしない。閉じると、最後に見ていた画面をエディタで表示する。
 */
(function (global) {
  'use strict';

  const say = global.DesignI18n.t; // 言葉の表（i18n.js）

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  class DesignPreview {
    constructor(model, { onClose } = {}) {
      this.model = model;
      this.onClose = onClose;
      this.stack = [];
      this.root = null;
      this.onKey = (e) => {
        if (e.key === 'Escape') this.close();
        else if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowLeft')) {
          e.preventDefault();
          this.back();
        }
      };
      this.onResize = () => this.fitStage();
    }

    open(screenId) {
      const first = this.model.screen(screenId) || this.model.doc.screens[0];
      if (!first) return;
      this.stack = [first.id];
      this.root = el('div', 'fixed inset-0 z-50 flex flex-col bg-overlay/90');
      const bar = el('div', 'flex items-center gap-3 px-4 py-2 bg-panel border-b border-border-main text-sm shrink-0');
      this.backBtn = el(
        'button',
        'px-2 py-1 rounded border border-border-main text-text-main hover:bg-hover disabled:opacity-40',
        say('preview.back'),
      );
      this.backBtn.addEventListener('click', () => this.back());
      this.title = el('div', 'font-bold text-text-main');
      this.noteLine = el('div', 'flex-1 text-xs text-text-muted truncate');
      const close = el('button', 'px-3 py-1 rounded bg-primary text-text-inverted', say('preview.close'));
      close.addEventListener('click', () => this.close());
      bar.append(this.backBtn, this.title, this.noteLine, close);
      this.stage = el('div', 'flex-1 relative overflow-hidden');
      // 後から作る要素の配置は、Tailwind の CDN がクラスを用意するより先に測られることがあるので、直に書く
      Object.assign(this.root.style, {
        position: 'fixed',
        inset: '0',
        zIndex: '50',
        display: 'flex',
        flexDirection: 'column',
      });
      Object.assign(this.stage.style, { flex: '1 1 auto', minHeight: '0', position: 'relative', overflow: 'hidden' });
      this.root.append(bar, this.stage);
      document.body.appendChild(this.root);
      if (global.ResizeObserver) {
        this.ro = new ResizeObserver(() => this.fitStage());
        this.ro.observe(this.stage);
      }
      global.addEventListener('keydown', this.onKey, true);
      global.addEventListener('resize', this.onResize);
      this.show(first.id, 'none', false);
    }

    close() {
      if (!this.root) return;
      const last = this.stack[this.stack.length - 1];
      global.removeEventListener('keydown', this.onKey, true);
      global.removeEventListener('resize', this.onResize);
      if (this.ro) this.ro.disconnect();
      this.ro = null;
      this.page = null;
      this.root.remove();
      this.root = null;
      if (this.onClose) this.onClose(last);
    }

    back() {
      if (this.stack.length < 2) return;
      this.stack.pop();
      this.show(this.stack[this.stack.length - 1], this.lastTransition || 'slide', true);
    }

    go(to) {
      if (to.screen === DesignDoc.BACK) return this.back();
      if (!this.model.screen(to.screen)) return;
      this.stack.push(to.screen);
      this.lastTransition = to.transition || 'none';
      this.show(to.screen, this.lastTransition, false);
    }

    /** 画面を作る（実寸。ステージに合わせた縮小は fitStage） */
    build(sc) {
      const page = el('div', `absolute overflow-hidden rounded-lg shadow-2xl ${DesignParts.BG[sc.bg] || 'bg-app'}`);
      Object.assign(page.style, { width: `${sc.w}px`, height: `${sc.h}px`, transformOrigin: '0 0' });
      for (const p of sc.parts) {
        const box = el('div', 'absolute');
        Object.assign(box.style, { left: `${p.x}px`, top: `${p.y}px`, width: `${p.w}px`, height: `${p.h}px` });
        const inner = DesignParts.render(p);
        inner.style.pointerEvents = 'none';
        box.appendChild(inner);
        if (p.to && p.to.screen) {
          box.style.cursor = 'pointer';
          box.title = p.note || '';
          box.classList.add('hover:brightness-110', 'active:scale-[0.98]', 'transition');
          box.addEventListener('click', () => this.go(p.to));
        }
        page.appendChild(box);
      }
      return page;
    }

    show(id, transition, reverse) {
      const sc = this.model.screen(id);
      if (!sc) return;
      this.title.textContent = sc.name;
      this.noteLine.textContent = sc.note || '';
      this.backBtn.disabled = this.stack.length < 2;
      const next = this.build(sc);
      const prev = this.page;
      this.page = next;
      this.stage.appendChild(next);
      this.fitStage();
      if (!prev) return;
      if (transition === 'none') {
        prev.remove();
        return;
      }
      // 移り方: slide は右から（戻るときは左から）入る。fade は重ねて溶かす
      const dir = reverse ? -1 : 1;
      const dur = 260;
      // アニメーションが進まない環境（裏に回った窓など）でも前の画面が残らないように、時間で片付ける
      setTimeout(() => {
        for (const a of next.getAnimations()) a.finish();
        prev.remove();
      }, dur + 80);
      const base = next.style.transform;
      if (transition === 'slide') {
        const w = this.stage.clientWidth;
        next.animate([{ transform: `translateX(${dir * w}px) ${base}` }, { transform: base }], {
          duration: dur,
          easing: 'cubic-bezier(.2,.8,.2,1)',
        });
        prev.animate(
          [
            { transform: prev.style.transform },
            { transform: `translateX(${-dir * w * 0.3}px) ${prev.style.transform}`, opacity: 0.4 },
          ],
          {
            duration: dur,
            easing: 'cubic-bezier(.2,.8,.2,1)',
          },
        ).onfinish = () => prev.remove();
      } else {
        next.animate([{ opacity: 0 }, { opacity: 1 }], { duration: dur });
        prev.animate([{ opacity: 1 }, { opacity: 0 }], { duration: dur }).onfinish = () => prev.remove();
      }
    }

    /** いまの画面をステージの中央に、はみ出さない大きさで置く */
    fitStage() {
      if (!this.page || !this.stage) return;
      const sc = this.model.screen(this.stack[this.stack.length - 1]);
      if (!sc) return;
      const pad = 24;
      const sw = this.stage.clientWidth - pad * 2;
      const sh = this.stage.clientHeight - pad * 2;
      if (sw <= 0 || sh <= 0) return; // まだ配置が決まっていない（ResizeObserver がもう一度呼ぶ）
      const z = Math.min(1, sw / sc.w, sh / sc.h);
      const x = (this.stage.clientWidth - sc.w * z) / 2;
      const y = (this.stage.clientHeight - sc.h * z) / 2;
      this.page.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
    }
  }

  global.DesignPreview = DesignPreview;
})(window);
