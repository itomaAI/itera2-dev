import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * ホストのコードに、ゲスト空間の名前（memory/ data/ docs/ user/ agent/ 個人/ エージェント/ 組織/）を書かない（T-0614）。
 * ホストが知っていてよいのは `system/`・`trash/` と、`system/config/paths.json` が指す場所だけ。
 * ここで落ちたら、その名前を paths.json の鍵にして `ConfigManager.paths()` から引く。
 *
 * コメントと試験・生成物（default_files.ts）は見ない。
 */
const SRC = resolve(__dirname, '..');
const FORBIDDEN = /(^|[^A-Za-z0-9_$.\/])(memory|data|docs|user|agent|workspace|個人|エージェント|組織)\//;
const EXCLUDE = new Set(['config/default_files.ts']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|js)$/.test(name) && !/\.test\.(ts|js)$/.test(name)) out.push(p);
  }
  return out;
}

/** 行コメントとブロックコメントを落とす（文字列の中の // は URL のことがあるので、`://` は残す）。 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('ホストはゲスト空間の名前を直書きしない', () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file);
    if (EXCLUDE.has(rel)) continue;
    const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      if (FORBIDDEN.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  it('src/ に memory/ data/ docs/ user/ agent/ 個人/ エージェント/ 組織/ が現れない', () => {
    expect(offenders).toEqual([]);
  });
});
