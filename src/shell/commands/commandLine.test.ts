import { describe, it, expect } from 'vitest';
import { parseCommandLine, helpText, commandEventText } from './commandLine';

const known = (n: string) => ['status', 'reset', 'open'].includes(n);

describe('チャット欄のコマンドの構文', () => {
  it('登録された名前で始まる文だけがコマンド', () => {
    expect(parseCommandLine('/status', known)).toEqual({ kind: 'command', name: 'status', args: [], rest: '' });
    expect(parseCommandLine('  /STATUS  ', known)).toMatchObject({ kind: 'command', name: 'status' });
    expect(parseCommandLine('/tmp/x を見て', known)).toEqual({ kind: 'text', text: '/tmp/x を見て' });
    expect(parseCommandLine('/satus', known)).toEqual({ kind: 'text', text: '/satus' });
    expect(parseCommandLine('status', known)).toEqual({ kind: 'text', text: 'status' });
  });
  it('引数は空白区切り、rest は後ろ全部', () => {
    expect(parseCommandLine('/open  a/b.md  c', known)).toEqual({
      kind: 'command',
      name: 'open',
      args: ['a/b.md', 'c'],
      rest: 'a/b.md  c',
    });
    expect(parseCommandLine('/reset T-0633 を見張る\n2 行目', known)).toMatchObject({
      name: 'reset',
      rest: 'T-0633 を見張る\n2 行目',
    });
  });
  it('// は 1 文字落として通常の発言', () => {
    expect(parseCommandLine('//status', known)).toEqual({ kind: 'text', text: '/status' });
  });
  it('名前の途中に記号があるものは発言（パスの書き出しを壊さない）', () => {
    expect(parseCommandLine('/status.txt を開いて', known)).toMatchObject({ kind: 'text' });
  });
});

describe('help と記録', () => {
  const specs = [
    { name: 'status', usage: '/status', summary: 'Engine and context' },
    { name: 'open', usage: '/open <path>', summary: 'Open a path' },
  ];
  it('一覧は名前順で揃える。1 つなら usage と要約', () => {
    const t = helpText(specs);
    expect(t.split('\n').slice(1)).toEqual(['/open <path>  Open a path', '/status       Engine and context']);
    expect(helpText(specs, 'STATUS')).toBe('/status\n  Engine and context');
    expect(helpText(specs, 'nope')).toBe('Unknown command: /nope');
  });
  it('記録は event と $ 行。失敗は [Error]', () => {
    expect(commandEventText('/ps', { ok: true, text: 'a' })).toBe('<event type="command">\n$ /ps\na\n</event>');
    expect(commandEventText('/open x', { ok: false, text: 'no' })).toContain('[Error] no');
  });
});
