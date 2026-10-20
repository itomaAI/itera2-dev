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

describe('LpmlRenderer: system tools have their own icons (the same as the SYSTEM side)', () => {
  const r = new LpmlRenderer();

  it('titles read / write / edit with the icon and the path', () => {
    expect(summaryOf(r.formatStream('<read path="memory/init.md" />'))).toBe('📖 read: memory/init.md');
    expect(summaryOf(r.formatStream('<read path="a.md" start="-50" />'))).toBe('📖 read: a.md [-50..]');
    expect(summaryOf(r.formatStream('<write path="x.txt">hi</write>'))).toBe('📝 write: x.txt');
    expect(summaryOf(r.formatStream('<edit path="x.txt">s</edit>'))).toBe('✏️ edit: x.txt');
    expect(summaryOf(r.formatStream('<read_file path="a.md" />'))).toBe('📖 read_file: a.md');
  });

  it('titles the other system tools (no more bare gears)', () => {
    expect(summaryOf(r.formatStream('<list_files path="data" />'))).toBe('📂 list_files: data');
    expect(summaryOf(r.formatStream('<list_files />'))).toBe('📂 list_files: /');
    expect(summaryOf(r.formatStream('<search query="foo bar" path="memory" />'))).toBe('🔍 search: "foo bar"');
    expect(summaryOf(r.formatStream('<attach_file path="a.pdf" />'))).toBe('📎 attach_file: a.pdf');
    expect(summaryOf(r.formatStream('<move_file path="a" new_path="b" />'))).toBe('🚚 move_file: a → b');
    expect(summaryOf(r.formatStream('<spawn path="apps/x.html" />'))).toBe('🚀 spawn: apps/x.html');
    expect(summaryOf(r.formatStream('<kill pid="x" />'))).toBe('🛑 kill: x');
    expect(summaryOf(r.formatStream('<get_time />'))).toBe('🕒 get_time');
    expect(summaryOf(r.formatStream('<set_timer delay="30" />'))).toBe('⏱️ set_timer: 30s');
    expect(summaryOf(r.formatStream('<ps />'))).toBe('📊 ps');
  });

  it('keeps the gear for tags it does not know (dynamic guest tools)', () => {
    expect(summaryOf(r.formatStream('<loom_list status="mine" />'))).toBe('⚙️ loom_list');
  });
});
