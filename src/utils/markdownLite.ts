/**
 * src/utils/markdownLite.ts
 * Itera OS v2: Minimal block-level Markdown renderer for the artifact frame.
 *
 * 成果物枠（Iteraの発話）専用の整形器。
 *
 * NOTE: これは完全なMarkdownパーサではない。ChatPanel._formatSystemMessage や
 * markdownTable.ts と同じく、正規表現ベースの実用的な処理に留めている。
 * 対応するのは 見出し / 箇条書き / 番号付きリスト / 強調 / インラインコード /
 * コードフェンス / GFMのパイプ表 のみ。
 *
 * IMPORTANT: 入力は **HTMLエスケープ済み** であることを前提とする
 * （markdownTable.ts と同じ契約）。セル・コード内容は再エスケープしない。
 *
 * 【設計上の注意】
 * 1. コードフェンスと表は、他の変換より先にプレースホルダへ退避する。
 *    退避しないと、コード中の `-` や `|` が見出し・リスト・表として誤爆する。
 *    （Translator._parseToTree の __PROTECTED_...__ と同じ考え方）
 * 2. 斜体 `*em*` は意図的に未対応。箇条書きの `* item` と区別がつかないため、
 *    中途半端に実装するより出さない方が安全と判断した。
 * 3. ネストしたリストは未対応（1段のみ）。
 * 4. ブロック要素を組み立てて返すので、描画側のコンテナに
 *    `whitespace-pre-wrap` を付けてはならない（段落が二重に空く）。
 */

import { renderMarkdownTables } from './markdownTable';

/**
 * 【重要】ここの寸法は必ず em で書くこと。rem も px も使ってはならない。
 *
 * この整形器の出力は成果物枠（.chat-body）の中に置かれる。
 * 本文の寸法は外観設定で 12/13/14/16px と利用者が変えられるため、
 * rem で書くと本文だけが伸縮し、見出しやコードとの上下関係が壊れる。
 * 実際、本文を 16px にすると rem 基準の h3（14px）は本文より小さくなる。
 * em にしておけば本文に対する比が保たれ、どの設定でも階層が崩れない。
 *
 * 既定（本文 14px）での実寸は h1 18px / h2 16px / h3 14px / コード 12px。
 * 以前は 16/15/14px の px 固定で、全体スケールを上げると
 * 見出し3段すべてが本文より小さくなっていた（実測値）。
 *
 * h3 が本文と同寸（1em）なのは意図的（2026-08-17 決定）。
 * 太字と通常の印象差が十分に大きいため、サイズを変えなくても見出しとして読める。
 * 幅の狭いチャット欄では、寸法の段数を増やすより字面を揃えるほうが落ち着く。
 *
 * なお leading-relaxed は text-* が持つ行間より後に適用される
 * （Tailwind は lineHeight プラグインを fontSize より後ろに置くため）。
 * 両方を並べる書き方で意図どおりになる。冗長ではない。
 */
const PRE_CLASS =
  'bg-app border border-border-main p-2 rounded my-2 overflow-x-auto text-text-main font-mono text-[0.86em] leading-relaxed';
const CODE_CLASS = 'bg-overlay/10 text-primary px-1 rounded font-mono text-[0.86em]';
const H_CLASS: Record<number, string> = {
  1: 'font-bold text-text-main text-[1.29em] mt-4 mb-2 first:mt-0',
  2: 'font-bold text-text-main text-[1.14em] mt-4 mb-2 first:mt-0',
  3: 'font-bold text-text-main text-[1em] mt-3 mb-1.5 first:mt-0',
};

const TABLE_LINE = /^<div class="overflow-x-auto my-2">.*$/gm;

export function renderMarkdownLite(escapedText: string): string {
  if (!escapedText) return '';

  const blocks: string[] = [];
  const hold = (html: string): string => {
    blocks.push(html);
    return `__MDLITE_${blocks.length - 1}__`;
  };

  // --- 1. コードフェンスを退避 ---
  let text = escapedText.replace(/```(?:([a-zA-Z0-9_+#-]+)\n)?([\s\S]*?)```/g, (_m, lang, code) => {
    const langClass = lang ? `language-${lang}` : 'language-plaintext';
    return hold(`<pre class="${PRE_CLASS}"><code class="${langClass}">${code}</code></pre>`);
  });

  // --- 2. 表を変換し、生成HTMLも退避 ---
  text = renderMarkdownTables(text);
  text = text.replace(TABLE_LINE, (m) => hold(m));

  // --- 3. インラインコードを退避（この後の強調変換から守る） ---
  text = text.replace(/`([^`\n]+)`/g, (_m, code) => hold(`<code class="${CODE_CLASS}">${code}</code>`));

  // --- 4. 行をブロックへ組み立てる ---
  const lines = text.split('\n');
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(`<p class="my-2 leading-relaxed">${paragraph.map(inline).join('<br />')}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (!list) return;
    const tag = list.ordered ? 'ol' : 'ul';
    const style = list.ordered ? 'list-decimal' : 'list-disc';
    const items = list.items.map((it) => `<li class="my-0.5">${inline(it)}</li>`).join('');
    out.push(`<${tag} class="${style} pl-5 my-2 leading-relaxed">${items}</${tag}>`);
    list = null;
  };

  const flushAll = () => {
    flushParagraph();
    flushList();
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    // 空行：ブロックの区切り
    if (!line.trim()) {
      flushAll();
      continue;
    }

    // 退避済みブロック（コード・表）は単独で置く
    const onlyPlaceholder = line.trim().match(/^__MDLITE_(\d+)__$/);
    if (onlyPlaceholder) {
      flushAll();
      out.push(line.trim());
      continue;
    }

    // 見出し
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushAll();
      const level = Math.min(heading[1].length, 3);
      out.push(`<h${level} class="${H_CLASS[level]}">${inline(heading[2])}</h${level}>`);
      continue;
    }

    // 水平線
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushAll();
      out.push('<hr class="my-3 border-border-main" />');
      continue;
    }

    // 箇条書き
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      flushParagraph();
      if (!list || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(bullet[1]);
      continue;
    }

    // 番号付きリスト
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ordered) {
      flushParagraph();
      if (!list || !list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(ordered[1]);
      continue;
    }

    // リストの継続行はリスト項目へ足す（折り返しを段落に落とさない）
    if (list) {
      list.items[list.items.length - 1] += ' ' + line.trim();
      continue;
    }

    paragraph.push(line);
  }

  flushAll();

  // --- 5. 退避したブロックを戻す ---
  let html = out.join('');
  blocks.forEach((block, idx) => {
    html = html.split(`__MDLITE_${idx}__`).join(block);
  });

  return html;
}

/**
 * 行内の装飾。強調のみ（インラインコードは退避済み）。
 */
function inline(text: string): string {
  return text.replace(/\*\*([^*\n]+)\*\*/g, '<strong class="font-bold">$1</strong>');
}