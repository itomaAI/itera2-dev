/**
 * 配信物は、道具の定義を自分で会話に流さない（T-0912）。
 *
 * 道具の定義は、登録（MetaOS.tools.register）のときに OS が台帳から会話に置く。アプリが
 * `MetaOS.ai.log(定義, 'tool_available')` でも流すと、同じ定義が会話に 2 度入る。
 * 配信しているアプリ・デーモンだけでなく、手引きと見本（AI がそれを手本にアプリを書く）にも、その書き方を残さない。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../vfs_root');
const TEXT = /\.(html|js|md|json|ts)$/;
const WORD = /['"`]tool_available['"`]/;
const MAX_CALL = 4000; // 1 つの呼び出しとして読む長さの上限（閉じ括弧が見つからないときの歯止め）

/** `….log(` の呼び出しのうち、引数のどこかに 'tool_available' を渡しているものの数。括弧を数えて、呼び出しの終わりまでを引数として読む */
function definitionLogCalls(text: string): number {
  let n = 0;
  for (let i = text.indexOf('.log('); i >= 0; i = text.indexOf('.log(', i + 1)) {
    const open = i + 4;
    let depth = 0;
    let j = open;
    for (; j < text.length && j < open + MAX_CALL; j++) {
      const c = text[j];
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) break;
    }
    if (WORD.test(text.slice(open + 1, j))) n++;
  }
  return n;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (TEXT.test(name)) out.push(p);
  }
  return out;
}

describe('配信物は、道具の定義を ai.log で流さない', () => {
  const files = walk(ROOT);

  it('走査できている（道具を登録するファイルが見つかる）', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((p) => readFileSync(p, 'utf8').includes('tools.register('))).toBe(true);
  });

  it("vfs_root のどこにも log(…, 'tool_available') の呼び出しが無い", () => {
    const hits = files.filter((p) => definitionLogCalls(readFileSync(p, 'utf8')) > 0).map((p) => relative(ROOT, p));
    expect(hits).toEqual([]);
  });

  it('見分けは、実際の書き方を拾う（1 行・複数行・引数の中に括弧が入れ子のもの）', () => {
    expect(definitionLogCalls('await MetaOS.ai.log(systemMsg, "tool_available");')).toBe(1);
    expect(definitionLogCalls("MetaOS.ai.log(\n  definition + '\\n\\n[System] ready.',\n  'tool_available',\n);")).toBe(
      1,
    );
    expect(definitionLogCalls("ai.log(toolDefs, 'tool_available', { trigger_llm: false });")).toBe(1);
    expect(definitionLogCalls("M.ai.log(TOOLS.map((t) => t.definition).join('\\n'), 'tool_available');")).toBe(1);
    expect(definitionLogCalls("M.ai.log(Object.values(defs).join('\\n'), `tool_available`);")).toBe(1);
  });

  it('見分けは、定義を流していないものを拾わない', () => {
    // 手引きの説明の文（呼び出しではない）
    expect(
      definitionLogCalls('placed in the conversation (a `tool_available` event). Do not log it with `MetaOS.ai.log`.'),
    ).toBe(0);
    // 別の種類の記録
    expect(definitionLogCalls("MetaOS.ai.log('User cleared the mind map.', 'map_cleared');")).toBe(0);
    // 呼び出しが閉じたあとに語が出てくるだけ
    expect(definitionLogCalls("console.log('started');\nconst hidden = ['tool_available', 'info'];")).toBe(0);
  });
});
