/**
 * src/core/cognitive/Translator.ts
 * Itera OS v2: LPML (LLM-Prompting Markup Language) Parser
 */

import type { ToolParams } from '../types/tools';

const PARSE_TERMINAL_TAGS = new Set(['yield', 'breathe', 'ask', 'finish']);
const INTERRUPT_ACTION_TAGS = new Set(['ask', 'finish', 'breathe']);

/**
 * システムがコンテキストへ注入する専用タグ（LLM が生成してはならないもの）。
 *
 * これらは defaultExcludeTags に合流するため、内側の内容は解釈されず
 * 生テキストとして保持される。すなわち「偽装したタグの内部に書かれた
 * タグがアクションとして実行される」経路を塞ぐ。
 *
 * 一方でタグのノード自身はアクションとして残る。登録済みツールには
 * 存在しないため、ToolRegistry が失敗の結果（偽装を咎める文面）を返す
 * （黙って無視すると LLM が学習できない）。
 */
export const RESERVED_SYSTEM_TAGS = new Set([
  'tool_output',
  'event',
  'system',
  'toolset',
  'user_input',
  'user_attachment',
]);

/**
 * LPML の要素（T-0878）。
 *
 * `closed` は、その要素が書き終えられたかどうか: 空タグ（`<x />`）か、自分の閉じタグ（`</x>`）で終わったときだけ true。
 * 文字の終わりまで開いたままの要素と、外側の閉じタグに巻き取られた要素は false のまま残る。
 *
 * **実行されるのは閉じた要素だけ**。閉じていない要素は、どこで終わるはずだったかが
 * 分からない —— 中身も、その中に見えるタグの位置も、書き手の意図したものとは限らない。
 */
export interface LpmlElement {
  tag: string;
  attributes: Record<string, string>;
  /** 空タグは null */
  content: LpmlNode[] | null;
  closed: boolean;
}
export type LpmlNode = string | LpmlElement;
/** 開始タグで始まった要素（中身を持つ） */
type OpenElement = LpmlElement & { content: LpmlNode[] };

export interface ParsedAction {
  type: string;
  params: ToolParams;
  raw: LpmlElement;
  /** 要素が閉じていたか。false のものは実行されない（ToolRegistry が「閉じていない」という失敗の結果を返す） */
  closed: boolean;
  originalIndex: number;
}

export interface ParseResult extends Array<ParsedAction> {
  hasLeak: boolean;
  /** 最初の（ルート階層の）終端タグまでの文字列。終端タグが無ければ全文 */
  truncatedText: string;
  isTruncated: boolean;
  /** 見つかった終端タグの名前（yield / breathe / ask / finish）。無ければ null */
  terminalTag: string | null;
  /** 終端タグより後ろの文字列（解釈も実行もしない）。履歴からは削らず、Engine が警告に使う */
  trailingText: string;
  /** trailingText に現れたタグの名前（開始タグと空タグ。出現順・重複なし。コードブロックの中は数えない） */
  trailingTags: string[];
}

/** 同じファイルへの行指定の編集を下から順に並べる対象（T-0683: edit と旧名 edit_file） */
const EDIT_TAGS = new Set(['edit', 'edit_file']);

