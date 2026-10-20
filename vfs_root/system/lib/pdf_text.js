/**
 * system/lib/pdf_text.js — pdf.js の文字の断片（getTextContent の items）を行に組む純粋な部品（T-0681）
 *
 * なぜ要るか:
 *   read_file で PDF を読むと全ページが画像として文脈に入る（start/end は効かない）。長い PDF を何度も読むと
 *   文脈が膨らみクレジットを食う。字形の埋め込みが無い PDF は画像では名称が空白に見えるが、文字の流れは
 *   読める（pdf.js が CMap で符号を文字に戻す）。
 *
 * 置いてあるもの:
 *   transform(m1, m2)                 … pdf.js の Util.transform と同じ（行列の積）
 *   itemsToLines(items, viewportTx)   … 断片を 位置（y → x）で行に組む。行の中は隙間の大きさで空白を入れる
 *   itemsWithPositions(items, viewportTx) … 断片を位置つきで（y<TAB>x<TAB>文字）。表を自分で組み直すとき
 *   renderPage(pageNo, lines)         … `--- p.N ---` の見出しつきの文字
 *   parseRange(from, to, numPages)    … 1 始まりのページ範囲。範囲外は詰める
 *   parsePages(spec, numPages)        … "3" / "3-5" / "1,4,7-9" / "all" を 1 始まりのページ番号の配列に。範囲外は断る（詰めない）
 *   pagesLabel(pages)                 … [3,4,5] → "p003-005"、[1,4,7,8,9] → "p001_004_007-009"（切り出した PDF の名前に）
 */
(function (global) {
  function transform(m1, m2) {
    return [
      m1[0] * m2[0] + m1[2] * m2[1],
      m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
      m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
    ];
  }

  /**
   * items: pdf.js の TextItem（str / transform / width / height）。viewportTx: viewport.transform（既定は単位行列・y 下向きに反転しない）。
   * 戻り: 行の文字列の配列（上から下、左から右）。
   */
  function itemsToLines(items, viewportTx) {
    const vt = viewportTx || [1, 0, 0, 1, 0, 0];
    const glyphs = [];
    for (const it of items || []) {
      if (!it || typeof it.str !== 'string' || !it.transform) continue;
      if (!it.str.trim()) continue;
      const tx = transform(vt, it.transform);
      const h = Math.hypot(tx[2], tx[3]) || Math.abs(it.height) || 1;
      const scale = Math.hypot(vt[0], vt[1]) || 1;
      const w = (it.width || 0) * scale;
      glyphs.push({ str: it.str, x: tx[4], y: tx[5], h, w });
    }
    // y で束ねる（行の高さの半分以内なら同じ行）。先に y で並べ、行ごとに x で並べる
    glyphs.sort((a, b) => a.y - b.y || a.x - b.x);
    const rows = [];
    for (const g of glyphs) {
      const last = rows[rows.length - 1];
      if (last && Math.abs(g.y - last.y) <= Math.max(2, Math.min(last.h, g.h) * 0.5)) {
        last.items.push(g);
        // 行の y は平均に寄せる（1 文字ずつ位置を置く PDF で少しずつずれるため）
        last.y = (last.y * (last.items.length - 1) + g.y) / last.items.length;
        last.h = Math.max(last.h, g.h);
      } else rows.push({ y: g.y, h: g.h, items: [g] });
    }
    const lines = [];
    for (const row of rows) {
      row.items.sort((a, b) => a.x - b.x);
      let s = '';
      let end = null;
      for (const g of row.items) {
        if (end != null) {
          const gap = g.x - end;
          const unit = Math.max(1, g.h * 0.25);
          if (gap > unit * 6) s += '   ';
          else if (gap > unit) s += ' ';
        }
        s += g.str;
        end = g.x + g.w;
      }
      lines.push(s.replace(/\s+$/, ''));
    }
    return lines;
  }

  function renderPage(pageNo, lines) {
    const body = lines && lines.length ? lines.join('\n') : '（文字なし）';
    return `--- p.${pageNo} ---\n${body}\n`;
  }

  /**
   * 断片を位置つきで 1 行ずつ（`y<TAB>x<TAB>文字`。上から下・左から右。単位は pt、原点は左上）。
   * 表の列や 2 段の行（名称が上の行・数量と単位が下の行）を自分で組み直したいときに使う。
   */
  function itemsWithPositions(items, viewportTx) {
    const vt = viewportTx || [1, 0, 0, 1, 0, 0];
    const out = [];
    for (const it of items || []) {
      if (!it || typeof it.str !== 'string' || !it.transform) continue;
      if (!it.str.trim()) continue;
      const tx = transform(vt, it.transform);
      out.push({ x: Math.round(tx[4] * 10) / 10, y: Math.round(tx[5] * 10) / 10, str: it.str });
    }
    out.sort((a, b) => a.y - b.y || a.x - b.x);
    return out.map((g) => `${g.y}\t${g.x}\t${g.str}`);
  }

  function parseRange(from, to, numPages) {
    const n = Math.max(0, numPages | 0);
    let a = parseInt(from, 10);
    let b = parseInt(to, 10);
    if (!Number.isFinite(a) || a < 1) a = 1;
    if (!Number.isFinite(b) || b > n) b = n;
    if (a > n) a = n;
    if (b < a) b = a;
    return { from: a, to: b };
  }

  /**
   * ページの指定を番号の配列に（昇順・重複なし）。"3"・"3-5"・"1,4,7-9"・"-3"（1〜3）・"7-"（7〜最後）・"all"。
   * 範囲外・読めない指定は Error を投げる（黙って詰めると「指定したページを読んだつもり」になる）。
   */
  function parsePages(spec, numPages) {
    const n = Math.max(0, numPages | 0);
    const s = String(spec == null ? '' : spec).trim();
    if (!s) throw new Error('pages が要る（例: "3" / "3-5" / "1,4,7-9" / "all"）');
    if (n < 1) throw new Error('この PDF にページが無い');
    if (/^all$/i.test(s)) return Array.from({ length: n }, (_, i) => i + 1);
    const out = new Set();
    for (const part0 of s.split(',')) {
      const part = part0.trim();
      if (!part) continue;
      const m = /^(\d*)\s*-\s*(\d*)$/.exec(part);
      let a;
      let b;
      if (m) {
        if (!m[1] && !m[2]) throw new Error(`読めないページ指定: "${part}"`);
        a = m[1] ? parseInt(m[1], 10) : 1;
        b = m[2] ? parseInt(m[2], 10) : n;
      } else if (/^\d+$/.test(part)) {
        a = b = parseInt(part, 10);
      } else throw new Error(`読めないページ指定: "${part}"`);
      if (a < 1 || b > n || a > b) throw new Error(`ページ "${part}" は範囲外（この PDF は 1〜${n} ページ）`);
      for (let i = a; i <= b; i++) out.add(i);
    }
    if (!out.size) throw new Error('pages が空');
    return Array.from(out).sort((x, y) => x - y);
  }

  function pagesLabel(pages) {
    const runs = [];
    for (const i of pages) {
      const last = runs[runs.length - 1];
      if (last && last[1] === i - 1) last[1] = i;
      else runs.push([i, i]);
    }
    const pad = (n) => String(n).padStart(3, '0');
    return 'p' + runs.map(([a, b]) => (a === b ? pad(a) : pad(a) + '-' + pad(b))).join('_');
  }

  const api = { transform, itemsToLines, itemsWithPositions, renderPage, parseRange, parsePages, pagesLabel };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.PdfText = api;
})(typeof window !== 'undefined' ? window : globalThis);
