/**
 * デザインキャンバス — 設定パネル
 *
 * 選んでいるものに応じて、項目を書き換える欄を出す。
 * 何も選んでいない: 設計全体（題・説明）／画面: 名前・メモ・大きさ・背景／部品: 文字・見た目・移動・メモ・位置／付箋: 本文。
 * 入力は打つたびに文書へ入れる（同じ欄への連続の入力は履歴を 1 つにまとめる）。
 */
(function (global) {
  'use strict';

  const say = global.DesignI18n.t; // 言葉の表（i18n.js）

  // 見た目（variant）の選択肢。名前は言葉の表の variant.<部品>.<値>
  const VARIANTS = {
    header: ['back', 'plain'],
    heading: ['large', 'medium', 'small'],
    paragraph: ['main', 'muted'],
    button: ['primary', 'secondary', 'ghost', 'danger'],
    badge: ['muted', 'primary', 'success', 'warning', 'error'],
    modal: ['confirm', 'danger', 'info'],
    toast: ['success', 'warning', 'error', 'primary', 'muted'],
    chart: ['bar', 'line'],
  };
  // text 欄を持つ部品（部品ごとに中身の意味が違う。書式の 4 章）。欄の見出しは言葉の表の textLabel.<部品>
  const TEXT_KINDS = new Set([
    'sidebar',
    'tabs',
    'paragraph',
    'input',
    'textarea',
    'select',
    'list',
    'card',
    'table',
    'search',
    'stat',
    'menu',
    'modal',
    'tree',
    'chart',
  ]);
  const NO_LABEL = new Set([
    'tabs',
    'paragraph',
    'list',
    'box',
    'table',
    'divider',
    'progress',
    'search',
    'menu',
    'tree',
  ]);

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  const INPUT =
    'w-full bg-card border border-border-main rounded px-2 py-1 text-sm text-text-main focus:outline-none focus:border-primary';
  const BTN = 'px-2 py-1 rounded text-xs border border-border-main text-text-main hover:bg-hover';

  class DesignPanel {
    constructor(model, editor, root) {
      this.model = model;
      this.editor = editor;
      this.root = root;
      this.gap = 16; // 詰めて並べるときの間隔
      editor.onSelect(() => this.render());
      model.onChange((reason) => {
        // 打っている最中に作り直すと入力の位置が飛ぶので、パネルに入力の焦点があるあいだは作り直さない
        // （選択欄・数の欄は値が決まったときだけ書くので、作り直して新しい値で欄を出し直す）。
        // 作り直さないのは、いまの文書への変更（change）のときだけ。文書が入れ替わった・元に戻した ときは、
        // 欄の中身が古くなるので、打っている最中でも作り直す
        const a = document.activeElement;
        const typing =
          a && root.contains(a) && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type !== 'number'));
        if (reason === 'change' && typing && this._sameTarget()) return;
        this.render();
      });
      this.render();
    }
    _sameTarget() {
      return this._shown === this.editor.selection().join(',');
    }

    // ---------- 欄を作る道具 ----------
    section(title) {
      const s = el('div', 'flex flex-col gap-2 pb-3 mb-3 border-b border-border-main');
      if (title) s.appendChild(el('div', 'text-xs font-bold text-text-muted', title));
      this.body.appendChild(s);
      return s;
    }
    field(parent, label, input) {
      const f = el('label', 'flex flex-col gap-1');
      f.appendChild(el('span', 'text-xs text-text-muted', label));
      f.appendChild(input);
      parent.appendChild(f);
      return input;
    }
    text(parent, label, obj, key, { multiline = false, rows = 3, placeholder = '' } = {}) {
      const input = el(multiline ? 'textarea' : 'input', INPUT);
      if (multiline) input.rows = rows;
      input.value = obj[key] ?? '';
      input.placeholder = placeholder;
      input.addEventListener('input', () => this.set(obj.id, key, input.value));
      input.addEventListener('blur', () => this.model.endMerge());
      return this.field(parent, label, input);
    }
    number(parent, label, obj, key, { min = 0, max = 10000 } = {}) {
      const input = el('input', INPUT);
      input.type = 'number';
      input.step = String(DesignDoc.GRID);
      input.min = String(min);
      input.max = String(max);
      input.value = obj[key] ?? '';
      input.addEventListener('change', () => {
        const v = Number(input.value);
        if (Number.isFinite(v)) this.model.patch(obj.id, { [key]: v });
      });
      return this.field(parent, label, input);
    }
    choice(parent, label, value, options, onChange) {
      const sel = el('select', INPUT);
      for (const [v, name] of options) {
        const o = el('option', '', name);
        o.value = v;
        sel.appendChild(o);
      }
      sel.value = value ?? options[0][0];
      sel.addEventListener('change', () => onChange(sel.value));
      return this.field(parent, label, sel);
    }
    buttons(parent, list) {
      const row = el('div', 'flex flex-wrap gap-1');
      for (const [name, fn, danger] of list) {
        const b = el('button', danger ? BTN + ' text-error' : BTN, name);
        b.type = 'button';
        b.addEventListener('click', fn);
        row.appendChild(b);
      }
      parent.appendChild(row);
    }
    /** id の要素の key を書き換える。設計全体は id を持たないので '' で表す */
    set(id, key, value) {
      if (!id) {
        this.model.change((d) => {
          d[key] = value;
        }, `doc-${key}`);
        return;
      }
      this.model.patch(id, { [key]: value }, `edit-${id}-${key}`);
    }

    // ---------- 描く ----------
    render() {
      const ids = this.editor.selection();
      this._shown = ids.join(',');
      this.root.textContent = '';
      this.body = el('div', 'flex flex-col p-3 text-sm');
      this.root.appendChild(this.body);

      if (ids.length === 0) return this.renderDoc();
      if (ids.length > 1) return this.renderMany(ids);
      const t = DesignDoc.findAny(this.model.doc, ids[0]);
      if (!t) return this.renderDoc();
      if (t.type === 'screen') return this.renderScreen(t.obj);
      if (t.type === 'part') return this.renderPart(t.obj, t.screen);
      return this.renderNote(t.obj);
    }

    renderDoc() {
      const d = this.model.doc;
      const s = this.section(say('panel.doc'));
      this.text(s, say('panel.doc.title'), { id: '', title: d.title }, 'title');
      this.text(s, say('panel.doc.brief'), { id: '', brief: d.brief }, 'brief', { multiline: true, rows: 6 });
      const h = this.section(say('panel.help'));
      h.appendChild(el('div', 'text-xs text-text-muted leading-relaxed whitespace-pre-wrap', say('panel.help.body')));
    }

    renderMany(ids) {
      const s = this.section(say('panel.many', { n: ids.length }));
      this.buttons(s, [
        [say('act.duplicate'), () => this.editor.select(this.model.duplicate(ids))],
        [say('act.delete'), () => this.model.remove(ids), true],
      ]);
      const parts = ids.filter((id) => (DesignDoc.findAny(this.model.doc, id) || {}).type === 'part');
      if (parts.length >= 2) this.renderArrange(parts, false);
    }

    /** 整える。solo は部品 1 つで、画面の端と中央にそろえるとき */
    renderArrange(ids, solo) {
      const s = this.section(solo ? say('arrange.solo') : say('arrange.many', { n: ids.length }));
      const run = (op) => this.model.arrange(ids, op, this.gap);
      s.appendChild(el('div', 'text-xs text-text-muted', say('arrange.h')));
      this.buttons(s, [
        [say('arrange.left'), () => run('left')],
        [say('arrange.hcenter'), () => run('hcenter')],
        [say('arrange.right'), () => run('right')],
      ]);
      s.appendChild(el('div', 'text-xs text-text-muted', say('arrange.v')));
      this.buttons(s, [
        [say('arrange.top'), () => run('top')],
        [say('arrange.vcenter'), () => run('vcenter')],
        [say('arrange.bottom'), () => run('bottom')],
      ]);
      if (solo) return;
      s.appendChild(el('div', 'text-xs text-text-muted', say('arrange.line')));
      const many = ids.length >= 3;
      this.buttons(s, [
        [say('arrange.stackV'), () => run('stackV')],
        [say('arrange.stackH'), () => run('stackH')],
        ...(many
          ? [
              [say('arrange.distV'), () => run('distV')],
              [say('arrange.distH'), () => run('distH')],
            ]
          : []),
      ]);
      const gap = el('input', INPUT);
      gap.type = 'number';
      gap.step = String(DesignDoc.GRID);
      gap.min = '0';
      gap.value = String(this.gap);
      gap.addEventListener('change', () => {
        const v = Number(gap.value);
        if (Number.isFinite(v) && v >= 0) this.gap = v;
      });
      this.field(s, say('arrange.gap'), gap);
      if (!many) s.appendChild(el('div', 'text-xs text-text-muted', say('arrange.needThree')));
      s.appendChild(el('div', 'text-xs text-text-muted', say('arrange.perScreen')));
    }

    renderScreen(sc) {
      const s = this.section(say('screen.section'));
      this.text(s, say('screen.name'), sc, 'name');
      this.text(s, say('screen.note'), sc, 'note', { multiline: true, rows: 5 });
      const size =
        sc.w === DesignDoc.PHONE.w && sc.h === DesignDoc.PHONE.h
          ? 'phone'
          : sc.w === DesignDoc.DESKTOP.w && sc.h === DesignDoc.DESKTOP.h
            ? 'desktop'
            : 'custom';
      this.choice(
        s,
        say('screen.size'),
        size,
        [
          ['desktop', say('screen.size.desktop')],
          ['phone', say('screen.size.phone')],
          ['custom', say('screen.size.custom')],
        ],
        (v) => {
          if (v === 'desktop') this.model.patch(sc.id, { ...DesignDoc.DESKTOP });
          else if (v === 'phone') this.model.patch(sc.id, { ...DesignDoc.PHONE });
          else this.render();
        },
      );
      const row = el('div', 'grid grid-cols-2 gap-2');
      s.appendChild(row);
      this.number(row, say('field.w'), sc, 'w', { min: 160 });
      this.number(row, say('field.h'), sc, 'h', { min: 160 });
      this.choice(
        s,
        say('screen.bg'),
        sc.bg || 'app',
        DesignParts.COLORS.map((c) => [c, say(`color.${c}`)]),
        (v) => this.model.patch(sc.id, { bg: v }),
      );
      const incoming = DesignDoc.transitionsOf(this.model.doc).filter((t) => t.to === sc.id);
      const a = this.section(say('screen.incoming'));
      if (!incoming.length) a.appendChild(el('div', 'text-xs text-text-muted', say('screen.incoming.none')));
      for (const t of incoming)
        a.appendChild(
          el(
            'div',
            'text-xs text-text-main',
            say('screen.incoming.item', { screen: t.from.name, label: t.part.label || t.part.kind }),
          ),
        );
      const o = this.section('');
      this.buttons(o, [
        [say('act.preview'), () => global.DesignApp && global.DesignApp.preview(sc.id)],
        [say('act.duplicate'), () => this.editor.select(this.model.duplicate([sc.id]))],
        [say('act.delete'), () => this.model.remove([sc.id]), true],
      ]);
    }

    renderPart(p, sc) {
      const spec = DesignParts.SPEC[p.kind];
      const s = this.section(spec ? spec.name : say('part.unsupported', { kind: p.kind }));
      if (!NO_LABEL.has(p.kind))
        this.text(s, p.kind === 'iconButton' ? say('part.icon') : say('part.label'), p, 'label');
      if (TEXT_KINDS.has(p.kind)) this.text(s, say(`textLabel.${p.kind}`), p, 'text', { multiline: true, rows: 4 });
      if (VARIANTS[p.kind])
        this.choice(
          s,
          say('part.variant'),
          p.variant,
          VARIANTS[p.kind].map((v) => [v, say(`variant.${p.kind}.${v}`)]),
          (v) => this.model.patch(p.id, { variant: v }),
        );
      if (p.kind === 'checkbox' || p.kind === 'toggle') {
        this.choice(
          s,
          say('part.state'),
          p.checked ? 'on' : 'off',
          [
            ['on', say('part.state.on')],
            ['off', say('part.state.off')],
          ],
          (v) => this.model.patch(p.id, { checked: v === 'on' }),
        );
      }
      if (p.kind === 'progress') this.number(s, say('part.progress'), p, 'value', { max: 100 });
      this.choice(
        s,
        say('part.fill'),
        p.fill || '',
        [['', say('part.fill.default')], ...DesignParts.COLORS.map((c) => [c, say(`color.${c}`)])],
        (v) => this.model.patch(p.id, { fill: v || undefined }),
      );

      // 押したときの移動
      const m = this.section(say('nav.section'));
      const others = this.model.doc.screens.filter((x) => x.id !== sc.id);
      const to = p.to && p.to.screen ? p.to.screen : '';
      this.choice(
        m,
        say('nav.to'),
        to,
        [
          ['', say('nav.none')],
          [DesignDoc.BACK, say('nav.back')],
          ...others.map((x) => [x.id, x.name]),
          ...(to && to !== DesignDoc.BACK && !others.some((x) => x.id === to)
            ? [[to, say('nav.missing', { id: to })]]
            : []),
        ],
        (v) =>
          this.model.patch(p.id, {
            to: v ? { screen: v, transition: (p.to && p.to.transition) || 'slide' } : undefined,
          }),
      );
      if (to) {
        this.choice(
          m,
          say('nav.transition'),
          p.to.transition || 'none',
          DesignDoc.TRANSITIONS.map((v) => [v, say(`transition.${v}`)]),
          (v) => this.model.patch(p.id, { to: { ...p.to, transition: v } }),
        );
      }

      const n = this.section(say('part.note'));
      this.text(n, say('part.note.label'), p, 'note', { multiline: true, rows: 4 });

      const g = this.section(say('part.geometry'));
      const row = el('div', 'grid grid-cols-4 gap-2');
      g.appendChild(row);
      this.number(row, 'x', p, 'x');
      this.number(row, 'y', p, 'y');
      this.number(row, say('field.w'), p, 'w', { min: 4 });
      this.number(row, say('field.h'), p, 'h', { min: 4 });

      this.renderArrange([p.id], true);

      const o = this.section('');
      this.buttons(o, [
        [say('act.front'), () => this.model.reorder(p.id, 'front')],
        [say('act.back'), () => this.model.reorder(p.id, 'back')],
        [say('act.duplicate'), () => this.editor.select(this.model.duplicate([p.id]))],
        [say('act.delete'), () => this.model.remove([p.id]), true],
      ]);
    }

    renderNote(nt) {
      const s = this.section(say('note.section'));
      this.text(s, say('note.text'), nt, 'text', { multiline: true, rows: 8 });
      const o = this.section('');
      this.buttons(o, [
        [say('act.duplicate'), () => this.editor.select(this.model.duplicate([nt.id]))],
        [say('act.delete'), () => this.model.remove([nt.id]), true],
      ]);
    }
  }

  global.DesignPanel = DesignPanel;
})(window);
