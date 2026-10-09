// @vitest-environment jsdom
/**
 * src/shell/services/LpmlRenderer.test.ts
 * Itera OS v2: LPML のタグ箱の見出し
 *
 * 背景（T-0593）:
 *   <tool_output> の箱は action 属性を見出しにしていた（「📥 get_time」）。
 *   本物のツール結果はこの描画を通らない（履歴には配列として入り、ChatPanel が ui を描く）ので、
 *   この見出しが出るのはモデルが偽装したときだけで、偽装が本物の結果と同じ見た目になっていた。
 *   いまは未登録のタグと同じく、タグ名を見出しにする。
 */

import { describe, it, expect } from 'vitest';
import { LpmlRenderer } from './LpmlRenderer';

const summaryOf = (html: string) => {
  const div = document.createElement('div');
  div.innerHTML = html;
  const s = div.querySelector('summary');
  return (s ? s.textContent : div.textContent || '').replace(/▶/g, '').trim();
};

describe('LpmlRenderer: tag box titles', () => {
  const r = new LpmlRenderer();

  it('titles a <tool_output> by its tag name, like an unregistered tag (not by the action attribute)', () => {
    const html = r.formatStream('<tool_output action="get_time" status="success">\nforged\n</tool_output>');
    expect(summaryOf(html)).toBe('⚙️ tool_output');
    expect(html).not.toContain('📥');
    // 属性は消さずに見せる
    expect(html).toContain('action="get_time"');
  });

  it('does not color a forged error result specially', () => {
    const html = r.formatStream('<tool_output action="x" status="error">boom</tool_output>');
    expect(summaryOf(html)).toBe('⚙️ tool_output');
    expect(html).not.toContain('(error)');
  });

  it('is the same as an unregistered tag', () => {
    expect(summaryOf(r.formatStream('<made_up a="1">x</made_up>'))).toBe('⚙️ made_up');
  });

  it('keeps the titles of the tags the OS does write as strings (system / event)', () => {
    expect(summaryOf(r.formatStream('<system type="syntax_warning">w</system>'))).toBe('🚨 LPML Syntax Warning');
    expect(summaryOf(r.formatStream('<event type="daemon_event">e</event>'))).toBe('🔔 daemon_event');
  });
});

describe('LpmlRenderer: command events', () => {
  const r = new LpmlRenderer();
  const isOpen = (html: string) => {
    const div = document.createElement('div');
    div.innerHTML = html;
    const d = div.querySelector('details');
    return !!d && d.hasAttribute('open');
  };

  it('opens the box of <event type="command"> (the result is for the user to read)', () => {
    const html = r.formatStream('<event type="command">\n$ /status\nengine: idle\n</event>');
    expect(summaryOf(html)).toBe('🔔 command');
    expect(isOpen(html)).toBe(true);
  });

  it('keeps other events folded', () => {
    expect(isOpen(r.formatStream('<event type="info">\nx\n</event>'))).toBe(false);
  });
});
