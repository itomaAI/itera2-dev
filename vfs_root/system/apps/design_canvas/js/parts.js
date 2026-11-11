/**
 * デザインキャンバス — 部品のカタログ
 * 書式: 手引き design_canvas_format.md の 4 章
 *
 * 各部品は { name, w, h, defaults, render(part) } を持つ（name と、置いたときの文字は i18n.js の kind.<部品>.*）。
 * render は部品の大きさいっぱいに広がる要素を返す（位置と大きさはエディタが外側の枠で決める）。
 * 色は ui.js の色の名前（Tailwind の bg-app などのクラス）で描くので、テーマに合わせて変わる。
 * 利用者の文字は textContent で入れる（HTML として解釈しない）。
 */
(function (global) {
  'use strict';

  const say = global.DesignI18n.t; // 言葉の表（i18n.js）

  const COLORS = ['app', 'panel', 'card', 'hover', 'primary', 'success', 'warning', 'error'];
  const BG = {
    app: 'bg-app',
    panel: 'bg-panel',
    card: 'bg-card',
    hover: 'bg-hover',
    primary: 'bg-primary',
    success: 'bg-success',
    warning: 'bg-warning',
    error: 'bg-error',
  };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  const lines = (s) =>
    String(s || '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  const FILL = 'w-full h-full overflow-hidden';

  // 見出しのある入力系の部品の外枠（見出し＋中身）
  function labeled(part, inner) {
    const root = el('div', `${FILL} flex flex-col gap-1`);
    if (part.label) root.appendChild(el('div', 'text-xs text-text-muted truncate', part.label));
    inner.classList.add('flex-1', 'min-h-0');
    root.appendChild(inner);
    return root;
  }

  const SPEC = {
    header: {
      w: 1280,
      h: 56,
      defaults: { variant: 'back' },
      render(p) {
        const root = el('div', `${FILL} flex items-center gap-3 px-4 border-b border-border-main bg-panel`);
        if (p.variant !== 'plain') root.appendChild(el('span', 'text-text-muted text-lg', '←'));
        root.appendChild(el('span', 'text-lg font-bold text-text-main truncate', p.label || ''));
        return root;
      },
    },
    sidebar: {
      w: 220,
      h: 744,
      defaults: {},
      render(p) {
        const root = el('div', `${FILL} flex flex-col gap-1 p-3 bg-panel border-r border-border-main`);
        if (p.label) root.appendChild(el('div', 'text-xs font-bold text-text-muted px-2 py-1', p.label));
        lines(p.text).forEach((t, i) => {
          root.appendChild(
            el(
              'div',
              `px-2 py-1.5 rounded text-sm truncate ${i === 0 ? 'bg-hover text-text-main' : 'text-text-muted'}`,
              t,
            ),
          );
        });
        return root;
      },
    },
    tabs: {
      w: 360,
      h: 40,
      defaults: {},
      render(p) {
        const root = el('div', `${FILL} flex items-end gap-4 border-b border-border-main`);
        lines(p.text).forEach((t, i) => {
          root.appendChild(
            el(
              'div',
              `pb-2 text-sm whitespace-nowrap ${i === 0 ? 'text-primary border-b-2 border-primary font-bold' : 'text-text-muted'}`,
              t,
            ),
          );
        });
        return root;
      },
    },
    heading: {
      w: 320,
      h: 36,
      defaults: { variant: 'medium' },
      render(p) {
        const size = { large: 'text-3xl', medium: 'text-2xl', small: 'text-lg' }[p.variant] || 'text-2xl';
        return el('div', `${FILL} ${size} font-bold tracking-tight text-text-main flex items-center`, p.label || '');
      },
    },
    paragraph: {
      w: 400,
      h: 64,
      defaults: {},
      render(p) {
        const tone = p.variant === 'muted' ? 'text-text-muted' : 'text-text-main';
        return el('div', `${FILL} text-sm leading-relaxed whitespace-pre-wrap ${tone}`, p.text || '');
      },
    },
    button: {
      w: 120,
      h: 36,
      defaults: { variant: 'primary' },
      render(p) {
        const look =
          {
            primary: 'bg-primary text-text-inverted',
            secondary: 'bg-card text-text-main border border-border-main',
            ghost: 'text-text-main',
            danger: 'bg-error text-text-inverted',
          }[p.variant] || 'bg-primary text-text-inverted';
        return el(
          'div',
          `${FILL} rounded-lg flex items-center justify-center text-sm font-medium px-3 truncate ${look}`,
          p.label || '',
        );
      },
    },
    iconButton: {
      w: 36,
      h: 36,
      defaults: { label: '⚙' },
      render(p) {
        return el(
          'div',
          `${FILL} rounded-full flex items-center justify-center text-text-muted hover:bg-hover`,
          p.label || say('kind.iconButton.empty'),
        );
      },
    },
    input: {
      w: 280,
      h: 56,
      defaults: {},
      render(p) {
        const box = el(
          'div',
          'w-full rounded-lg border border-border-main bg-card px-3 flex items-center text-sm text-text-muted truncate',
          p.text || '',
        );
        return labeled(p, box);
      },
    },
    textarea: {
      w: 400,
      h: 120,
      defaults: {},
      render(p) {
        const box = el(
          'div',
          'w-full rounded-lg border border-border-main bg-card px-3 py-2 text-sm text-text-muted whitespace-pre-wrap overflow-hidden',
          p.text || '',
        );
        return labeled(p, box);
      },
    },
    select: {
      w: 200,
      h: 56,
      defaults: {},
      render(p) {
        const box = el(
          'div',
          'w-full rounded-lg border border-border-main bg-card px-3 flex items-center justify-between text-sm text-text-main',
        );
        box.appendChild(el('span', 'truncate', lines(p.text)[0] || ''));
        box.appendChild(el('span', 'text-text-muted', '▾'));
        return labeled(p, box);
      },
    },
    checkbox: {
      w: 160,
      h: 24,
      defaults: { checked: false },
      render(p) {
        const root = el('div', `${FILL} flex items-center gap-2 text-sm text-text-main`);
        root.appendChild(
          el(
            'span',
            `w-4 h-4 shrink-0 rounded border flex items-center justify-center text-[10px] ${p.checked ? 'bg-primary border-primary text-text-inverted' : 'border-border-main bg-card'}`,
            p.checked ? '✓' : '',
          ),
        );
        root.appendChild(el('span', 'truncate', p.label || ''));
        return root;
      },
    },
    toggle: {
      w: 180,
      h: 24,
      defaults: { checked: true },
      render(p) {
        const root = el('div', `${FILL} flex items-center justify-between gap-2 text-sm text-text-main`);
        root.appendChild(el('span', 'truncate', p.label || ''));
        const track = el('span', `w-9 h-5 shrink-0 rounded-full relative ${p.checked ? 'bg-primary' : 'bg-hover'}`);
        const knob = el('span', 'absolute top-0.5 w-4 h-4 rounded-full bg-card shadow');
        knob.style.left = p.checked ? '18px' : '2px';
        track.appendChild(knob);
        root.appendChild(track);
        return root;
      },
    },
    list: {
      w: 480,
      h: 160,
      defaults: {},
      render(p) {
        const root = el(
          'div',
          `${FILL} flex flex-col rounded-lg border border-border-main bg-panel divide-y divide-border-main`,
        );
        lines(p.text).forEach((t) => root.appendChild(el('div', 'px-3 py-2.5 text-sm text-text-main truncate', t)));
        return root;
      },
    },
    card: {
      w: 280,
      h: 140,
      defaults: {},
      render(p) {
        const root = el(
          'div',
          `${FILL} flex flex-col gap-1 rounded-xl border border-border-main bg-card p-4 shadow-sm`,
        );
        if (p.label) root.appendChild(el('div', 'font-bold text-text-main truncate', p.label));
        if (p.text) root.appendChild(el('div', 'text-sm text-text-muted whitespace-pre-wrap overflow-hidden', p.text));
        return root;
      },
    },
    box: {
      w: 400,
      h: 240,
      defaults: { fill: 'panel' },
      render() {
        return el('div', `${FILL} rounded-xl border border-border-main`);
      },
    },
    table: {
      w: 560,
      h: 160,
      defaults: {},
      render(p) {
        const rows = lines(p.text).map((r) => (r.includes('\t') ? r.split('\t') : r.split(',')).map((c) => c.trim()));
        const root = el('div', `${FILL} rounded-lg border border-border-main bg-panel`);
        const table = el('table', 'w-full text-sm');
        rows.forEach((cells, i) => {
          const tr = el('tr', i === 0 ? 'bg-card' : 'border-t border-border-main');
          cells.forEach((c) =>
            tr.appendChild(
              el(
                i === 0 ? 'th' : 'td',
                `px-3 py-2 text-left truncate ${i === 0 ? 'text-text-muted font-medium text-xs' : 'text-text-main'}`,
                c,
              ),
            ),
          );
          table.appendChild(tr);
        });
        root.appendChild(table);
        return root;
      },
    },
    badge: {
      w: 64,
      h: 24,
      defaults: { variant: 'muted' },
      render(p) {
        const look =
          {
            primary: 'bg-primary/15 text-primary',
            success: 'bg-success/15 text-success',
            warning: 'bg-warning/15 text-warning',
            error: 'bg-error/15 text-error',
            muted: 'bg-hover text-text-muted',
          }[p.variant] || 'bg-hover text-text-muted';
        return el(
          'div',
          `${FILL} rounded-full flex items-center justify-center text-xs font-medium px-2 truncate ${look}`,
          p.label || '',
        );
      },
    },
    divider: {
      w: 400,
      h: 8,
      defaults: {},
      render() {
        const root = el('div', `${FILL} flex items-center`);
        root.appendChild(el('div', 'w-full border-t border-border-main'));
        return root;
      },
    },
    image: {
      w: 240,
      h: 160,
      defaults: {},
      render(p) {
        const root = el(
          'div',
          `${FILL} rounded-lg border border-dashed border-border-main bg-hover flex flex-col items-center justify-center gap-1 text-text-muted`,
        );
        root.appendChild(el('span', 'text-2xl', '🖼'));
        if (p.label) root.appendChild(el('span', 'text-xs truncate max-w-full px-2', p.label));
        return root;
      },
    },
    progress: {
      w: 240,
      h: 8,
      defaults: { value: 60 },
      render(p) {
        const root = el('div', `${FILL} flex items-center`);
        const track = el('div', 'w-full h-1.5 rounded-full bg-hover overflow-hidden');
        const bar = el('div', 'h-full bg-primary rounded-full');
        const v = Number.isFinite(p.value) ? Math.max(0, Math.min(100, p.value)) : 40;
        bar.style.width = `${v}%`;
        track.appendChild(bar);
        root.appendChild(track);
        return root;
      },
    },

    // ---- 後から足した部品（版は同じ itera-design/1） ----
    search: {
      w: 280,
      h: 36,
      defaults: {},
      render(p) {
        const root = el(
          'div',
          `${FILL} rounded-full border border-border-main bg-card px-3 flex items-center gap-2 text-sm text-text-muted`,
        );
        root.appendChild(el('span', 'shrink-0', '🔍'));
        root.appendChild(el('span', 'truncate', p.text || ''));
        return root;
      },
    },
    avatar: {
      w: 40,
      h: 40,
      defaults: {},
      render(p) {
        return el(
          'div',
          `${FILL} rounded-full bg-primary/15 text-primary flex items-center justify-center text-sm font-bold`,
          p.label || '',
        );
      },
    },
    stat: {
      w: 200,
      h: 96,
      defaults: { text: '128' },
      render(p) {
        const root = el(
          'div',
          `${FILL} flex flex-col justify-center gap-1 rounded-xl border border-border-main bg-card px-4`,
        );
        if (p.label) root.appendChild(el('div', 'text-xs text-text-muted truncate', p.label));
        root.appendChild(el('div', 'text-2xl font-bold text-text-main truncate', p.text || ''));
        return root;
      },
    },
    menu: {
      w: 200,
      h: 140,
      defaults: {},
      render(p) {
        const root = el('div', `${FILL} flex flex-col py-1 rounded-lg border border-border-main bg-card shadow-lg`);
        lines(p.text).forEach((t) => {
          if (/^-+$/.test(t)) root.appendChild(el('div', 'my-1 border-t border-border-main'));
          else root.appendChild(el('div', 'px-3 py-1.5 text-sm text-text-main truncate', t));
        });
        return root;
      },
    },
    modal: {
      w: 440,
      h: 200,
      defaults: { variant: 'confirm' },
      render(p) {
        const root = el(
          'div',
          `${FILL} flex flex-col gap-3 rounded-xl border border-border-main bg-card p-5 shadow-2xl`,
        );
        if (p.label) root.appendChild(el('div', 'text-lg font-bold text-text-main truncate', p.label));
        root.appendChild(
          el('div', 'flex-1 min-h-0 text-sm text-text-muted whitespace-pre-wrap overflow-hidden', p.text || ''),
        );
        const row = el('div', 'flex justify-end gap-2');
        const btn = (t, look) => row.appendChild(el('div', `px-3 py-1.5 rounded-lg text-sm font-medium ${look}`, t));
        if (p.variant === 'info') btn(say('kind.modal.close'), 'bg-primary text-text-inverted');
        else {
          btn(say('kind.modal.cancel'), 'bg-card text-text-main border border-border-main');
          if (p.variant === 'danger') btn(say('kind.modal.delete'), 'bg-error text-text-inverted');
          else btn(say('kind.modal.ok'), 'bg-primary text-text-inverted');
        }
        root.appendChild(row);
        return root;
      },
    },
    toast: {
      w: 320,
      h: 48,
      defaults: { variant: 'success' },
      render(p) {
        const dot =
          {
            success: 'bg-success',
            warning: 'bg-warning',
            error: 'bg-error',
            primary: 'bg-primary',
            muted: 'bg-text-muted',
          }[p.variant] || 'bg-success';
        const root = el(
          'div',
          `${FILL} flex items-center gap-3 rounded-lg border border-border-main bg-card px-4 shadow-lg text-sm text-text-main`,
        );
        root.appendChild(el('span', `w-2 h-2 shrink-0 rounded-full ${dot}`));
        root.appendChild(el('span', 'truncate', p.label || ''));
        return root;
      },
    },
    tree: {
      w: 240,
      h: 200,
      defaults: {},
      render(p) {
        // 行頭の空白 2 つで 1 段下げる。次の行のほうが深ければ、開いている枝として ▾ を付ける
        const rows = String(p.text || '')
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => ({ depth: Math.floor((l.length - l.trimStart().length) / 2), text: l.trim() }));
        const root = el('div', `${FILL} flex flex-col py-1 text-sm text-text-main`);
        rows.forEach((r, i) => {
          const open = i + 1 < rows.length && rows[i + 1].depth > r.depth;
          const row = el('div', 'flex items-center gap-1 py-0.5 truncate');
          row.style.paddingLeft = `${8 + r.depth * 16}px`;
          row.appendChild(el('span', 'w-3 shrink-0 text-text-muted text-xs', open ? '▾' : ''));
          row.appendChild(el('span', 'truncate', r.text));
          root.appendChild(row);
        });
        return root;
      },
    },
    chart: {
      w: 400,
      h: 200,
      defaults: { variant: 'bar' },
      render(p) {
        const data = lines(p.text).map((l) => {
          const [k, v] = (l.includes('\t') ? l.split('\t') : l.split(',')).map((c) => c.trim());
          return { k: k || '', v: Math.max(0, Number(v) || 0) };
        });
        const max = Math.max(1, ...data.map((d) => d.v));
        const root = el('div', `${FILL} flex flex-col gap-2 rounded-xl border border-border-main bg-card p-3`);
        if (p.label) root.appendChild(el('div', 'text-xs font-bold text-text-muted truncate', p.label));
        const plot = el('div', 'flex-1 min-h-0 relative');
        root.appendChild(plot);
        if (p.variant === 'line') {
          const NS = 'http://www.w3.org/2000/svg';
          const svg = document.createElementNS(NS, 'svg');
          svg.setAttribute('viewBox', '0 0 100 100');
          svg.setAttribute('preserveAspectRatio', 'none');
          svg.setAttribute('class', 'absolute inset-0 w-full h-full text-primary');
          const n = data.length;
          // 点の横の位置は、下の名前の列の中央にそろえる
          const pts = data.map((d, i) => `${((i + 0.5) / n) * 100},${100 - (d.v / max) * 95}`).join(' ');
          const line = document.createElementNS(NS, 'polyline');
          line.setAttribute('points', pts);
          line.setAttribute('fill', 'none');
          line.setAttribute('stroke', 'currentColor');
          line.setAttribute('stroke-width', '2');
          line.setAttribute('vector-effect', 'non-scaling-stroke');
          svg.appendChild(line);
          plot.appendChild(svg);
        } else {
          const bars = el('div', 'absolute inset-0 flex items-end gap-2');
          data.forEach((d) => {
            const b = el('div', 'flex-1 bg-primary rounded-t');
            b.style.height = `${(d.v / max) * 100}%`;
            bars.appendChild(b);
          });
          plot.appendChild(bars);
        }
        const axis = el('div', 'flex gap-2 text-[10px] text-text-muted');
        data.forEach((d) => axis.appendChild(el('div', 'flex-1 text-center truncate', d.k)));
        root.appendChild(axis);
        return root;
      },
    },
  };

  const KINDS = Object.keys(SPEC);
  // 部品の名前は言葉の表から引く（読んだときの言語で決まる。OS の言語が変われば変わる）
  for (const kind of KINDS) {
    Object.defineProperty(SPEC[kind], 'name', { enumerable: true, get: () => say(`kind.${kind}.name`) });
  }

  /** 部品を描く。知らない kind は名前を書いた枠にする（書式の 5 章） */
  function render(part) {
    const spec = SPEC[part.kind];
    let node;
    if (spec) {
      try {
        node = spec.render(part);
      } catch (e) {
        console.warn('[DesignParts] render failed', part, e);
        node = el(
          'div',
          `${FILL} border border-error text-error text-xs p-1`,
          say('kind.renderFailed', { kind: part.kind }),
        );
      }
    } else {
      node = el(
        'div',
        `${FILL} border border-dashed border-warning text-warning text-xs p-1`,
        say('kind.unknown', { kind: part.kind }),
      );
    }
    if (part.fill && BG[part.fill]) node.classList.add(BG[part.fill]);
    return node;
  }

  /** 新しい部品の初期値（id と位置はエディタが決める） */
  function create(kind) {
    const spec = SPEC[kind];
    if (!spec) throw new Error(`unknown kind: ${kind}`);
    // 置いたときの文字（label・text）は、置いたときの言語のものを言葉の表から入れる。defaults は言語に依らない値だけ
    const texts = {};
    for (const k of ['label', 'text']) {
      if (global.DesignI18n.has(`kind.${kind}.${k}`)) texts[k] = say(`kind.${kind}.${k}`);
    }
    return { kind, w: spec.w, h: spec.h, ...texts, ...JSON.parse(JSON.stringify(spec.defaults)) };
  }

  global.DesignParts = { SPEC, KINDS, COLORS, BG, render, create, lines };
})(window);