export class Translator {
  static PATTERN_ATTRIBUTE = /\s+([^"'/<>=\s]+)=(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
  static ATTR_PART_NO_CAPTURE = '\\s+[^"\'/<>=\\s]+=(?:"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\')';
  static PATTERN_TAG_START = '<([^/>\\s\\n]+)((?:' + Translator.ATTR_PART_NO_CAPTURE + ')*)\\s*>';
  static PATTERN_TAG_END = '</([^/>\\s\\n]+)\\s*>';
  static PATTERN_TAG_EMPTY = '<([^/>\\s\\n]+)((?:' + Translator.ATTR_PART_NO_CAPTURE + ')*)\\s*/>';
  static PATTERN_TAG = new RegExp(
    `(${Translator.PATTERN_TAG_START})|(${Translator.PATTERN_TAG_END})|(${Translator.PATTERN_TAG_EMPTY})`,
    'g',
  );
  static PATTERN_PROTECT = /(^ *```[^\n]*\n[\s\S]*?\n *```|`[^`\n]*`|<!--[\s\S]*?-->|<![\s\S]*?>)/gm;

  private defaultExcludeTags: string[];

  constructor() {
    this.defaultExcludeTags = [
      // 中身をそのまま持つ道具（T-0683 で write / edit に。旧名もしばらく残る）
      'write',
      'edit',
      'create_file',
      'edit_file',
      'thinking',
      'memo',
      'plan',
      'report',
      'ask',
      'user_input',
      'user_attachment',
      'inject_js',
      // システム注入専用タグ。内側を解釈させないことで、偽装タグの
      // 内部に置かれたタグが実行されるのを防ぐ。
      ...RESERVED_SYSTEM_TAGS,
    ];
  }

  /**
   * テキスト全体をパースし、アクションオブジェクトの配列を返す
   * @param text - パース対象のテキスト
   * @param additionalExcludeTags - 動的に追加する保護対象タグのリスト
   */
  parse(text: string, additionalExcludeTags: string[] = []): ParseResult {
    // フェールセーフ: LLMが指示を無視してCDATAでエスケープした場合、
    // 独自のパースロジックと衝突しないようにガワ(タグ)だけを剥がして中身を展開する
    const cleanedText = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1');

    const exclude = [...this.defaultExcludeTags, ...additionalExcludeTags];
    const { tree, truncatedText, isTruncated, terminalTag, trailingText, trailingTags } = this._parseToTree(
      cleanedText,
      exclude,
    );

    // 1. ツリーのルートレベルに残っている「どのタグにも属さない生テキスト」を結合
    let leakedText = '';
    for (const node of tree) {
      if (typeof node === 'string') {
        leakedText += node;
      }
    }

    // 空白文字（改行、スペース）を除去し、有意な長さ（例：3文字以上）があれば漏洩と判定
    const cleanLeak = leakedText.replace(/\s+/g, '');
    const hasLeak = cleanLeak.length >= 3;

    // 2. 要素をアクションにする（閉じた要素の中は再帰的に辿る。閉じていない要素の中は辿らない）
    const actions: ParsedAction[] = this._collectElements(tree).map((item, i) => ({
      type: item.tag,
      params: {
        ...item.attributes,
        content: this._extractContent(item.content),
      },
      raw: item,
      closed: item.closed,
      originalIndex: i, // ★ 元のテキスト内での出現順序を記録
    }));

    const sortedActions = this._sortActions(actions);

    // 配列オブジェクト自身にプロパティとしてフラグとテキストを付与
    const result = sortedActions as ParseResult;
    result.hasLeak = hasLeak;
    result.truncatedText = truncatedText;
    result.isTruncated = isTruncated;
    result.terminalTag = terminalTag;
    result.trailingText = trailingText;
    result.trailingTags = trailingTags;

    return result;
  }

  /**
   * 木を出現順に辿って、要素を平らに並べる。
   *
   * 閉じた要素は中も辿る。閉じていない要素は、要素そのものだけを並べて中は辿らない ——
   * どこで終わるはずだったかが分からないので、中に見えるタグは「その要素の中身」としてしか読めない。
   * 要素そのものを残すのは、実行する側が「閉じていないので実行しなかった」と伝えられるようにするため
   * （黙って捨てると、書き手は何が起きたかを知れない）。
   */
  private _collectElements(nodes: LpmlNode[]): LpmlElement[] {
    const result: LpmlElement[] = [];
    for (const node of nodes) {
      if (typeof node === 'string') continue;
      result.push(node);
      if (node.closed && node.content) result.push(...this._collectElements(node.content));
    }
    return result;
  }

  // --- Internal Parsing Logic ---
  private _parseAttributes(text: string): Record<string, string> {
    const attributes: Record<string, string> = {};
    const regex = new RegExp(Translator.PATTERN_ATTRIBUTE);
    let match;
    while ((match = regex.exec(text)) !== null) {
      const key = match[1];
      let value = match[2] !== undefined ? match[2] : match[3];
      if (value) {
        value = value.replace(/\\(.)/g, '$1');
      }
      attributes[key] = value || '';
    }
    return attributes;
  }

  private _restoreString(text: string, protectedMap: Record<string, string>): string {
    if (!text.includes('__PROTECTED_')) return text;
    let result = text;
    for (const [placeholder, original] of Object.entries(protectedMap)) {
      result = result.replace(placeholder, () => original);
    }
    return result;
  }

  private _restoreTree(tree: LpmlNode[], protectedMap: Record<string, string>): LpmlNode[] {
    return tree.map((item) => {
      if (typeof item === 'string') return this._restoreString(item, protectedMap);
      if (item.attributes) {
        for (const k in item.attributes) {
          item.attributes[k] = this._restoreString(item.attributes[k], protectedMap);
        }
      }
      if (Array.isArray(item.content)) {
        item.content = this._restoreTree(item.content, protectedMap);
      }
      return item;
    });
  }

  private _parseToTree(
    text: string,
    exclude: string[] = [],
  ): {
    tree: LpmlNode[];
    truncatedText: string;
    isTruncated: boolean;
    terminalTag: string | null;
    trailingText: string;
    trailingTags: string[];
  } {
    const protectedContent: Record<string, string> = {};
    const protectedText = text.replace(Translator.PATTERN_PROTECT, (match) => {
      const placeholder = `__PROTECTED_${Math.random().toString(36).substring(2, 15)}__`;
      protectedContent[placeholder] = match;
      return placeholder;
    });

    const tree: LpmlNode[] = [];
    /** 開いたままの要素（外側から順）。空なら最上位にいる */
    let open: OpenElement[] = [];
    /** いま文字や要素を足す先: いちばん内側の開いた要素の中身。開いた要素が無ければ最上位 */
    const sink = (): LpmlNode[] => (open.length > 0 ? open[open.length - 1].content : tree);
    /** 中身をそのまま持つ要素の中にいる間、その名前。自分の閉じタグが来るまで、ほかのタグは文字として読む */
    let tagExclude: string | null = null;
    let cursor = 0;

    const regexTag = new RegExp(Translator.PATTERN_TAG);
    let match;
    const regexStart = new RegExp('^' + Translator.PATTERN_TAG_START + '$');
    const regexEnd = new RegExp('^' + Translator.PATTERN_TAG_END + '$');
    const regexEmpty = new RegExp('^' + Translator.PATTERN_TAG_EMPTY + '$');

    let terminalIndex = -1;
    let terminalTag: string | null = null;
    /**
     * いま読んだ空タグ・閉じタグが、最上位の終端タグか。
     * 相手の無い閉じタグ（開始タグなしの `</ask>`）も、最上位に在れば従来どおり終端として読む
     */
    const endsTurn = (name: string): boolean => open.length === 0 && PARSE_TERMINAL_TAGS.has(name);

    while ((match = regexTag.exec(protectedText)) !== null) {
      const tagStr = match[0];
      const indTagStart = match.index;
      const indTagEnd = indTagStart + tagStr.length;
      const matchTagStart = tagStr.match(regexStart);
      const matchTagEnd = tagStr.match(regexEnd);
      const matchTagEmpty = tagStr.match(regexEmpty);

      if (tagExclude !== null) {
        if (matchTagEnd && matchTagEnd[1] === tagExclude) {
          tagExclude = null;
        } else {
          continue;
        }
      }

      const contentStr = protectedText.substring(cursor, indTagStart);
      if (contentStr.length > 0) sink().push(contentStr);
      cursor = indTagEnd;

      if (matchTagStart) {
        // 開いた時点では閉じていない。閉じるのは、自分の閉じタグが来たときだけ
        const name = matchTagStart[1];
        if (exclude.includes(name)) tagExclude = name;
        const el: OpenElement = {
          tag: name,
          attributes: this._parseAttributes(matchTagStart[2]),
          content: [],
          closed: false,
        };
        sink().push(el);
        open.push(el);
      } else if (matchTagEmpty) {
        // 空タグは、書いた時点で閉じている
        const name = matchTagEmpty[1];
        sink().push({ tag: name, attributes: this._parseAttributes(matchTagEmpty[2]), content: null, closed: true });
        if (endsTurn(name)) {
          terminalIndex = indTagEnd;
          terminalTag = name;
          break;
        }
      } else if (matchTagEnd) {
        // 同じ名前の、いちばん内側の開いた要素を閉じる。
        // その内側で開いたままだった要素は、ここで巻き取られて終わる（閉じないまま）
        const name = matchTagEnd[1];
        const idx = open.map((el) => el.tag).lastIndexOf(name);
        if (idx >= 0) {
          open[idx].closed = true;
          open = open.slice(0, idx);
        } else {
          // 相手の無い閉じタグは要素を作らない。文字として残す
          sink().push(tagStr);
        }
        if (endsTurn(name)) {
          terminalIndex = indTagEnd;
          terminalTag = name;
          break;
        }
      }
    }

    let finalProtectedText = protectedText;
    let trailingProtected = '';
    if (terminalIndex !== -1) {
      finalProtectedText = protectedText.substring(0, terminalIndex);
      trailingProtected = protectedText.substring(terminalIndex);
    } else {
      // 文字の終わり。まだ開いている要素は、残りを中身として持ったまま、閉じないで終わる
      const remaining = protectedText.substring(cursor);
      if (remaining.length > 0) sink().push(remaining);
    }

    const restoredTree = this._restoreTree(tree, protectedContent);
    const finalText = this._restoreString(finalProtectedText, protectedContent);

    // 終端タグより後ろに現れたタグの名前（保護した部分＝コードブロック等の中は数えない）
    const trailingTags: string[] = [];
    const reTrail = new RegExp(Translator.PATTERN_TAG);
    let mt;
    while ((mt = reTrail.exec(trailingProtected)) !== null) {
      const startOrEmpty = mt[0].match(regexStart) || mt[0].match(regexEmpty);
      if (startOrEmpty && !trailingTags.includes(startOrEmpty[1])) trailingTags.push(startOrEmpty[1]);
    }

    return {
      tree: restoredTree,
      truncatedText: finalText,
      isTruncated: terminalIndex !== -1,
      terminalTag,
      trailingText: this._restoreString(trailingProtected, protectedContent),
      trailingTags,
    };
  }
  private _extractContent(content: LpmlNode[] | null): string {
    if (!content) return '';
    if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : '')).join('');
    return String(content);
  }

  private _sortActions(actions: ParsedAction[]): ParsedAction[] {
    return actions.sort((a, b) => {
      // 1. 制御系 (Interrupts) は強制的に一番後ろへ
      const isIntA = INTERRUPT_ACTION_TAGS.has(a.type);
      const isIntB = INTERRUPT_ACTION_TAGS.has(b.type);
      if (isIntA && !isIntB) return 1;
      if (!isIntA && isIntB) return -1;

      // 2. 両方が edit（旧名 edit_file）で、かつ対象パスが同じ場合のみ行番号の降順 (下から上)
      if (EDIT_TAGS.has(a.type) && EDIT_TAGS.has(b.type) && a.params.path === b.params.path) {
        const startA = parseInt(a.params.start || '0', 10);
        const startB = parseInt(b.params.start || '0', 10);
        if (startA !== startB) {
          return startB - startA;
        }
      }

      // 3. それ以外は LLM が出力した順番 (originalIndex) を維持する
      return a.originalIndex - b.originalIndex;
    });
  }
}
