/**
 * src/core/cognitive/Translator.ts
 * Itera OS v2: LPML (LLM-Prompting Markup Language) Parser
 */

export interface ParsedAction {
  type: string;
  params: Record<string, string>;
  raw: any;
  originalIndex: number;
}

export interface ParseResult extends Array<ParsedAction> {
  hasLeak: boolean;
  truncatedText: string;
  isTruncated: boolean;
}

export class Translator {
  static PATTERN_ATTRIBUTE =
    /\s+([^"'/<>=\s]+)=(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
  static ATTR_PART_NO_CAPTURE =
    "\\s+[^\"'/<>=\\s]+=(?:\"(?:[^\"\\\\]|\\\\.)*\"|'(?:[^'\\\\]|\\\\.)*')";
  static PATTERN_TAG_START =
    "<([^/>\\s\\n]+)((?:" + Translator.ATTR_PART_NO_CAPTURE + ")*)\\s*>";
  static PATTERN_TAG_END = "</([^/>\\s\\n]+)\\s*>";
  static PATTERN_TAG_EMPTY =
    "<([^/>\\s\\n]+)((?:" + Translator.ATTR_PART_NO_CAPTURE + ")*)\\s*/>";
  static PATTERN_TAG = new RegExp(
    `(${Translator.PATTERN_TAG_START})|(${Translator.PATTERN_TAG_END})|(${Translator.PATTERN_TAG_EMPTY})`,
    "g",
  );
  static PATTERN_PROTECT =
    /(^ *```[^\n]*\n[\s\S]*?\n *```|`[^`\n]*`|<!--[\s\S]*?-->|<![\s\S]*?>)/gm;

  private defaultExcludeTags: string[];

  constructor() {
    this.defaultExcludeTags = [
      "create_file",
      "edit_file",
      "thinking",
      "plan",
      "report",
      "ask",
      "user_input",
      "user_attachment",
      "inject_js",
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
    const cleanedText = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1");

    const exclude = [...this.defaultExcludeTags, ...additionalExcludeTags];
    const { tree, truncatedText, isTruncated } = this._parseToTree(
      cleanedText,
      exclude,
    );

    // 1. ツリーのルートレベルに残っている「どのタグにも属さない生テキスト」を結合
    let leakedText = "";
    for (const node of tree) {
      if (typeof node === "string") {
        leakedText += node;
      }
    }

    // 空白文字（改行、スペース）を除去し、有意な長さ（例：3文字以上）があれば漏洩と判定
    const cleanLeak = leakedText.replace(/\s+/g, "");
    const hasLeak = cleanLeak.length >= 3;

    // 2. ツリーのルートだけでなく、再帰的にすべてのタグノードを抽出する
    let rawActions = this._extractAllNodes(tree);

    const actions: ParsedAction[] = [];
    for (let i = 0; i < rawActions.length; i++) {
      const item = rawActions[i];
      const contentText = this._extractContent(item.content);
      const action: ParsedAction = {
        type: item.tag,
        params: {
          ...item.attributes,
          content: contentText,
        },
        raw: item,
        originalIndex: i, // ★ 元のテキスト内での出現順序を記録
      };
      actions.push(action);
    }

    const sortedActions = this._sortActions(actions);

    // 配列オブジェクト自身にプロパティとしてフラグとテキストを付与
    const result = sortedActions as ParseResult;
    result.hasLeak = hasLeak;
    result.truncatedText = truncatedText;
    result.isTruncated = isTruncated;

    return result;
  }

  /**
   * ASTを再帰的に走査し、すべてのタグオブジェクトをフラットな配列として抽出する
   */
  private _extractAllNodes(nodes: any[]): any[] {
    let result: any[] = [];
    if (!Array.isArray(nodes)) return result;

    for (const node of nodes) {
      if (typeof node === "object" && node !== null) {
        // タグオブジェクト自身をリストに追加
        result.push(node);
        // 子要素（content）がある場合は再帰的に走査して結果を結合
        if (Array.isArray(node.content)) {
          result = result.concat(this._extractAllNodes(node.content));
        }
      }
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
        value = value.replace(/\\(.)/g, "$1");
      }
      attributes[key] = value || "";
    }
    return attributes;
  }

  private _restoreString(
    text: string,
    protectedMap: Record<string, string>,
  ): string {
    if (!text.includes("__PROTECTED_")) return text;
    let result = text;
    for (const [placeholder, original] of Object.entries(protectedMap)) {
      result = result.replace(placeholder, () => original);
    }
    return result;
  }

  private _restoreTree(
    tree: any[],
    protectedMap: Record<string, string>,
  ): any[] {
    return tree.map((item) => {
      if (typeof item === "string")
        return this._restoreString(item, protectedMap);
      if (item.attributes) {
        for (const k in item.attributes) {
          item.attributes[k] = this._restoreString(
            item.attributes[k],
            protectedMap,
          );
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
  ): { tree: any[]; truncatedText: string; isTruncated: boolean } {
    const protectedContent: Record<string, string> = {};
    const protectedText = text.replace(Translator.PATTERN_PROTECT, (match) => {
      const placeholder = `__PROTECTED_${Math.random().toString(36).substring(2, 15)}__`;
      protectedContent[placeholder] = match;
      return placeholder;
    });

    const tree: any[] = [];
    let cursor = 0;
    let tagExclude: string | null = null;
    let stack: any[] = [
      {
        tag: "root",
        content: tree,
      },
    ];

    const regexTag = new RegExp(Translator.PATTERN_TAG);
    let match;
    const regexStart = new RegExp("^" + Translator.PATTERN_TAG_START + "$");
    const regexEnd = new RegExp("^" + Translator.PATTERN_TAG_END + "$");
    const regexEmpty = new RegExp("^" + Translator.PATTERN_TAG_EMPTY + "$");

    let terminalIndex = -1;

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
      if (contentStr.length > 0)
        stack[stack.length - 1].content.push(contentStr);
      cursor = indTagEnd;

      if (matchTagStart) {
        const name = matchTagStart[1];
        if (exclude.includes(name)) tagExclude = name;
        const el = {
          tag: name,
          attributes: this._parseAttributes(matchTagStart[2]),
          content: [] as any[],
        };
        stack[stack.length - 1].content.push(el);
        stack.push(el);
      } else if (matchTagEmpty) {
        const name = matchTagEmpty[1];
        const el = {
          tag: name,
          attributes: this._parseAttributes(matchTagEmpty[2]),
          content: null,
        };
        stack[stack.length - 1].content.push(el);

        // ★ Terminal Tag Detection (Empty Tag)
        if (
          ["yield", "breathe", "ask", "finish"].includes(name) &&
          tagExclude === null &&
          stack.length === 1
        ) {
          terminalIndex = indTagEnd;
          break;
        }
      } else if (matchTagEnd) {
        const name = matchTagEnd[1];
        let idx = stack.length - 1;
        while (idx > 0 && stack[idx].tag !== name) idx--;
        if (idx > 0) stack = stack.slice(0, idx);
        else stack[stack.length - 1].content.push(tagStr);

        // ★ Terminal Tag Detection (End Tag)
        if (
          ["yield", "breathe", "ask", "finish"].includes(name) &&
          tagExclude === null &&
          stack.length === 1
        ) {
          terminalIndex = indTagEnd;
          break;
        }
      }
    }

    let finalProtectedText = protectedText;
    if (terminalIndex !== -1) {
      finalProtectedText = protectedText.substring(0, terminalIndex);
    } else {
      const remaining = protectedText.substring(cursor);
      if (remaining.length > 0) stack[stack.length - 1].content.push(remaining);
    }

    const restoredTree = this._restoreTree(tree, protectedContent);
    const finalText = this._restoreString(finalProtectedText, protectedContent);

    return {
      tree: restoredTree,
      truncatedText: finalText,
      isTruncated: terminalIndex !== -1,
    };
  }

  private _extractContent(content: any): string {
    if (!content) return "";
    if (Array.isArray(content))
      return content.map((c) => (typeof c === "string" ? c : "")).join("");
    return String(content);
  }

  private _sortActions(actions: ParsedAction[]): ParsedAction[] {
    const edits = actions.filter((a) => a.type === "edit_file");
    const others = actions.filter((a) => a.type !== "edit_file");
    const interrupts = others.filter((a) =>
      ["ask", "finish", "breathe"].includes(a.type),
    );
    const normalTools = others.filter(
      (a) => !["ask", "finish", "breathe"].includes(a.type),
    );

    edits.sort((a, b) => {
      const pathA = a.params.path || "";
      const pathB = b.params.path || "";
      if (pathA !== pathB) return pathA.localeCompare(pathB);
      const startA = parseInt(a.params.start || "0", 10);
      const startB = parseInt(b.params.start || "0", 10);
      return startB - startA;
    });

    return [...normalTools, ...edits, ...interrupts];
  }
}
