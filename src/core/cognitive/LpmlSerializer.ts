/**
 * Minimal serializer for LPML fragments emitted into model context.
 *
 * Output formatting intentionally matches the existing Projector behavior.
 */

import type { ToolExecutionEntry } from '../types/tools';

/**
 * <tool_output> に写す元のタグの属性に付ける接頭辞。
 * 元のタグの属性名は自由なので（schedule の action、loom_* の status など）、そのまま写すと
 * システムの属性（tool / status）と同じ名前になり、属性が重複していた（T-0595）。
 * 接頭辞を付ければ、引数がどんな名前でもシステムの属性とは重ならない。
 */
export const TOOL_OUTPUT_PARAM_PREFIX = 'param_';

export function wrapUserInput(text: string): string {
  return `<user_input>\n${text}\n</user_input>`;
}

/**
 * 属性値を LPML の書き方で書く（引用符まで含めて返す）。
 *
 * Translator._parseAttributes の逆写しにしてある。読む側は `\x` を `x` に 1 段剥がすので、
 * `\` と囲みの引用符をバックスラッシュで守れば、読み戻したとき元の値に戻る。
 * モデルにとっては「自分が書いた形」に近くなる（システムプロンプトは正規表現の `\\d` を教えている）。
 * 値に `"` があって `'` が無ければ、単引用符で囲む（エスケープが要らない。モデルもそう書いたはず）。
 *
 * HTML エンティティ（&quot;）は使わない。プロンプトが「エンティティを使うな」と教えているので、
 * 文脈に `&quot;` を見せると教えと食い違う。
 */
export function formatAttributeValue(value: string): string {
  const quote = value.includes('"') && !value.includes("'") ? "'" : '"';
  const escaped = value.replace(/\\/g, '\\\\').split(quote).join(`\\${quote}`);
  return `${quote}${escaped}${quote}`;
}

export function serializeToolOutput(entry: ToolExecutionEntry): string {
  const toolName = entry.actionType || 'unknown';
  const status = entry.output.error ? 'error' : 'success';
  let attrStr = `tool="${toolName}" status="${status}"`;

  if (entry.params) {
    for (const [key, value] of Object.entries(entry.params)) {
      attrStr += ` ${TOOL_OUTPUT_PARAM_PREFIX}${key}=${formatAttributeValue(String(value))}`;
    }
  }

  const logContent = entry.output.log ? entry.output.log.trim() : '';
  return logContent ? `<tool_output ${attrStr}>\n${logContent}\n</tool_output>` : `<tool_output ${attrStr} />`;
}
