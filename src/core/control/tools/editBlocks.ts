/**
 * src/core/control/tools/editBlocks.ts
 * <edit_file> の SEARCH ブロック — 切り出しと適用（T-0407）
 *
 * VFS に触らない純粋な文字列処理として分けてある。単体で試験するため、
 * そしてミャク楽（myaku-raku-v2/agent）へファイル 1 本で横流しするため。
 *
 * 柱は 1 つだけ: **黙って壊れる経路を持たない**。
 *   - 一致が一意でなければ書かない（定義文の "must be unique" を実装で守る）
 *   - 塊の切り出しが一意に決まらなければ書かない
 *   - 途中の塊が壊れていたら、他が通っていても書かない（以前は黙って捨てて success を返していた）
 * そしてエラーは必ず「次に何を書けば通るか」が分かる形にする（件数・行番号）。
 *
 * マーカーの個数について。開始・区切り・終端を同じ長さに揃える規則は、
 * 本文に `====` が含まれるときに逃げ道を用意するためのものである。意図は正しい。
 * ただし衝突が無いときまで数えさせる必要はないので、ここでは
 * **候補が 1 本ならどんな長さでも受ける／複数あるときだけ開始と同数のものを選ぶ／
 * それでも決まらなければエラー** とした。規則を捨てるのではなく、
 * 衝突したときにだけ効く規則へ格下げしている（受けるほうは緩く、書き方の作法は据え置き）。
 */

export interface EditBlock {
  /** 探す文字列（regex="true" のときは正規表現そのもの） */
  pattern: string;
  /** 置き換える文字列 */
  replacement: string;
  /** 開始マーカーの行番号（1 始まり）。エラー文で塊を名指しするために持つ */
  line: number;
}

interface Marker {
  index: number;
  end: number;
  /** マーカー文字の個数 */
  len: number;
  line: number;
}

const HEADER = /^(<{4,})SEARCH[^\r\n]*$/gm;
const SEPARATOR = /^={4,}$/gm;
const CLOSER = /^>{4,}$/gm;

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** マーカー行の直後（改行を跨いだ位置）を返す */
function afterLine(text: string, end: number): number {
  let i = end;
  if (text[i] === '\r') i++;
  if (text[i] === '\n') i++;
  return i;
}

/**
 * <edit_file> の中身は改行で始まる（`<edit_file …>` の直後で行を変えて書くため）。
 * 素朴に数えると「1 行目に書いた SEARCH」が 2 行目として報告され、読む側が一度つまずく。
 * ここで差し引いて、書いた側の見た目と揃えておく。
 */
function leadingShift(content: string): number {
  return /^\r?\n/.test(content) ? 1 : 0;
}

function findMarkers(source: RegExp, text: string, from: number, to: number, shift: number): Marker[] {
  const re = new RegExp(source.source, 'gm');
  re.lastIndex = from;
  const out: Marker[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index >= to) break;
    out.push({ index: m.index, end: m.index + m[0].length, len: m[0].length, line: lineOf(text, m.index) - shift });
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

/**
 * 候補の中から本物のマーカーを選ぶ。
 * 1 本しか無ければ長さを問わない。複数あるときだけ「開始と同数」で絞る。
 */
function pick(label: string, cands: Marker[], n: number, headerLine: number, ch: string): Marker {
  if (cands.length === 1) return cands[0];
  const exact = cands.filter((c) => c.len === n);
  if (exact.length === 1) return exact[0];

  const list = cands.map((c) => `line ${c.line} (${c.len} '${ch}')`).join(', ');
  if (exact.length === 0) {
    throw new Error(
      `Ambiguous ${label} for the SEARCH block starting at line ${headerLine} of this edit_file content: ` +
        `${cands.length} candidate lines (${list}), none of which is ${n} characters long like the opening marker. ` +
        `Make the intended ${label} exactly ${n} '${ch}' characters. No changes were made to the file.`,
    );
  }
  throw new Error(
    `Ambiguous ${label} for the SEARCH block starting at line ${headerLine} of this edit_file content: ` +
      `${exact.length} of the ${cands.length} candidate lines (${list}) are ${n} characters long, ` +
      `so the block cannot be delimited. Use longer markers (e.g. ${n + 3} characters for all three) ` +
      `so that only the intended line matches. No changes were made to the file.`,
  );
}

/**
 * <edit_file> の中身から塊を切り出す。
 * 壊れた塊を黙って読み飛ばさない —— どれか 1 つでも決まらなければ例外を投げる。
 */
export function parseEditBlocks(content: string): EditBlock[] {
  const shift = leadingShift(content);
  const heads: Marker[] = [];
  const re = new RegExp(HEADER.source, 'gm');
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    heads.push({
      index: m.index,
      end: m.index + m[0].length,
      len: m[1].length,
      line: lineOf(content, m.index) - shift,
    });
  }
  if (heads.length === 0) {
    throw new Error(
      "No SEARCH block found. The opening marker must be a line of its own that starts with at least four '<' " +
        'followed by SEARCH (e.g. `<<<<<SEARCH`). No changes were made to the file.',
    );
  }

  const blocks: EditBlock[] = [];
  let cursor = 0;
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    // 直前の塊の内側にあった行。見出しではなく本文である
    if (h.index < cursor) continue;

    // 次の見出しまでを塊の範囲とする（複数の塊を書いたとき、隣の塊のマーカーを候補に含めないため）。
    // その範囲に候補が 1 本も無ければ、範囲の切り方のほうが誤っていた
    // ＝ 本文に見出しらしき行があった、ということなので末尾まで広げて捜し直す。
    const bound = i + 1 < heads.length ? heads[i + 1].index : content.length;

    const bodyStart = afterLine(content, h.end);
    let seps = findMarkers(SEPARATOR, content, bodyStart, Math.max(bound, bodyStart), shift);
    if (seps.length === 0) seps = findMarkers(SEPARATOR, content, bodyStart, content.length, shift);
    if (seps.length === 0) {
      throw new Error(
        `No separator found for the SEARCH block starting at line ${h.line} of this edit_file content. ` +
          `Expected a line of ${h.len} '=' characters between the text to find and the replacement. ` +
          `No changes were made to the file.`,
      );
    }
    const sep = pick('separator', seps, h.len, h.line, '=');

    const repStart = afterLine(content, sep.end);
    let closers = findMarkers(CLOSER, content, repStart, Math.max(bound, repStart), shift);
    if (closers.length === 0) closers = findMarkers(CLOSER, content, repStart, content.length, shift);
    if (closers.length === 0) {
      throw new Error(
        `No closing marker found for the SEARCH block starting at line ${h.line} of this edit_file content. ` +
          `Expected a line of ${h.len} '>' characters after the replacement. ` +
          `No changes were made to the file.`,
      );
    }
    const closer = pick('closing marker', closers, h.len, h.line, '>');

    const pattern = content.slice(bodyStart, sep.index).replace(/\r?\n$/, '');
    const replacement = content.slice(repStart, closer.index).replace(/\r?\n$/, '');
    if (pattern.length === 0) {
      throw new Error(
        `The SEARCH block starting at line ${h.line} of this edit_file content has nothing to find ` +
          `(the part above the separator is empty). ` +
          `No changes were made to the file.`,
      );
    }

    blocks.push({ pattern, replacement, line: h.line });
    cursor = closer.end;
  }
  return blocks;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** hard=false: 行末の空白と改行コードだけを均す / hard=true: 字下げも均す */
