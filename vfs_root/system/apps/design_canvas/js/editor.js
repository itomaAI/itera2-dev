/**
 * デザインキャンバス — キャンバスのエディタ
 *
 * 役割: 文書（DesignModel）をキャンバスに描き、選択・移動・大きさの変更・追加・削除・複製、
 * キャンバスの移動とズーム、移動の矢印を受け持つ。設定パネルは panel.js、保存は main.js。
 *
 * 座標: 画面と付箋はキャンバス（world）の座標、部品は画面の左上からの座標（書式の 3 章）。
 * 描き直しは文書が変わるたびに全体を作り直す（大きな設計での速さはまだ測っていない）。
 */
(function (global) {
  'use strict';

  const say = global.DesignI18n.t; // 言葉の表（i18n.js）

  const SVGNS = 'http://www.w3.org/2000/svg';
  const ZOOM_MIN = 0.1;
  const ZOOM_MAX = 3;
  const DRAG_THRESHOLD = 3; // px（画面の上で）。これより小さい動きはクリックとみなす

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  const isTyping = (t) =>
    t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);

  class DesignEditor {
    /**
     * @param {DesignModel} model
     * @param {HTMLElement} viewport キャンバスを置く要素（大きさは外で決める）
     */
    constructor(model, viewport) {
      this.model = model;
      this.viewport = viewport;
      this.view = { x: 80, y: 80, z: 0.5 };
      this.sel = new Set();
      this.selListeners = new Set();
      this.drag = null;

      viewport.classList.add('relative', 'overflow-hidden', 'select-none');
      viewport.style.touchAction = 'none';
      this.world = el('div', 'absolute left-0 top-0');
      this.world.style.transformOrigin = '0 0';
      viewport.appendChild(this.world);

      this.zoomLabel = el(
        'div',
        'absolute right-3 bottom-3 text-xs text-text-muted bg-panel/80 rounded px-2 py-1 pointer-events-none',
      );
      viewport.appendChild(this.zoomLabel);

      model.onChange(() => {
        // 消えた要素は選択から外す。知らせるのは選択が変わったときだけ —— 変わっていないのに知らせると、
        // パネルが欄を作り直して、打っている最中の欄から入力の焦点が外れる（1 文字ごとに入力が切れる）
        let dropped = false;
        for (const id of [...this.sel]) {
          if (DesignDoc.findAny(model.doc, id)) continue;
          this.sel.delete(id);
          dropped = true;
        }
        this.render();
        if (dropped) this.emitSelect();
      });

      viewport.addEventListener('pointerdown', (e) => this.onPointerDown(e));
      viewport.addEventListener('pointermove', (e) => this.onPointerMove(e));
      viewport.addEventListener('pointerup', (e) => this.onPointerUp(e));
      viewport.addEventListener('pointercancel', (e) => this.onPointerUp(e));
      viewport.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
      viewport.addEventListener('dragover', (e) => {
        if (e.dataTransfer.types.includes('application/x-design-kind')) e.preventDefault();
      });
      viewport.addEventListener('drop', (e) => this.onDrop(e));
      global.addEventListener('keydown', (e) => this.onKey(e));

      // 起動直後は CSS の適用でキャンバスの大きさが変わるので、利用者が触るまでは大きさに合わせて表示し直す
      this.autoFit = true;
      const stopAuto = () => (this.autoFit = false);
      viewport.addEventListener('pointerdown', stopAuto, true);
      viewport.addEventListener('wheel', stopAuto, true);
      if (global.ResizeObserver) {
        new ResizeObserver(() => {
          if (this.autoFit) this.fit();
        }).observe(viewport);
      }

      this.render();
    }

    // ---------- 選択 ----------
    onSelect(fn) {
      this.selListeners.add(fn);
      return () => this.selListeners.delete(fn);
    }
    emitSelect() {
      for (const fn of this.selListeners) fn([...this.sel]);
    }
    select(ids, { add = false } = {}) {
      if (!add) this.sel.clear();
      for (const id of ids) this.sel.add(id);
      this.render();
      this.emitSelect();
    }
    selection() {
      return [...this.sel];
    }
    /** 部品を足す先の画面: 選んでいる画面、選んでいる部品の画面、なければ先頭の画面 */
    targetScreen() {
      const doc = this.model.doc;
      for (const id of this.sel) {
        const t = DesignDoc.findAny(doc, id);
        if (t && t.screen) return t.screen;
      }
      return doc.screens[0] || null;
    }

    // ---------- 座標 ----------
    toWorld(clientX, clientY) {
      const r = this.viewport.getBoundingClientRect();
      return { x: (clientX - r.left - this.view.x) / this.view.z, y: (clientY - r.top - this.view.y) / this.view.z };
    }
    screenAt(wx, wy) {
      const list = this.model.doc.screens;
      for (let i = list.length - 1; i >= 0; i--) {
        const s = list[i];
        if (wx >= s.x && wx <= s.x + s.w && wy >= s.y && wy <= s.y + s.h) return s;
      }
      return null;
    }
    applyView() {
      const { x, y, z } = this.view;
      this.world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
      this.zoomLabel.textContent = `${Math.round(z * 100)}%`;
    }
    zoomAt(clientX, clientY, factor) {
      const r = this.viewport.getBoundingClientRect();
      const px = clientX - r.left;
      const py = clientY - r.top;
      const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.view.z * factor));
      this.view.x = px - ((px - this.view.x) * z) / this.view.z;
      this.view.y = py - ((py - this.view.y) * z) / this.view.z;
      this.view.z = z;
      this.applyView();
    }
    /** すべてが収まるように表示する */
    fit() {
      const doc = this.model.doc;
      const boxes = [...doc.screens, ...doc.notes];
      if (!boxes.length) return;
      const l = Math.min(...boxes.map((b) => b.x));
      const t = Math.min(...boxes.map((b) => b.y)) - 40; // 画面の名前の分
      const rgt = Math.max(...boxes.map((b) => b.x + b.w));
      const btm = Math.max(...boxes.map((b) => b.y + b.h));
      const vw = this.viewport.clientWidth || 800;
      const vh = this.viewport.clientHeight || 600;
      const pad = 48;
      const z = Math.max(ZOOM_MIN, Math.min(1, (vw - pad * 2) / (rgt - l), (vh - pad * 2) / (btm - t)));
      this.view = { z, x: (vw - (rgt - l) * z) / 2 - l * z, y: (vh - (btm - t) * z) / 2 - t * z };
      this.applyView();
    }
    /** 1 つの画面に寄る（プレビューから戻ったときなど） */
    focusScreen(id) {
      const s = this.model.screen(id);
      if (!s) return;
      const vw = this.viewport.clientWidth || 800;
      const vh = this.viewport.clientHeight || 600;
      const z = Math.max(ZOOM_MIN, Math.min(1, (vw - 96) / s.w, (vh - 96) / (s.h + 40)));
      this.view = { z, x: (vw - s.w * z) / 2 - s.x * z, y: (vh - s.h * z) / 2 - s.y * z + 20 * z };
      this.applyView();
    }

    // ---------- 描く ----------
    render() {
      const doc = this.model.doc;
      const w = this.world;
      w.textContent = '';

      for (const s of doc.screens) w.appendChild(this.renderScreen(s));
      for (const n of doc.notes) w.appendChild(this.renderNote(n));
      w.appendChild(this.renderArrows(doc));
      this.applyView();
    }

    renderScreen(s) {
      const selected = this.sel.has(s.id);
      const wrap = el('div', 'absolute');
      Object.assign(wrap.style, { left: `${s.x}px`, top: `${s.y}px`, width: `${s.w}px`, height: `${s.h}px` });

      // 画面の名前（ここをつかむと画面ごと動く）
      const title = el(
        'div',
        `absolute left-0 bottom-full mb-2 px-1 text-[20px] font-medium whitespace-nowrap cursor-move ${selected ? 'text-primary' : 'text-text-muted'}`,
        s.name || s.id,
      );
      title.dataset.id = s.id;
      title.dataset.role = 'move';
      wrap.appendChild(title);

      const body = el(
        'div',
        `absolute inset-0 overflow-hidden rounded-lg shadow-lg ${DesignParts.BG[s.bg] || 'bg-app'} ${selected ? 'ring-4 ring-primary' : 'ring-1 ring-border-main'}`,
      );
      body.dataset.id = s.id;
      body.dataset.role = 'screen';
      for (const p of s.parts) body.appendChild(this.renderPart(p));
      wrap.appendChild(body);

      if (selected && this.sel.size === 1) wrap.appendChild(this.handle(s.id));
      return wrap;
    }

    renderPart(p) {
      const selected = this.sel.has(p.id);
      const box = el(
        'div',
        `absolute ${selected ? 'outline outline-2 outline-primary' : 'hover:outline hover:outline-1 hover:outline-primary/50'}`,
      );
      Object.assign(box.style, {
        left: `${p.x}px`,
        top: `${p.y}px`,
        width: `${p.w}px`,
        height: `${p.h}px`,
        cursor: 'move',
      });
      box.dataset.id = p.id;
      box.dataset.role = 'move';
      const inner = DesignParts.render(p);
      inner.style.pointerEvents = 'none';
      box.appendChild(inner);
      // メモがある部品・戻る部品には小さな印を付ける
      const marks = [];
      if (p.note) marks.push('✎');
      if (p.to && p.to.screen === DesignDoc.BACK) marks.push('↩');
      if (marks.length) {
        const m = el(
          'div',
          'absolute -top-2 -right-2 px-1 rounded bg-warning text-text-inverted text-[10px] leading-4 pointer-events-none',
          marks.join(''),
        );
        box.appendChild(m);
      }
      if (selected && this.sel.size === 1) box.appendChild(this.handle(p.id));
      return box;
    }

    renderNote(n) {
      const selected = this.sel.has(n.id);
      const box = el(
        'div',
        `absolute rounded-md p-3 text-[15px] leading-relaxed whitespace-pre-wrap overflow-hidden shadow bg-warning/20 text-text-main ${selected ? 'ring-4 ring-primary' : 'ring-1 ring-warning/40'}`,
        n.text || say('note.empty'),
      );
      Object.assign(box.style, {
        left: `${n.x}px`,
        top: `${n.y}px`,
        width: `${n.w}px`,
        height: `${n.h}px`,
        cursor: 'move',
      });
      box.dataset.id = n.id;
      box.dataset.role = 'move';
      if (selected && this.sel.size === 1) box.appendChild(this.handle(n.id));
      return box;
    }

    /** 右下の大きさを変えるつまみ（ズームしても同じ大きさに見えるように逆に拡大する） */
    handle(id) {
      const h = el('div', 'absolute bg-primary border-2 border-card rounded-sm');
      const size = 10 / this.view.z;
      Object.assign(h.style, {
        width: `${size}px`,
        height: `${size}px`,
        right: `${-size / 2}px`,
        bottom: `${-size / 2}px`,
        cursor: 'nwse-resize',
      });
      h.dataset.id = id;
      h.dataset.role = 'resize';
      return h;
    }

    renderArrows(doc) {
      const svg = document.createElementNS(SVGNS, 'svg');
      svg.setAttribute('class', 'absolute left-0 top-0 overflow-visible pointer-events-none text-primary');
      svg.setAttribute('width', '1');
      svg.setAttribute('height', '1');
      const defs = document.createElementNS(SVGNS, 'defs');
      const marker = document.createElementNS(SVGNS, 'marker');
      marker.setAttribute('id', 'dc-arrow');
      marker.setAttribute('viewBox', '0 0 10 10');
      marker.setAttribute('refX', '9');
      marker.setAttribute('refY', '5');
      // 大きさは線の太さの倍数（線はズームに合わせて太くしているので、小さめにする）
      marker.setAttribute('markerWidth', '3.5');
      marker.setAttribute('markerHeight', '3.5');
      marker.setAttribute('orient', 'auto-start-reverse');
      const tip = document.createElementNS(SVGNS, 'path');
      tip.setAttribute('d', 'M0,0 L10,5 L0,10 z');
      tip.setAttribute('fill', 'currentColor');
      marker.appendChild(tip);
      defs.appendChild(marker);
      svg.appendChild(defs);

      for (const t of DesignDoc.transitionsOf(doc)) {
        if (t.to === DesignDoc.BACK) continue;
        const dest = doc.screens.find((s) => s.id === t.to);
        if (!dest) continue;
        const p = t.part;
        const sx = t.from.x + p.x + p.w / 2;
        const sy = t.from.y + p.y + p.h / 2;
        const toRight = dest.x >= t.from.x + t.from.w || dest.x + dest.w / 2 > sx;
        const x1 = toRight ? t.from.x + p.x + p.w : t.from.x + p.x;
        const x2 = toRight ? dest.x : dest.x + dest.w;
        const y2 = dest.y + Math.min(120, dest.h / 2);
        const bend = Math.max(80, Math.abs(x2 - x1) / 2) * (toRight ? 1 : -1);
        const path = document.createElementNS(SVGNS, 'path');
        path.setAttribute('d', `M${x1},${sy} C${x1 + bend},${sy} ${x2 - bend},${y2} ${x2},${y2}`);
        const hot = this.sel.has(p.id) || this.sel.has(t.from.id) || this.sel.has(dest.id);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', 'currentColor');
        path.setAttribute('opacity', hot ? '1' : '0.5');
        path.setAttribute('stroke-width', String((hot ? 4 : 2.5) / Math.max(this.view.z, 0.25)));
        path.setAttribute('marker-end', 'url(#dc-arrow)');
        svg.appendChild(path);
      }
      return svg;
    }

    // ---------- 操作 ----------
    onPointerDown(e) {
      if (e.button !== 0 && e.button !== 1) return;
      const target = e.target.closest('[data-role]');
      const role = target && this.viewport.contains(target) ? target.dataset.role : null;
      const id = target ? target.dataset.id : null;
      const start = { cx: e.clientX, cy: e.clientY, w: this.toWorld(e.clientX, e.clientY) };
      this.viewport.setPointerCapture(e.pointerId);

      if (e.button === 1 || !role) {
        this.drag = { kind: 'pan', start, view: { ...this.view }, moved: false, clear: e.button === 0 };
        return;
      }
      if (role === 'resize') {
        const t = DesignDoc.findAny(this.model.doc, id);
        this.drag = { kind: 'resize', id, start, w0: t.obj.w, h0: t.obj.h, merge: `resize-${Date.now()}` };
        return;
      }
      if (role === 'screen') {
        // 画面の中の何も無いところ: 押しただけなら画面を選ぶ、動かしたらキャンバスを動かす
        this.drag = { kind: 'pan', start, view: { ...this.view }, moved: false, selectOnClick: id, shift: e.shiftKey };
        return;
      }
      // role === 'move'
      if (e.shiftKey) {
        if (this.sel.has(id)) this.sel.delete(id);
        else this.sel.add(id);
        this.render();
        this.emitSelect();
        this.drag = null;
        return;
      }
      if (!this.sel.has(id)) this.select([id]);
      this.drag = {
        kind: 'move',
        ids: [...this.sel],
        start,
        applied: { x: 0, y: 0 },
        moved: false,
        merge: `move-${Date.now()}`,
      };
    }

    onPointerMove(e) {
      this._lastPointer = { x: e.clientX, y: e.clientY }; // maybeMoveAcross で使う
      const d = this.drag;
      if (!d) return;
      const dxs = e.clientX - d.start.cx;
      const dys = e.clientY - d.start.cy;
      if (!d.moved && Math.hypot(dxs, dys) < DRAG_THRESHOLD) return;
      d.moved = true;
      if (d.kind === 'pan') {
        this.view.x = d.view.x + dxs;
        this.view.y = d.view.y + dys;
        this.applyView();
        return;
      }
      const w = this.toWorld(e.clientX, e.clientY);
      const dx = w.x - d.start.w.x;
      const dy = w.y - d.start.w.y;
      if (d.kind === 'move') {
        const tx = DesignDoc.snap(dx);
        const ty = DesignDoc.snap(dy);
        if (tx === d.applied.x && ty === d.applied.y) return;
        this.model.moveBy(d.ids, tx - d.applied.x, ty - d.applied.y, d.merge);
        d.applied = { x: tx, y: ty };
      } else if (d.kind === 'resize') {
        const g = DesignDoc.GRID;
        this.model.patch(d.id, { w: Math.max(g * 4, d.w0 + dx), h: Math.max(g, d.h0 + dy) }, d.merge);
      }
    }

    onPointerUp(e) {
      const d = this.drag;
      this.drag = null;
      if (!d) return;
      try {
        this.viewport.releasePointerCapture(e.pointerId);
      } catch (_) {
        /* すでに離れている */
      }
      if (d.kind === 'pan' && !d.moved) {
        if (d.selectOnClick) this.select([d.selectOnClick], { add: d.shift });
        else if (d.clear) this.select([]);
        return;
      }
      if (d.kind === 'move' && d.moved && d.ids.length === 1) this.maybeMoveAcross(d.ids[0], d.merge);
      this.model.endMerge();
    }

    /** 部品を別の画面の上で離したら、その画面へ移す */
    maybeMoveAcross(id, merge) {
      const t = DesignDoc.findAny(this.model.doc, id);
      if (!t || t.type !== 'part') return;
      const cx = t.screen.x + t.obj.x + t.obj.w / 2;
      const cy = t.screen.y + t.obj.y + t.obj.h / 2;
      // 画面の内側に留めた位置ではなく、指の位置で判断したいので、ドラッグの終わりの位置を使う
      const last = this._lastPointer;
      const at = last ? this.toWorld(last.x, last.y) : { x: cx, y: cy };
      const dest = this.screenAt(at.x, at.y);
      if (!dest || dest.id === t.screen.id) return;
      this.model.movePartToScreen(id, dest.id, at.x - dest.x - t.obj.w / 2, at.y - dest.y - t.obj.h / 2, merge);
    }

    onWheel(e) {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        this.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
      } else {
        this.view.x -= e.deltaX;
        this.view.y -= e.deltaY;
        this.applyView();
      }
    }

    onDrop(e) {
      const kind = e.dataTransfer.getData('application/x-design-kind');
      if (!kind) return;
      e.preventDefault();
      const w = this.toWorld(e.clientX, e.clientY);
      const s = this.screenAt(w.x, w.y) || this.targetScreen();
      if (!s) return;
      const spec = DesignParts.SPEC[kind];
      const id = this.model.addPart(s.id, kind, {
        x: w.x - s.x - (spec ? spec.w / 2 : 0),
        y: w.y - s.y - (spec ? spec.h / 2 : 0),
      });
      if (id) this.select([id]);
    }

    /** パレットを押したとき: 選んでいる画面に足す（少しずつずらす） */
    addFromPalette(kind) {
      const s = this.targetScreen();
      if (!s) return null;
      const k = s.parts.length % 10;
      const id = this.model.addPart(s.id, kind, { x: 24 + k * 16, y: 72 + k * 16 });
      if (id) this.select([id]);
      return id;
    }

    onKey(e) {
      if (isTyping(e.target) || this.disabled) return;
      const mod = e.ctrlKey || e.metaKey;
      const ids = this.selection();
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.model.redo();
        else this.model.undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        this.model.redo();
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        if (ids.length) this.select(this.model.duplicate(ids));
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && ids.length) {
        e.preventDefault();
        this.model.remove(ids);
      } else if (e.key.startsWith('Arrow') && ids.length) {
        e.preventDefault();
        const step = DesignDoc.GRID * (e.shiftKey ? 4 : 1);
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        this.model.moveBy(ids, dx, dy);
      } else if (e.key === 'Escape') {
        this.select([]);
      } else if (mod && e.key === '0') {
        e.preventDefault();
        this.fit();
      }
    }
  }

  global.DesignEditor = DesignEditor;
})(window);
