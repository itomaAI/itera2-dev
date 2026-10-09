/**
 * src/shell/commands/commandLine.ts
 * チャット欄のコマンド（T-0634）— 構文の規則。純関数だけ。
 *
 * 文の先頭が `/名前` で、その名前が登録されているときだけコマンド。登録に無ければ通常の発言
 * （`/tmp/x を見て` のような書き出しを壊さない）。`//` で始めると 1 文字落として通常の発言にする。
 */

export interface ParsedCommand {
  kind: 'command';
  name: string;
  /** 空白区切りの引数 */
  args: string[];
  /** 名前の後ろ全部（前後の空白を除く） */
  rest: string;
}

export type ParsedLine = ParsedCommand | { kind: 'text'; text: string };

const HEAD = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i;

export function parseCommandLine(text: string, isKnown: (name: string) => boolean): ParsedLine {
  const trimmed = (text || '').trim();
  if (trimmed.startsWith('//')) return { kind: 'text', text: trimmed.slice(1) };
  const m = trimmed.match(HEAD);
  if (!m) return { kind: 'text', text };
  const name = m[1].toLowerCase();
  if (!isKnown(name)) return { kind: 'text', text };
  const rest = (m[2] || '').trim();
  return { kind: 'command', name, args: rest ? rest.split(/\s+/) : [], rest };
}

export interface CommandSpec {
  name: string;
  usage: string;
  summary: string;
}

/** `/help` の文面（名前順） */
export function helpText(specs: CommandSpec[], name?: string): string {
  if (name) {
    const s = specs.find((c) => c.name === name.toLowerCase());
    if (!s) return `Unknown command: /${name}`;
    return `${s.usage}\n  ${s.summary}`;
  }
  const sorted = [...specs].sort((a, b) => a.name.localeCompare(b.name));
  const width = Math.max(...sorted.map((c) => c.usage.length));
  const lines = sorted.map((c) => `${c.usage.padEnd(width)}  ${c.summary}`);
  return ['Commands (typed at the start of a chat message; `//` sends a literal slash):', ...lines].join('\n');
}

/** 実行の記録を 1 つの文にする（履歴に `<event type="command">` として置く本文） */
export function commandEventText(line: string, result: { ok: boolean; text: string }): string {
  return `<event type="command">\n$ ${line}\n${result.ok ? result.text : `[Error] ${result.text}`}\n</event>`;
}
