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
// `….log(` の引数のどこかに 'tool_available' を渡している呼び出し（複数行でもよい）
const CALL = /\.log\(\s*(?:[^()]|\([^()]*\))*?['"`]tool_available['"`]/;

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
    const hits = files.filter((p) => CALL.test(readFileSync(p, 'utf8'))).map((p) => relative(ROOT, p));
    expect(hits).toEqual([]);
  });

  it('見分けの式は、実際の書き方を拾う', () => {
    expect(CALL.test('await MetaOS.ai.log(systemMsg, "tool_available");')).toBe(true);
    expect(CALL.test("MetaOS.ai.log(\n  definition + '\\n\\n[System] ready.',\n  'tool_available',\n);")).toBe(true);
    expect(CALL.test("ai.log(toolDefs, 'tool_available', { trigger_llm: false });")).toBe(true);
    // 手引きの説明の文（呼び出しではない）は拾わない
    expect(
      CALL.test('placed in the conversation (a `tool_available` event). Do not log it with `MetaOS.ai.log`.'),
    ).toBe(false);
    expect(CALL.test("MetaOS.ai.log('User cleared the mind map.', 'map_cleared');")).toBe(false);
  });
});
