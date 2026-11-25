/**
 * src/shell/services/LpmlRenderer.ts
 * Itera OS v2: LPML (LLM-Prompting Markup Language) Renderer
 */

import { toolIcon } from '../../core/control/toolIcons';

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

    // 3 つの形。上から順に当てる:
    //   1. 中身を丸ごと CDATA で包んだ要素（T-0881。Translator と同じ読み方: 終わりは「CDATA の閉じ＋自分の閉じタグ」）
    //   2. 開始タグ 〜 最初の同名の閉じタグ
    //   3. 空タグ
    const TAG_REGEX = new RegExp(
      `&lt;(?<wName>${TAG_NAME_PATTERN})(?<wAttrs>${ATTRS_PATTERN})&gt;\\s*&lt;!\\[CDATA\\[(?<wBody>[\\s\\S]*?)\\]\\]&gt;\\s*&lt;\\/\\k<wName>&gt;|` +
        `&lt;(?<name>${TAG_NAME_PATTERN})(?<attrs>${ATTRS_PATTERN})&gt;(?<body>[\\s\\S]*?)&lt;\\/\\k<name>&gt;|` +
        `&lt;(?<eName>${TAG_NAME_PATTERN})(?<eAttrs>${ATTRS_PATTERN})\\/&gt;`,
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

      const g = match.groups ?? {};
      const tagName = g.wName ?? g.name ?? g.eName;
      const attributes = g.wAttrs ?? g.attrs ?? g.eAttrs ?? '';
      // 丸ごとの包みは、包みを外した中身を見せる
      const content = g.wBody ?? g.body ?? '';

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
    // かえって前に出てしまう。色の例外は error と syntax_warning だけ。
    // 開いて出す例外は error と <event type="command"> だけ（syntax_warning は色を残して畳む。T-0916）。
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

    // 見出しは「記号 タグ名: 対象」。記号は SYSTEM 側のログと同じ（toolIcons.ts）。
    // 対象（パス・検索語・pid）は属性から 1 つだけ取り、見出しで何に触ったかが分かるようにする。
    const subjectOf = (): string | null => {
      switch (tagName) {
        case 'read':
        case 'read_file': {
          const path = getAttr('path');
          if (!path) return null;
          const start = getAttr('start');
          const end = getAttr('end');
          const range = start || end ? ` [${start ?? ''}..${end ?? ''}]` : '';
          return path + range;
        }
        case 'attach_file':
        case 'write':
        case 'edit':
        case 'create_file':
        case 'edit_file':
        case 'file_info':
        case 'delete_file':
        case 'restore_file':
        case 'copy_file':
        case 'open':
        case 'spawn':
          return getAttr('path');
        case 'move_file': {
          const from = getAttr('path');
          const to = getAttr('new_path');
          return from ? (to ? `${from} → ${to}` : from) : null;
        }
        case 'list_files':
          return getAttr('path') ?? '/';
        case 'search': {
          const q = getAttr('query');
          return q ? `"${q}"` : null;
        }
        case 'kill':
        case 'inject_js':
        case 'take_screenshot':
          return getAttr('pid');
        case 'set_timer': {
          const d = getAttr('delay');
          return d ? `${d}s` : null;
        }
        default:
          return null;
      }
    };

    switch (tagName) {
      case 'report':
      case 'ask':
        // 生成中だけ開く。確定後は成果物枠に同じ本文が出るため畳んで重複を避ける。
        isOpen = streaming;
        break;
      case 'error':
        // 例外1: エラーは色を残す
        colorClass = 'border-tag-error bg-tag-error/10';
        isOpen = true;
        break;
      // tool_output には case を置かない（T-0593）。
      // 本物のツール結果は履歴に配列（output.ui）として入り、ChatPanel が ui の 1 行で描く。
      // `<tool_output>` という文字列は、モデルに渡す文脈を組むとき（LpmlSerializer）にしか作られない。
      // したがってここに来るのは、モデルが偽装したものか、文字列で残った古い履歴だけである。
      // 以前は action 属性を見出しにしていた（「📥 get_time」）ため、偽装が本物の結果と同じ見た目になった。
      // いまは未登録のタグと同じく「⚙️ tool_output」と描き、属性は下の行にそのまま出す。
      case 'event': {
        // 例外2: スラッシュコマンドの結果は利用者が見るために置いたもの（T-0634）。畳まずに出す
        if ((getAttr('type') || 'unknown') === 'command') isOpen = true;
        break;
      }
      case 'system':
        if ((getAttr('type') || 'info') === 'syntax_warning') {
          // 例外3: 記法違反の警告は色を残す。開き方はほかの system と同じく畳む（T-0916）。
          // 中身はモデルに宛てた長い文なので、利用者には赤い題（🚨 LPML Syntax Warning）だけで足りる
          colorClass = 'border-error bg-error/10';
        }
        break;
      default:
        break;
    }

    if (tagName === 'error') {
      title = '⚠️ Error';
    } else if (tagName === 'event') {
      title = `🔔 ${getAttr('type') || 'unknown'}`;
    } else if (tagName === 'system') {
      const sysType = getAttr('type') || 'info';
      title = sysType === 'syntax_warning' ? '🚨 LPML Syntax Warning' : `💻 ${sysType}`;
    } else {
      const subject = subjectOf();
      title = `${toolIcon(tagName)} ${tagName}${subject ? `: ${subject}` : ''}`;
    }

    const openAttr = isOpen ? 'open' : '';

    // NOTE: このタグボックス（LLMの生ストリーム表示）は意図的に「未加工のテキスト」を
    // 見せる場所として扱う。Markdownテーブル変換やMathJaxによる数式整形は行わない
    // （ユーザー指示により2026-08-07に撤回。system側の再表示 _formatSystemMessage の
    // テーブル変換は維持する）。
    let displayContent = content.trim();

    // 【重要】ここでは書体と寸法を指定しない。
    //
    // このタグボックスは機構レイヤ（.chat-system-message）の中に描かれる。
    // 書体と寸法は外観設定（System Output Font / Size）から CSS 変数経由で
    // 入るため、font-mono や text-xs を書くとその設定が効かなくなる。
    // 機構レイヤに見えているものはほぼ全てこのタグボックスなので、
    // ここを固定すると設定そのものが機能しなくなる。
    //
    // 寸法を変えたい場合だけ em（本文に対する比）で書くこと。rem は不可。

    // 属性がある場合は薄く表示
    if (attributes.trim()) {
      displayContent = `<div class="text-[0.833em] text-tag-attr mb-1 border-b border-border-main pb-1 opacity-70">${attributes.trim()}</div>${displayContent}`;
    }

    // コンテンツがないタグ（自己完結タグ）の表示
    if (!displayContent) {
      return `<div class="py-1 px-2 rounded border ${colorClass} mb-2 inline-block opacity-80 text-text-main" title="&lt;${tagName} /&gt;">${title}</div>`;
    }

    // コンテンツがあるタグ
    return `
      <details ${openAttr} class="mb-2 rounded border ${colorClass} overflow-hidden group">
        <summary class="cursor-pointer py-1.5 px-2 font-bold text-text-main bg-overlay/5 hover:bg-overlay/10 select-none flex items-center gap-2 list-none [&::-webkit-details-marker]:hidden">
          <span class="group-open:rotate-90 transition-transform text-[0.833em]">▶</span> ${title}
        </summary>
        <div class="p-2 overflow-x-auto bg-overlay/5 whitespace-pre-wrap text-tag-content">${displayContent}</div>
      </details>
    `.trim();
  }
}
