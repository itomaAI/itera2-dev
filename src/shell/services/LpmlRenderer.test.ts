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

describe('LpmlRenderer: the LPML syntax warning (T-0916)', () => {
  // 警告の中身はモデルに宛てた長い文。利用者には赤い題だけ見えればよいので、ほかの system と同じく畳む
  const r = new LpmlRenderer();
  const details = (html: string) => {
    const div = document.createElement('div');
    div.innerHTML = html;
    return div.querySelector('details');
  };

  it('is folded, like the other system tags', () => {
    const d = details(r.formatStream('<system type="syntax_warning">\nText outside tags.\n</system>'));
    expect(d).not.toBeNull();
    expect(d!.hasAttribute('open')).toBe(false);
    expect(details(r.formatStream('<system type="info">\nx\n</system>'))!.hasAttribute('open')).toBe(false);
  });

  it('keeps its red color and its title', () => {
    const html = r.formatStream('<system type="syntax_warning">w</system>');
    expect(summaryOf(html)).toBe('🚨 LPML Syntax Warning');
    expect(details(html)!.className).toContain('border-error');
    // ほかの system は中立の色のまま
    expect(details(r.formatStream('<system type="info">x</system>'))!.className).not.toContain('border-error');
  });

  it('still opens an <error> box', () => {
    expect(details(r.formatStream('<error>\nboom\n</error>'))!.hasAttribute('open')).toBe(true);
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
describe('LpmlRenderer: 中身を丸ごと CDATA で包んだ要素（T-0881）', () => {
  // 箱の切り方を Translator の読み方に合わせる。合わせないと、中身に自分の閉じタグの字面を持つ要素が
  // そこで箱を閉じ、後ろが別の箱や素の文字として描かれる。
  // CDATA の印と閉じタグの字面は、部品から組み立てる。
  const r = new LpmlRenderer();
  const OPEN = '<!' + '[CDATA[';
  const CLOSE = ']]' + '>';
  const END = (tag: string) => '</' + tag + '>';
  const dom = (html: string) => {
    const div = document.createElement('div');
    div.innerHTML = html;
    return div;
  };

  it('箱は 1 つ。中身は包みを外した字で、閉じタグの字面も中に入る', () => {
    const body = "const s = '" + END('write') + '\';\n<delete_file path="x" />';
    const d = dom(r.formatStream('<write path="s.js">' + OPEN + body + CLOSE + END('write') + '\n<yield />'));
    expect(d.querySelectorAll('details')).toHaveLength(1);
    expect(summaryOf(d.innerHTML)).toBe('📝 write: s.js');
    const shown = d.querySelector('details > div:last-child')!.textContent!;
    expect(shown).toContain(body);
    expect(shown).not.toContain(OPEN);
    expect(shown).not.toContain(CLOSE);
    // 後ろの yield は別の（中身の無い）箱。素の文字は残らない
    expect(d.textContent).toContain('yield');
    expect(d.querySelector('span.text-text-muted')).toBeNull();
  });

  it('開始タグと開きの間・閉じと閉じタグの間の空白を許す', () => {
    const d = dom(r.formatStream('<write path="a.txt">\n' + OPEN + 'hello' + CLOSE + '\n' + END('write')));
    expect(d.querySelectorAll('details')).toHaveLength(1);
    expect(d.querySelector('details > div:last-child')!.textContent).toContain('hello');
  });

  it('包みでない要素の描き方は変わらない（途中の CDATA は印ごと見せる）', () => {
    const body = '<title>' + OPEN + 'A' + CLOSE + '</title>';
    const d = dom(r.formatStream('<write path="feed.xml">' + body + END('write')));
    expect(d.querySelectorAll('details')).toHaveLength(1);
    expect(d.querySelector('details > div:last-child')!.textContent).toContain(body);
  });
});
