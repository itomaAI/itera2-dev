/**
 * system/libs/md.js — ゲスト空間で共有するマークダウン描画。
 *
 * 方針:
 *  - **外部に依存しない。** CDN も node_modules も使わない（回線が無い場所でも同じように出る）。
 *  - **HTML は必ず退避してから組み立てる。** 素の HTML を通さないので、読み込んだ文書に
 *    <script> が入っていても実行されない。
 *  - 見た目はテーマ変数（--c-*）と Tailwind のクラスに寄せる（同梱の system/core/tw.js）。
 *
 * 由来: apps/loom.html の mdRender（2026-08-23）。Loom 固有の出来事・総括の描画は持ち込まず、
 * 一般のマークダウンとして要る部分だけを取り出した（2026-08-24 / T-0191）。
 *
 * 置き場: system/libs/ … OS が配る共有ライブラリ（std.js / ui.js / tw.js と同じ層）。
 * 読み込みは絶対パスで <script src="/system/libs/md.js"></script>。
 */
(function (global) {
  'use strict';

  var esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  };
  var attrq = function (s) {
    return String(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  /** 見出しの id。同じ文言が複数あっても衝突しないよう、通し番号を足す。 */
  function slugify(text, seen) {
    var base =
      String(text)
        .trim()
        .toLowerCase()
        .replace(/[`*_~\[\]()#]/g, '')
        .replace(/\s+/g, '-')
        .replace(/[^\w\u3040-\u30ff\u4e00-\u9fff-]/g, '') || 'section';
    var n = (seen[base] = (seen[base] || 0) + 1);
    return n === 1 ? base : base + '-' + n;
  }

  /**
   * 行の中身（強調・コード・リンク・画像）。
   * ★ コード（`...`）を先に退避する。退避しないと、コードの中の * や [ が装飾に化ける。
   */
  function inline(src, opts) {
    var codes = [];
    var h = esc(src).replace(/`([^`]+)`/g, function (m, c) {
      return '\u0000' + (codes.push(c) - 1) + '\u0000';
    });

    h = h
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del class="opacity-60">$1</del>');

    // 画像 → リンク の順。逆にするとリンクの中の ! を拾い損ねる。
    h = h.replace(/!\[([^\]]*)\]\(([^\s)]+)\)/g, function (m, alt, u) {
      return (
        '<img src="' +
        attrq(u) +
        '" alt="' +
        attrq(alt) +
        '" class="my-2 max-w-full rounded-lg border border-border-main" loading="lazy">'
      );
    });

    h = h.replace(/\[([^\]]*)\]\(([^\s)]+)\)/g, function (m, t, u) {
      return anchor(u, t || u, opts);
    });

    // 裸の URL。http/https だけを対象にする（javascript: を <a> にしないため）。
    h = h.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, function (m, pre, u) {
      return pre + anchor(u, u, opts);
    });

    return h.replace(/\u0000(\d+)\u0000/g, function (m, k) {
      return '<code class="px-1 rounded bg-hover font-mono text-[0.85em]">' + codes[k] + '</code>';
    });
  }

  /**
   * リンク 1 つ。
   * ★ 外に出るのは http/https だけ。それ以外（相対パス・./doc.md など）は
   *   **アプリ側に渡す**（data-md-link）。VFS の中を辿るのはアプリの仕事で、ここでは決めない。
   */
  function anchor(href, text, opts) {
    var cls = 'text-primary hover:underline';
    if (/^https?:\/\//i.test(href)) {
      return '<a href="' + attrq(href) + '" target="_blank" rel="noopener" class="' + cls + '">' + text + '</a>';
    }
    if (/^#/.test(href)) {
      return '<a href="' + attrq(href) + '" class="' + cls + '">' + text + '</a>';
    }
    if (opts && opts.onInternalLink === false) return text;
    return '<a href="#" data-md-link="' + attrq(href) + '" class="' + cls + ' decoration-dotted">' + text + '</a>';
  }

  var H_CLS = {
    1: 'text-2xl font-bold mt-6 mb-3 pb-2 border-b border-border-main',
    2: 'text-xl font-bold mt-6 mb-2 pb-1 border-b border-border-main',
    3: 'text-lg font-bold mt-5 mb-2',
    4: 'text-base font-bold mt-4 mb-1',
    5: 'text-sm font-bold mt-3 mb-1',
    6: 'text-sm font-bold text-text-muted mt-3 mb-1',
  };

  /** 本文を HTML にする。 */
  function render(src, opts) {
    opts = opts || {};
    var lines = String(src == null ? '' : src).split('\n');
    var out = [];
    var seen = {};
    var i = 0;

    /**
     * 段落の行のつなぎ方。
     * ★ マークダウンでは、段落の中の改行は「折り返し」であって改行ではない（CommonMark）。
     *   ここを <br> にすると、80 桁で折り返された README が**ぶつ切りの短い行**になる。
     *   一方、行末に空白 2 つ（または \）があるときは**書き手が意図した改行**なので残す。
     * ★ 和文どうしを空白でつなぐと、行の継ぎ目に隙間が空く。両側が和字のときだけ空白を入れない。
     */
    var CJK = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]$/;
    var CJK_HEAD = /^[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
    var joinPara = function (ls) {
      var s = '';
      var hardPrev = false;
      for (var n = 0; n < ls.length; n++) {
        var cur = ls[n];
        var hard = /(\s\s|\\)$/.test(cur);
        var t = cur.replace(/(\s+|\\)$/, '');
        if (n === 0) s = t;
        else if (hardPrev) s += '\n' + t;
        else if (CJK.test(s) && CJK_HEAD.test(t)) s += t;
        else s += ' ' + t;
        hardPrev = hard;
      }
      return s;
    };

    var para = [];
    var flush = function () {
      if (!para.length) return;
      out.push('<p class="my-2 leading-7">' + inline(joinPara(para), opts).replace(/\n/g, '<br>') + '</p>');
      para = [];
    };

    while (i < lines.length) {
      var line = lines[i];

      // コード塊。中身は一切解釈しない。
      var fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
      if (fence) {
        flush();
        var buf = [];
        var j = i + 1;
        while (j < lines.length && !/^\s*```\s*$/.test(lines[j])) (buf.push(lines[j]), j++);
        out.push(
          '<div class="my-3 rounded-lg border border-border-main overflow-hidden">' +
            (fence[1]
              ? '<div class="px-3 py-1 text-[0.7rem] font-mono text-text-muted bg-hover border-b border-border-main">' +
                esc(fence[1]) +
                '</div>'
              : '') +
            '<pre class="p-3 overflow-x-auto bg-panel"><code class="font-mono text-[0.8rem] leading-relaxed whitespace-pre">' +
            esc(buf.join('\n')) +
            '</code></pre></div>',
        );
        i = j + 1;
        continue;
      }

      // 表。2 行目が区切り（|---|---|）のときだけ表として扱う。
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        flush();
        var cells = function (l) {
          return l
            .trim()
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map(function (c) {
              return c.trim();
            });
        };
        var align = cells(lines[i + 1]).map(function (c) {
          return /^:.*:$/.test(c) ? 'center' : /:$/.test(c) ? 'right' : 'left';
        });
        var head = cells(line);
        var k = i + 2;
        var rows = [];
        while (k < lines.length && /^\s*\|.*\|\s*$/.test(lines[k])) (rows.push(cells(lines[k])), k++);
        var th = head
          .map(function (c, n) {
            return (
              '<th class="px-3 py-1.5 border border-border-main bg-hover font-bold whitespace-nowrap" style="text-align:' +
              (align[n] || 'left') +
              '">' +
              inline(c, opts) +
              '</th>'
            );
          })
          .join('');
        var tb = rows
          .map(function (r) {
            return (
              '<tr>' +
              r
                .map(function (c, n) {
                  return (
                    '<td class="px-3 py-1.5 border border-border-main align-top" style="text-align:' +
                    (align[n] || 'left') +
                    '">' +
                    inline(c, opts) +
                    '</td>'
                  );
                })
                .join('') +
              '</tr>'
            );
          })
          .join('');
        out.push(
          '<div class="my-3 overflow-x-auto"><table class="text-sm border-collapse"><thead><tr>' +
            th +
            '</tr></thead><tbody>' +
            tb +
            '</tbody></table></div>',
        );
        i = k;
        continue;
      }

      // 見出し（h1〜h6）。id を振っておくと、目次から飛べる。
      var h = line.match(/^(#{1,6}) +(.*)$/);
      if (h) {
        flush();
        var lv = h[1].length;
        var id = slugify(h[2], seen);
        out.push('<h' + lv + ' id="' + id + '" class="' + H_CLS[lv] + '">' + inline(h[2], opts) + '</h' + lv + '>');
        i++;
        continue;
      }

      // 区切り線。
      if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
        flush();
        out.push('<hr class="my-4 border-border-main">');
        i++;
        continue;
      }

      // 引用。続く行はまとめて 1 つの塊にする。
      if (/^\s*>/.test(line)) {
        flush();
        var q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) (q.push(lines[i].replace(/^\s*> ?/, '')), i++);
        out.push(
          '<blockquote class="my-3 pl-4 border-l-4 border-primary/40 text-text-muted">' +
            render(q.join('\n'), opts) +
            '</blockquote>',
        );
        continue;
      }

      // チェックボックス（- [ ] / - [x] / - [~]）。箇条書きより先に見る。
      var cb = line.match(/^(\s*)[-*] \[([ xX~])\] (.*)$/);
      if (cb) {
        flush();
        var st = cb[2].toLowerCase();
        var icon = st === 'x' ? '☑' : st === '~' ? '◐' : '☐';
        var iconCls = st === 'x' ? 'text-success' : st === '~' ? 'text-warning' : 'text-text-muted';
        var textCls = st === 'x' ? 'line-through text-text-muted' : '';
        out.push(
          '<div class="flex gap-2 py-0.5" style="padding-left:' +
            cb[1].length * 8 +
            'px"><span class="' +
            iconCls +
            ' shrink-0">' +
            icon +
            '</span><span class="' +
            textCls +
            '">' +
            inline(cb[3], opts) +
            '</span></div>',
        );
        i++;
        continue;
      }

      // 箇条書き・番号つき。入れ子は字下げの深さで表す。
      var ul = line.match(/^(\s*)[-*] (.*)$/);
      var ol = line.match(/^(\s*)(\d+)\. (.*)$/);
      if (ul || ol) {
        flush();
        var ind = (ul ? ul[1] : ol[1]).length;
        var mark = ul
          ? '<span class="text-text-muted shrink-0">' + (ind >= 2 ? '◦' : '•') + '</span>'
          : '<span class="text-text-muted font-mono shrink-0">' + ol[2] + '.</span>';
        out.push(
          '<div class="flex gap-2 py-0.5 leading-7" style="padding-left:' +
            ind * 10 +
            'px">' +
            mark +
            '<span>' +
            inline(ul ? ul[2] : ol[3], opts) +
            '</span></div>',
        );
        i++;
        continue;
      }

      if (line.trim() === '') {
        flush();
        i++;
        continue;
      }

      para.push(line);
      i++;
    }
    flush();
    return out.join('');
  }

  /** 目次のための見出し一覧（render と同じ id を返す）。 */
  function headings(src) {
    var seen = {};
    var out = [];
    String(src == null ? '' : src)
      .split('\n')
      .forEach(function (line) {
        var m = line.match(/^(#{1,6}) +(.*)$/);
        if (!m) return;
        out.push({ level: m[1].length, text: m[2].replace(/[*`~]/g, ''), id: slugify(m[2], seen) });
      });
    return out;
  }

  global.MD = { render: render, headings: headings, inline: inline, escape: esc };
})(window);