function normalizeSpace(s: string, hard: boolean): string {
  return s
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => (hard ? l.trim() : l.replace(/[ \t]+$/, '')))
    .join('\n');
}

interface Hit {
  index: number;
  length: number;
}

function findHits(pattern: string, text: string): Hit[] {
  const re = new RegExp(pattern, 'gm');
  const out: Hit[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ index: m.index, length: m[0].length });
    if (m[0].length === 0) re.lastIndex++;
    if (out.length >= 200) break;
  }
  return out;
}

/** 見つからなかったときに「なぜ外れたか」の手掛かりを添える */
function notFoundHint(text: string, pattern: string, isRegex: boolean): string {
  if (isRegex) return '';
  if (normalizeSpace(text, false).includes(normalizeSpace(pattern, false))) {
    return (
      ' The same text is present but the trailing whitespace or the line endings differ —' +
      ' copy the lines exactly as read_file shows them.'
    );
  }
  if (normalizeSpace(text, true).includes(normalizeSpace(pattern, true))) {
    return (
      ' The same text is present but the indentation differs —' + ' copy the lines exactly as read_file shows them.'
    );
  }
  const first = pattern.split('\n').find((l) => l.trim().length > 0);
  if (first) {
    const needle = first.trim();
    const lines: number[] = [];
    const rows = text.split('\n');
    for (let i = 0; i < rows.length && lines.length < 5; i++) {
      if (rows[i].includes(needle)) lines.push(i + 1);
    }
    if (lines.length > 0) {
      return ` Its first line occurs at line ${lines.join(', ')} of the file, so it is the rest of the block that differs.`;
    }
  }
  return '';
}

/**
 * 塊を順に当てて、書き換えた全文を返す。
 * 一致が 0 件でも 2 件以上でも例外を投げる（呼び出し側は例外なら 1 文字も書かない）。
 */
export function applyEditBlocks(fileContent: string, blocks: EditBlock[], opts: { regex?: boolean } = {}): string {
  const isRegex = opts.regex === true;
  let text = fileContent;

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    // 行番号は 2 つの座標系を行き来する。どちらの話をしているかを必ず言葉で添える
    const where = `block ${i + 1} (its SEARCH marker is on line ${b.line} of this edit_file content)`;

    if (b.replacement === b.pattern) {
      throw new Error(
        `${where} would not change anything (both sides are identical). No changes were made to the file.`,
      );
    }

    const source = isRegex ? b.pattern : escapeRegExp(b.pattern);
    let hits: Hit[];
    try {
      hits = findHits(source, text);
    } catch (e) {
      throw new Error(`Invalid RegExp in ${where}: ${(e as Error).message}. No changes were made to the file.`);
    }

    if (hits.length === 0) {
      throw new Error(
        `Search pattern not found for ${where}.${notFoundHint(text, b.pattern, isRegex)} No changes were made to the file.`,
      );
    }
    if (hits.length > 1) {
      const shown = hits.slice(0, 8).map((h) => lineOf(text, h.index));
      const more = hits.length > shown.length ? ', ...' : '';
      throw new Error(
        `The SEARCH pattern of ${where} matched ${hits.length} times in the file (lines ${shown.join(', ')}${more}), ` +
          `but it must match exactly once. Add surrounding lines to the block until it is unique. ` +
          `No changes were made to the file.`,
      );
    }
    if (hits[0].length === 0) {
      throw new Error(`The SEARCH pattern of ${where} matched an empty string. No changes were made to the file.`);
    }

    text = text.slice(0, hits[0].index) + b.replacement + text.slice(hits[0].index + hits[0].length);
  }

  return text;
}
