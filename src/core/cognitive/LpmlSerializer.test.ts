/**
 * src/core/cognitive/LpmlSerializer.test.ts
 * Itera OS v2: <tool_output> の組み立て（T-0595）
 *
 * 背景:
 *   元のタグの属性を action / status の後ろにそのまま写していたので、
 *   action や status という名前の引数を持つタグ（schedule・tool_catalog・loom_list など）では
 *   `status="success" status="mine"` のように属性が重複し、どちらが結果か読めなかった。
 *   また値の `"` を `&quot;` にしていて、プロンプトの「エンティティを使うな」と食い違っていた。
 */

import { describe, it, expect } from 'vitest';
import { formatAttributeValue, serializeToolOutput } from './LpmlSerializer';
import { Translator } from './Translator';

/** 組み立てた <tool_output> を Translator で読み、属性を取り出す（内側は予約タグなので解釈されない） */
const attrsOf = (text: string) => {
  const node = new Translator().parse(text).find((a) => a.type === 'tool_output');
  if (!node) throw new Error('tool_output not parsed');
  const { content: _content, ...attrs } = node.params;
  return attrs;
};

describe('serializeToolOutput', () => {
  it('names the tool with `tool` and prefixes every echoed parameter with `param_`', () => {
    const text = serializeToolOutput({
      actionType: 'loom_list',
      params: { status: 'mine', limit: '20' },
      output: { log: '3 cards' },
    });
    expect(text).toBe(
      '<tool_output tool="loom_list" status="success" param_status="mine" param_limit="20">\n3 cards\n</tool_output>',
    );
  });

  it('never repeats an attribute, even when the tag has its own `tool`, `status` or `action`', () => {
    const text = serializeToolOutput({
      actionType: 'schedule',
      params: { action: 'list', status: 'x', tool: 'y' },
      output: { log: 'ok', error: true },
    });
    expect(attrsOf(text)).toEqual({
      tool: 'schedule',
      status: 'error',
      param_action: 'list',
      param_status: 'x',
      param_tool: 'y',
    });
  });

  it('writes a self-closing tag when there is no log', () => {
    expect(serializeToolOutput({ actionType: 'yield', output: {} })).toBe(
      '<tool_output tool="yield" status="success" />',
    );
  });
});

describe('formatAttributeValue', () => {
  const values = [
    'plain',
    '',
    'a "quoted" word',
    "it's",
    `both " and '`,
    '\\d+\\.md$',
    'ends with \\',
    '\\"',
    'line 1\nline 2',
    '<tag attr="v" />',
  ];

  it.each(values)('reads back to the same value through the parser: %j', (value) => {
    const tag = `<probe v=${formatAttributeValue(value)} />`;
    const action = new Translator().parse(tag).find((a) => a.type === 'probe');
    expect(action?.params.v).toBe(value);
  });

  it('does not use HTML entities', () => {
    for (const value of values) expect(formatAttributeValue(value)).not.toMatch(/&(quot|apos|lt|gt|amp);/);
  });

  it('writes the way the model is told to: double-escaped backslashes, single quotes around a double quote', () => {
    expect(formatAttributeValue('\\d')).toBe('"\\\\d"');
    expect(formatAttributeValue('say "hi"')).toBe(`'say "hi"'`);
    expect(formatAttributeValue(`" and '`)).toBe(`"\\" and '"`);
  });
});
