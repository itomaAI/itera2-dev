/**
 * src/shell/services/LpmlRenderer.ts
 * Itera OS v2: LPML (LLM-Prompting Markup Language) Renderer
 */

export class LpmlRenderer {
  constructor() {}

  /**
   * LPML文字列を表示用HTMLへ変換する。
   *
   * opts.streaming … 生成中かどうか。生成中は report/ask を開いたまま見せる。
   * 確定後は成果物枠（Iteraの発話）が別に描かれるため、原稿側は畳んで重複を避ける。
   */
  formatStream(text: string, opts: { streaming?: boolean } = {}): string {
    const escape = (str: string) => {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    };

    const TAG_NAME_PATTERN = '[a-zA-Z0-9_\\-]+';

    // 【重要】属性値には `<` `>` `&` が入りうる（例: search の query="() =&gt; x" や "a &amp;&amp; b"）。
    // escape() によりそれらは &lt; / &gt; / &amp; になるため、旧実装の `[^&]*` では
    // 属性の途中で走査が止まり、タグ全体がマッチ失敗して生テキストとして崩れて表示されていた。
    // そこで Translator.PATTERN_ATTRIBUTE と同じ「引用符を認識する」方式に変更する。
    // escape() は引用符( ' " )を変換しないため、この方式はエスケープ後の文字列でも正しく機能する。
    // 値なし属性 / 引用符なし属性も従来どおり許容する（後方互換）。
    const ATTR_PART = '\\s+[^"\'/=\\s]+(?:=(?:"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|[^\\s&]+))?';
    const ATTRS_PATTERN = `((?:${ATTR_PART})*\\s*)`;

    // キャプチャ位置は従来どおり: 1=タグ名 2=属性 3=内容 / 4=タグ名 5=属性
    const TAG_REGEX = new RegExp(
      `&lt;(${TAG_NAME_PATTERN})${ATTRS_PATTERN}&gt;([\\s\\S]*?)&lt;\\/\\1&gt;|` +
        `&lt;(${TAG_NAME_PATTERN})${ATTRS_PATTERN}\\/&gt;`,
      'g',
    );

    const safeText = escape(text);
    const parts: string[] = [];
    let lastIndex = 0;
    let match;

    while ((match = TAG_REGEX.exec(safeText)) !== null) {
      const gap = safeText.substring(lastIndex, match.index);
      if (gap && gap.trim().length > 0) {
        // タグ間のテキストは通常のmutedテキストとして扱う
        parts.push(`<span class="text-text-muted whitespace-pre-wrap">${gap}</span>`);
      }

      const tagName = match[1] || match[4];
      const attributes = match[2] || match[5] || '';
      const content = match[3] || '';

      parts.push(this._createTagHTML(tagName, attributes, content, opts.streaming === true));
      lastIndex = TAG_REGEX.lastIndex;
    }

    const remaining = safeText.substring(lastIndex);
    if (remaining && remaining.trim().length > 0) {
      parts.push(`<span class="text-text-muted whitespace-pre-wrap">${remaining}</span>`);
    }

    return parts.join('');
  }

  private _createTagHTML(tagName: string, attributes: string, content: string, streaming = false): string {
    // 機構レイヤ（LLM生出力・システムログ）の中では、タグ箱は中立の見た目にする。
    // 意味は絵文字が担っているため色は不要であり、色を残すと「沈めたはずの機構」が
    // かえって前に出てしまう。例外は error と syntax_warning だけ。
    const NEUTRAL = 'border-border-main bg-overlay/5';

    let title = tagName;
    let colorClass = NEUTRAL;
    let isOpen = false;

    // 旧実装の `([^"'\s]+)` は空白で切れるため path="my file.txt" が途中で欠けていた。
    // また前方境界が無く type= が mimetype= の一部にも誤マッチしていたため、両方を修正する。
    // なお attributes は escape() 済みなので、戻り値をそのまま innerHTML に埋めても安全。
    const getAttr = (key: string) => {
      const m = attributes.match(new RegExp(`(?:^|\\s)${key}=(?:"([^"]*)"|'([^']*)'|([^\\s]+))`));
      if (!m) return null;
      return m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
    };

    switch (tagName) {
      case 'thinking':
        title = '💭 thinking';
        break;
      case 'plan':
        title = '📅 plan';
        break;
      case 'report':
        title = '📢 report';
        // 生成中だけ開く。確定後は成果物枠に同じ本文が出るため畳んで重複を避ける。
        isOpen = streaming;
        break;
      case 'ask':
        title = '❓ ask';
        isOpen = streaming;
        break;
      case 'yield':
        title = '⏳ yield';
        break;
      case 'breathe':
        title = '💨 breathe';
        break;
      case 'finish':
        title = '✅ finish';
        break;
      case 'create_file':
      case 'edit_file':
        const path = getAttr('path') || 'file';
        title = `📝 ${tagName}: ${path}`;
        break;
      case 'error':
        // 例外1: エラーは色を残す
        title = '⚠️ Error';
        colorClass = 'border-tag-error bg-tag-error/10';
        isOpen = true;
        break;
      case 'tool_output':
        const actionName = getAttr('action') || 'unknown';
        const status = getAttr('status') || 'success';
        title = `📥 ${actionName}`;
        if (status === 'error') {
          // 例外2: 失敗したツール実行は色を残す
          colorClass = 'border-error bg-error/10';
          title = `⚠️ ${actionName} (error)`;
          isOpen = true;
        }
        break;
      case 'event':
        title = `🔔 ${getAttr('type') || 'unknown'}`;
        break;
      case 'system':
        const sysType = getAttr('type') || 'info';
        title = `💻 ${sysType}`;
        if (sysType === 'syntax_warning') {
          // 例外3: 記法違反の警告は色を残す
          colorClass = 'border-error bg-error/10';
          title = `🚨 LPML Syntax Warning`;
          isOpen = true;
        }
        break;
      default:
        title = `⚙️ ${tagName}`;
    }

    const openAttr = isOpen ? 'open' : '';

    // NOTE: このタグボックス（LLMの生ストリーム表示）は意図的に「未加工のテキスト」を
    // 見せる場所として扱う。Markdownテーブル変換やMathJaxによる数式整形は行わない
    // （ユーザー指示により2026-08-07に撤回。system側の再表示 _formatSystemMessage の
    // テーブル変換は維持する）。
    let displayContent = content.trim();

    // 属性がある場合は薄く表示
    if (attributes.trim()) {
      displayContent = `<div class="text-[0.625rem] text-tag-attr mb-1 border-b border-border-main pb-1 opacity-70">${attributes.trim()}</div>${displayContent}`;
    }

    // コンテンツがないタグ（自己完結タグ）の表示
    if (!displayContent) {
      return `<div class="text-xs font-mono py-1 px-2 rounded border ${colorClass} mb-2 inline-block opacity-80 text-text-main" title="&lt;${tagName} /&gt;">${title}</div>`;
    }

    // コンテンツがあるタグ
    return `
      <details ${openAttr} class="mb-2 rounded border ${colorClass} overflow-hidden group">
        <summary class="cursor-pointer py-1.5 px-2 text-xs font-mono font-bold text-text-main bg-overlay/5 hover:bg-overlay/10 select-none flex items-center gap-2 list-none [&::-webkit-details-marker]:hidden">
          <span class="group-open:rotate-90 transition-transform text-[0.625rem]">▶</span> ${title}
        </summary>
        <div class="p-2 text-xs font-mono overflow-x-auto bg-overlay/5 whitespace-pre-wrap text-tag-content">${displayContent}</div>
      </details>
    `.trim();
  }
}
