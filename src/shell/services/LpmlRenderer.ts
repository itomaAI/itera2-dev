/**
 * src/shell/services/LpmlRenderer.ts
 * Itera OS v2: LPML (LLM-Prompting Markup Language) Renderer
 */

export class LpmlRenderer {
  constructor() {}

  formatStream(text: string): string {
    const escape = (str: string) => {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    };

    const TAG_NAME_PATTERN = '[a-zA-Z0-9_\\-]+';
    const TAG_REGEX = new RegExp(
      `&lt;(${TAG_NAME_PATTERN})([^&]*)&gt;([\\s\\S]*?)&lt;\\/\\1&gt;|` + `&lt;(${TAG_NAME_PATTERN})([^&]*)\\/&gt;`,
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

      parts.push(this._createTagHTML(tagName, attributes, content));
      lastIndex = TAG_REGEX.lastIndex;
    }

    const remaining = safeText.substring(lastIndex);
    if (remaining && remaining.trim().length > 0) {
      parts.push(`<span class="text-text-muted whitespace-pre-wrap">${remaining}</span>`);
    }

    return parts.join('');
  }

  private _createTagHTML(tagName: string, attributes: string, content: string): string {
    let title = tagName;
    let colorClass = 'border-border-main bg-card';
    let isOpen = false;

    const getAttr = (key: string) => {
      const m = attributes.match(new RegExp(`${key}=["']?([^"'\\s]+)["']?`));
      return m ? m[1] : null;
    };

    switch (tagName) {
      case 'thinking':
        title = '💭 Thinking';
        colorClass = 'border-tag-thinking bg-tag-thinking/10';
        break;
      case 'plan':
        title = '📅 Plan';
        colorClass = 'border-tag-plan bg-tag-plan/10';
        break;
      case 'report':
        title = '📢 Report';
        colorClass = 'border-tag-report bg-tag-report/20';
        isOpen = true;
        break;
      case 'ask':
        title = '❓ Question';
        colorClass = 'border-tag-report bg-tag-report/20';
        isOpen = true;
        break;
      case 'yield':
        title = '⏳ Waiting for System...';
        colorClass = 'border-border-main bg-card/50';
        break;
      case 'breathe':
        title = '💨 Taking a breath...';
        colorClass = 'border-border-main bg-card/50';
        break;
      case 'finish':
        title = '✅ Standby';
        colorClass = 'border-success bg-success/20';
        isOpen = true;
        break;
      case 'create_file':
      case 'edit_file':
        const path = getAttr('path') || 'file';
        title = `📝 ${tagName}: ${path}`;
        colorClass = 'border-warning bg-warning/10';
        break;
      case 'error':
        title = '⚠️ Error';
        colorClass = 'border-tag-error bg-tag-error/10';
        isOpen = true;
        break;
      case 'tool_output':
        const actionName = getAttr('action') || 'unknown';
        const status = getAttr('status') || 'success';
        title = `📥 System Output: [${actionName}]`;
        if (status === 'error') {
          colorClass = 'border-error bg-error/10';
          title = `⚠️ System Error: [${actionName}]`;
          isOpen = true;
        } else {
          colorClass = 'border-border-main bg-panel/80';
          isOpen = false;
        }
        break;
      case 'event':
        const eventType = getAttr('type') || 'unknown';
        title = `🔔 Event: ${eventType}`;
        colorClass = 'border-primary bg-primary/10';
        isOpen = false;
        break;
      case 'system':
        const sysType = getAttr('type') || 'info';
        title = `💻 System: ${sysType}`;
        if (sysType === 'syntax_warning') {
          colorClass = 'border-error bg-error/10';
          title = `🚨 System Warning: LPML Syntax`;
          isOpen = true;
        } else {
          colorClass = 'border-system bg-system/10';
          isOpen = false;
        }
        break;
      default:
        title = `⚙️ ${tagName}`;
        colorClass = 'border-border-main bg-card/50';
    }

    const openAttr = isOpen ? 'open' : '';
    let displayContent = content.trim();

    // 属性がある場合は薄く表示
    if (attributes.trim()) {
      displayContent = `<div class="text-[10px] text-tag-attr mb-1 border-b border-border-main pb-1 opacity-70">${attributes.trim()}</div>${displayContent}`;
    }

    // コンテンツがないタグ（自己完結タグ）の表示
    if (!displayContent) {
      return `<div class="text-xs font-mono py-1 px-2 rounded border ${colorClass} mb-2 inline-block opacity-80 text-text-main" title="&lt;${tagName} /&gt;">${title}</div>`;
    }

    // コンテンツがあるタグ
    return `
      <details ${openAttr} class="mb-2 rounded border ${colorClass} overflow-hidden group">
        <summary class="cursor-pointer py-1.5 px-2 text-xs font-mono font-bold text-text-main bg-overlay/5 hover:bg-overlay/10 select-none flex items-center gap-2 list-none [&::-webkit-details-marker]:hidden">
          <span class="group-open:rotate-90 transition-transform text-[10px]">▶</span> ${title}
        </summary>
        <div class="p-2 text-xs font-mono overflow-x-auto bg-overlay/5 whitespace-pre-wrap text-tag-content">${displayContent}</div>
      </details>
    `.trim();
  }
}
