/**
 * src/core/control/tools/noPrincipalInTools.test.ts
 * 道具は権限を持たない（T-0903）。
 *
 * システムの道具は、呼んだエンジンが渡した取っ手（ToolContext）だけを使う。
 * 主体（Principal）の定数を道具が自分で書くと、どのエンジンから呼ばれても同じ者として動いてしまう。
 * 生の VfsService も掴まない（主体を自分で選べる口なので）。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const sources = readdirSync(__dirname).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

describe('道具は主体を名乗らない', () => {
  it('道具のファイルが在る（検査が空振りしていない）', () => {
    expect(sources).toEqual(expect.arrayContaining(['fs_tools.ts', 'search_tools.ts', 'sys_tools.ts', 'ui_tools.ts']));
  });

  for (const file of sources) {
    it(`${file}: 主体の定数も、生の VfsService も使わない`, () => {
      const text = readFileSync(resolve(__dirname, file), 'utf-8');
      expect(text).not.toMatch(/\b[A-Z]+_PRINCIPAL\b/);
      expect(text).not.toMatch(/\bVfsService\b/);
    });
  }
});
