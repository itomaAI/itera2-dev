/**
 * デザインキャンバス — 文書のモデル
 * 書式: 手引き design_canvas_format.md
 *
 * 役割: 設計ファイルの読み込みと検査、変更（元に戻す・やり直す付き）、遷移の一覧、AI 向けの要約。
 * 画面の描き方は知らない（editor.js の仕事）。
 * 変更はすべて change(fn) を通す。fn は文書の写しを直接書き換えてよい。
 */
(function (global) {
  'use strict';

  const say = global.DesignI18n.t; // 言葉の表（i18n.js）

  const FORMAT = 'itera-design/1';
  const DESKTOP = { w: 1280, h: 800 };
  const PHONE = { w: 390, h: 844 };
  const GRID = 4;
  const HISTORY_MAX = 100;
  const TRANSITIONS = ['none', 'slide', 'fade'];
  const BACK = 'back';

  const snap = (v) => Math.round((Number(v) || 0) / GRID) * GRID;
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

  function emptyDoc(title = '') {
    return {
      format: FORMAT,
      title,
      brief: '',
      screens: [
        {
          id: 's_1',
          name: say('doc.screenName', { n: 1 }),
          x: 0,
          y: 0,
          w: DESKTOP.w,
          h: DESKTOP.h,
          bg: 'app',
          note: '',
          parts: [],
        },
      ],
      notes: [],
    };
  }

  /**
   * 読んだ JSON を、エディタが扱える形にそろえる。知らない項目は残す（書式の 5 章）。
   * 直せない形なら Error を投げる。戻り値の warnings は直したことの一覧。
   */
  function normalize(raw) {
    if (!isObj(raw)) throw new Error(say('err.notObject'));
    if (!Array.isArray(raw.screens)) throw new Error(say('err.noScreens'));
    const doc = clone(raw);
    const warnings = [];
    if (doc.format !== FORMAT) {
      if (doc.format) warnings.push(say('warn.format', { found: doc.format, format: FORMAT }));
      doc.format = FORMAT;
    }
    if (typeof doc.title !== 'string') doc.title = '';
    if (typeof doc.brief !== 'string') doc.brief = '';
    if (!Array.isArray(doc.notes)) doc.notes = [];

    const seen = new Set();
    const uniq = (id, prefix) => {
      let v = typeof id === 'string' && id ? id : '';
      if (!v || seen.has(v)) {
        const old = v;
        v = newIdFrom(seen, prefix);
        warnings.push(old ? say('warn.dupId', { old, id: v }) : say('warn.noId', { id: v }));
      }
      seen.add(v);
      return v;
    };
    const num = (v, d) => (Number.isFinite(v) ? v : d);

    doc.screens = doc.screens.filter(isObj);
    doc.screens.forEach((s, i) => {
      s.id = uniq(s.id, 's_');
      if (typeof s.name !== 'string') s.name = say('doc.screenName', { n: i + 1 });
      s.x = num(s.x, i * (DESKTOP.w + 160));
      s.y = num(s.y, 0);
      if (!Number.isFinite(s.w) || s.w <= 0) s.w = DESKTOP.w;
      if (!Number.isFinite(s.h) || s.h <= 0) s.h = DESKTOP.h;
      if (!Array.isArray(s.parts)) s.parts = [];
      s.parts = s.parts.filter(isObj);
      s.parts.forEach((p) => {
        p.id = uniq(p.id, 'p_');
        if (typeof p.kind !== 'string') p.kind = 'box';
        p.x = num(p.x, 0);
        p.y = num(p.y, 0);
        p.w = num(p.w, 120);
        p.h = num(p.h, 40);
      });
    });
    doc.notes = doc.notes.filter(isObj);
    doc.notes.forEach((n) => {
      n.id = uniq(n.id, 'n_');
      n.x = num(n.x, 0);
      n.y = num(n.y, -240);
      n.w = num(n.w, 240);
      n.h = num(n.h, 160);
      if (typeof n.text !== 'string') n.text = '';
    });
    // 行き先の無い移動は消さずに知らせる（AI が後で画面を足すことがあるため）
    const ids = new Set(doc.screens.map((s) => s.id));
    for (const { from, part, to } of transitionsOf(doc)) {
      if (to !== BACK && !ids.has(to))
        warnings.push(say('warn.noTarget', { label: part.label || part.id, screen: from.name, to }));
    }
    return { doc, warnings };
  }

  function newIdFrom(seen, prefix) {
    let n = 1;
    while (seen.has(`${prefix}${n}`)) n++;
    return `${prefix}${n}`;
  }

  function allIds(doc) {
    const s = new Set();
    doc.screens.forEach((sc) => {
      s.add(sc.id);
      sc.parts.forEach((p) => s.add(p.id));
    });
    doc.notes.forEach((n) => s.add(n.id));
    return s;
  }

  /** 部品の移動の一覧: [{ from: 画面, part, to: 画面 id | 'back', transition }] */
  function transitionsOf(doc) {
    const out = [];
    for (const s of doc.screens) {
      for (const p of s.parts || []) {
        if (p.to && typeof p.to.screen === 'string' && p.to.screen) {
          out.push({ from: s, part: p, to: p.to.screen, transition: p.to.transition || 'none' });
        }
      }
    }
    return out;
  }

  /** AI に送る要約（書式の 6 章）。path は保存先、request は送り手が書いた依頼の文 */
  function summarize(doc, path, request) {
    const name = (id) => {
      if (id === BACK) return say('sum.back');
      const s = doc.screens.find((x) => x.id === id);
      return s ? say('sum.screenRef', { name: s.name, id: s.id }) : say('sum.missing', { id });
    };
    const oneLine = (t, max = 80) => {
      const v = String(t || '')
        .replace(/\s+/g, ' ')
        .trim();
      return v.length > max ? v.slice(0, max) + '…' : v;
    };
    const out = [];
    out.push(say('sum.head', { path }));
    out.push(
      say('sum.title', { title: doc.title || say('sum.untitled') }) +
        (doc.brief ? ' — ' + oneLine(doc.brief, 160) : ''),
    );
    out.push(say('sum.screens', { n: doc.screens.length }));
    for (const s of doc.screens) {
      const moves = s.parts
        .filter((p) => p.to && p.to.screen)
        .map((p) => say('sum.move', { label: p.label || p.kind, to: name(p.to.screen) }));
      const notes = s.parts.filter((p) => p.note).length;
      let line = say('sum.screen', { name: s.name, id: s.id, n: s.parts.length });
      if (notes) line += say('sum.withNotes', { n: notes });
      if (s.note) line += say('sum.sep') + oneLine(s.note);
      if (moves.length) line += say('sum.sep') + say('sum.moves', { list: moves.join(say('sum.comma')) });
      out.push(line);
    }
    if (doc.notes.length) out.push(say('sum.notes', { n: doc.notes.length }));
    if (request && request.trim()) {
      out.push('');
      out.push(request.trim());
    }
    return out.join('\n');
  }

  /** 文書と、その変更の履歴を持つ入れ物 */
  class DesignModel {
    constructor(doc) {
      this.doc = doc || emptyDoc();
      this.past = [];
      this.future = [];
      this.dirty = false;
      this.listeners = new Set();
    }
    onChange(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }
    emit(reason) {
      for (const fn of this.listeners) {
        try {
          fn(reason);
        } catch (e) {
          console.warn('[DesignModel] listener failed', e);
        }
      }
    }
    /** 文書を丸ごと入れ替える（開いた・外で書き換えられた）。履歴は消す */
    replace(doc, { dirty = false } = {}) {
      this.doc = doc;
      this.past = [];
      this.future = [];
      this.dirty = dirty;
      this.emit('replace');
    }
    /**
     * 変更する。fn(doc) が写しを書き換える。false を返したら何もしない。
     * merge に同じ文字列を続けて渡すと、履歴を 1 つにまとめる（ドラッグの途中など）
     */
    change(fn, merge) {
      const before = clone(this.doc);
      const next = clone(this.doc);
      if (fn(next) === false) return false;
      if (!(merge && this._lastMerge === merge)) {
        this.past.push(before);
        if (this.past.length > HISTORY_MAX) this.past.shift();
      }
      this._lastMerge = merge || null;
      this.future = [];
      this.doc = next;
      this.dirty = true;
      this.emit('change');
      return true;
    }
    /** ドラッグなどの一続きの変更が終わったら呼ぶ（次の変更を別の履歴にする） */
    endMerge() {
      this._lastMerge = null;
    }
    undo() {
      if (!this.past.length) return false;
      this.future.push(clone(this.doc));
      this.doc = this.past.pop();
      this._lastMerge = null;
      this.dirty = true;
      this.emit('undo');
      return true;
    }
    redo() {
      if (!this.future.length) return false;
      this.past.push(clone(this.doc));
      this.doc = this.future.pop();
      this._lastMerge = null;
      this.dirty = true;
      this.emit('redo');
      return true;
    }
    markSaved() {
      this.dirty = false;
      this.emit('saved');
    }

    // ---- 探す ----
    screen(id) {
      return this.doc.screens.find((s) => s.id === id) || null;
    }
    /** 部品と、それが入っている画面 */
    findPart(id) {
      for (const s of this.doc.screens) {
        const p = s.parts.find((x) => x.id === id);
        if (p) return { screen: s, part: p };
      }
      return null;
    }
    note(id) {
      return this.doc.notes.find((n) => n.id === id) || null;
    }
    newId(prefix, doc = this.doc) {
      return newIdFrom(allIds(doc), prefix);
    }

    // ---- 変える（どれも 1 つの履歴になる。戻り値は新しい要素の id） ----
    addScreen(opts = {}) {
      let id = null;
      this.change((d) => {
        id = this.newId('s_', d);
        const size = opts.phone ? PHONE : DESKTOP;
        const right = d.screens.reduce((m, s) => Math.max(m, s.x + s.w), -160);
        d.screens.push({
          id,
          name: opts.name || say('doc.screenName', { n: d.screens.length + 1 }),
          x: snap(opts.x ?? right + 160),
          y: snap(opts.y ?? 0),
          w: size.w,
          h: size.h,
          bg: 'app',
          note: '',
          parts: [],
        });
      });
      return id;
    }
    addPart(screenId, kind, at = {}) {
      let id = null;
      this.change((d) => {
        const s = d.screens.find((x) => x.id === screenId);
        if (!s) return false;
        const part = global.DesignParts.create(kind);
        id = this.newId('p_', d);
        part.id = id;
        part.w = Math.min(part.w, s.w);
        part.h = Math.min(part.h, s.h);
        part.x = snap(clampN(at.x ?? 24, 0, s.w - part.w));
        part.y = snap(clampN(at.y ?? 24, 0, s.h - part.h));
        s.parts.push(part);
      });
      return id;
    }
    addNote(at = {}) {
      let id = null;
      this.change((d) => {
        id = this.newId('n_', d);
        d.notes.push({ id, x: snap(at.x ?? 0), y: snap(at.y ?? -240), w: 240, h: 160, text: '' });
      });
      return id;
    }
    /** 部品・画面・付箋のどれでも、id で項目を書き換える。値が undefined の項目は消す */
    patch(id, values, merge) {
      return this.change((d) => {
        const t = findAny(d, id);
        if (!t) return false;
        for (const [k, v] of Object.entries(values)) {
          if (k === 'id') continue;
          if (v === undefined) delete t.obj[k];
          else t.obj[k] = ['x', 'y', 'w', 'h'].includes(k) ? snap(v) : v;
        }
        if (t.type === 'part') fitInside(t.obj, t.screen);
      }, merge);
    }
    /** 複数の要素を同じだけ動かす（ドラッグ）。部品は画面の内側に留める */
    moveBy(ids, dx, dy, merge) {
      return this.change((d) => {
        for (const id of ids) {
          const t = findAny(d, id);
          if (!t) continue;
          t.obj.x = snap(t.obj.x + dx);
          t.obj.y = snap(t.obj.y + dy);
          if (t.type === 'part') fitInside(t.obj, t.screen);
        }
      }, merge);
    }
    remove(ids) {
      const set = new Set(ids);
      return this.change((d) => {
        const removedScreens = new Set(d.screens.filter((s) => set.has(s.id)).map((s) => s.id));
        d.screens = d.screens.filter((s) => !set.has(s.id));
        d.screens.forEach((s) => (s.parts = s.parts.filter((p) => !set.has(p.id))));
        d.notes = d.notes.filter((n) => !set.has(n.id));
        // 消した画面へ向かう移動も外す（行き先の無い矢印を残さない）
        d.screens.forEach((s) =>
          s.parts.forEach((p) => {
            if (p.to && removedScreens.has(p.to.screen)) delete p.to;
          }),
        );
      });
    }
    /** 複製する。部品は同じ画面に少しずらして、画面は右隣に置く。戻り値は新しい id の一覧 */
    duplicate(ids) {
      const made = [];
      this.change((d) => {
        for (const id of ids) {
          const t = findAny(d, id);
          if (!t) continue;
          const copy = clone(t.obj);
          if (t.type === 'screen') {
            copy.id = this.newId('s_', d);
            copy.name = say('doc.copyName', { name: t.obj.name });
            copy.x = snap(t.obj.x + t.obj.w + 160);
            d.screens.push(copy); // 先に入れて、部品の id の採番に数える
            copy.parts.forEach((p) => (p.id = this.newId('p_', d)));
          } else if (t.type === 'part') {
            copy.id = this.newId('p_', d);
            copy.x += 16;
            copy.y += 16;
            fitInside(copy, t.screen);
            t.screen.parts.push(copy);
          } else {
            copy.id = this.newId('n_', d);
            copy.x += 16;
            copy.y += 16;
            d.notes.push(copy);
          }
          made.push(copy.id);
        }
        if (!made.length) return false;
      });
      return made;
    }
    /** 重なりの順を変える（部品だけ。'front' か 'back'） */
    reorder(id, where) {
      return this.change((d) => {
        const t = findAny(d, id);
        if (!t || t.type !== 'part') return false;
        const arr = t.screen.parts;
        arr.splice(arr.indexOf(t.obj), 1);
        if (where === 'back') arr.unshift(t.obj);
        else arr.push(t.obj);
      });
    }
    /**
     * 整える。部品だけが対象で、画面ごとに別々に扱う（座標が画面の中のものなので）。
     * 1 つの画面で選んでいる部品が 1 つなら、その画面の端と中央にそろえる。2 つ以上なら、選んだ部品を囲む枠にそろえる。
     * op: left / hcenter / right / top / vcenter / bottom … そろえる
     *     distH / distV … 横・縦に等しい間隔で並べる（3 つ以上のとき。両端の部品は動かさない）
     *     stackV / stackH … 上から・左から順に gap の間隔で詰めて並べる（2 つ以上のとき。先頭の部品は動かさない）
     */
    arrange(ids, op, gap = 16) {
      return this.change((d) => {
        const groups = new Map();
        for (const id of ids) {
          const t = findAny(d, id);
          if (!t || t.type !== 'part') continue;
          if (!groups.has(t.screen)) groups.set(t.screen, []);
          groups.get(t.screen).push(t.obj);
        }
        let changed = false;
        for (const [sc, ps] of groups) {
          const n = ps.length;
          const solo = n === 1;
          const L = solo ? 0 : Math.min(...ps.map((p) => p.x));
          const R = solo ? sc.w : Math.max(...ps.map((p) => p.x + p.w));
          const T = solo ? 0 : Math.min(...ps.map((p) => p.y));
          const B = solo ? sc.h : Math.max(...ps.map((p) => p.y + p.h));
          const byX = [...ps].sort((a, b) => a.x - b.x);
          const byY = [...ps].sort((a, b) => a.y - b.y);
          if (op === 'left') ps.forEach((p) => (p.x = L));
          else if (op === 'hcenter') ps.forEach((p) => (p.x = (L + R - p.w) / 2));
          else if (op === 'right') ps.forEach((p) => (p.x = R - p.w));
          else if (op === 'top') ps.forEach((p) => (p.y = T));
          else if (op === 'vcenter') ps.forEach((p) => (p.y = (T + B - p.h) / 2));
          else if (op === 'bottom') ps.forEach((p) => (p.y = B - p.h));
          else if (op === 'distH' && n >= 3) {
            const space = (R - L - ps.reduce((s, p) => s + p.w, 0)) / (n - 1);
            let x = L;
            byX.forEach((p) => {
              p.x = x;
              x += p.w + space;
            });
          } else if (op === 'distV' && n >= 3) {
            const space = (B - T - ps.reduce((s, p) => s + p.h, 0)) / (n - 1);
            let y = T;
            byY.forEach((p) => {
              p.y = y;
              y += p.h + space;
            });
          } else if (op === 'stackV' && n >= 2) {
            let y = byY[0].y;
            byY.forEach((p) => {
              p.y = y;
              y += p.h + gap;
            });
          } else if (op === 'stackH' && n >= 2) {
            let x = byX[0].x;
            byX.forEach((p) => {
              p.x = x;
              x += p.w + gap;
            });
          } else continue;
          ps.forEach((p) => {
            p.x = snap(p.x);
            p.y = snap(p.y);
            fitInside(p, sc);
          });
          changed = true;
        }
        if (!changed) return false;
      });
    }
    /** 部品を別の画面へ移す（ドラッグで画面をまたいだとき）。x・y は移り先の画面の中の座標 */
    movePartToScreen(partId, screenId, x, y, merge) {
      return this.change((d) => {
        const t = findAny(d, partId);
        const s = d.screens.find((v) => v.id === screenId);
        if (!t || t.type !== 'part' || !s || t.screen === s) return false;
        t.screen.parts.splice(t.screen.parts.indexOf(t.obj), 1);
        t.obj.x = snap(x);
        t.obj.y = snap(y);
        fitInside(t.obj, s);
        s.parts.push(t.obj);
      }, merge);
    }
  }

  function clampN(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }
  function fitInside(part, screen) {
    part.w = clampN(part.w, GRID, screen.w);
    part.h = clampN(part.h, GRID, screen.h);
    part.x = clampN(part.x, 0, screen.w - part.w);
    part.y = clampN(part.y, 0, screen.h - part.h);
  }
  /** id から { type: 'screen'|'part'|'note', obj, screen } を探す */
  function findAny(doc, id) {
    for (const s of doc.screens) {
      if (s.id === id) return { type: 'screen', obj: s, screen: s };
      const p = s.parts.find((x) => x.id === id);
      if (p) return { type: 'part', obj: p, screen: s };
    }
    const n = doc.notes.find((x) => x.id === id);
    return n ? { type: 'note', obj: n, screen: null } : null;
  }

  global.DesignModel = DesignModel;
  global.DesignDoc = {
    FORMAT,
    DESKTOP,
    PHONE,
    GRID,
    TRANSITIONS,
    BACK,
    snap,
    emptyDoc,
    normalize,
    transitionsOf,
    summarize,
    findAny,
  };
})(window);
