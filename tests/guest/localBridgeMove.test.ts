/**
 * tests/guest/localBridgeMove.test.ts
 * Local Bridge の onMove — 改名・移動をホストに任せてよいかの判定 planBridgeMove（T-0691）
 *
 * 核は onMove が true を返すと stub を実体化せずに手元を動かす。向こう側を動かし終えていない項目が混ざると
 * その stub は二度と取れないので、**同じマウントの中・無視の外** 以外は必ず false。
 * 実装をコピーせずソースから取り出して評価する（localBridgeIgnore.test.ts と同じ作法）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(__dirname, '../../vfs_root/system/services/local_bridge.html'), 'utf-8');
function extract(re: RegExp, label: string): string {
  const m = SRC.match(re);
  if (!m) throw new Error(`local_bridge.html から ${label} を取り出せなかった。`);
  return m[0];
}
const parts = [
  extract(/function globToRegex\(glob\) \{[\s\S]*?\n {8}\}/, 'globToRegex'),
  extract(/function compileIgnorePatterns\(patterns\) \{[\s\S]*?\n {8}\}/, 'compileIgnorePatterns'),
  extract(/function isIgnoredCompiled\(rel, compiled\) \{[\s\S]*?\n {8}\}/, 'isIgnoredCompiled'),
  extract(
    /function planBridgeMove\(mountPath, oldFull, newFull, compiledIgnore\) \{[\s\S]*?\n {8}\}/,
    'planBridgeMove',
  ),
];
const { planBridgeMove, compileIgnorePatterns } = new Function(
  `${parts.join('\n')}\nreturn { planBridgeMove, compileIgnorePatterns };`,
)() as {
  planBridgeMove: (
    m: string,
    a: string,
    b: string,
    c: unknown,
  ) => { ok: boolean; reason?: string; oldRel?: string; newRel?: string };
  compileIgnorePatterns: (p: string[]) => unknown;
};

const M = 'local/yachiyo/ws_itera';
const ign = compileIgnorePatterns(['node_modules', '*.log', 'tmp/cache/']);

describe('planBridgeMove', () => {
  it('同じマウントの中の改名は ok で、相対パスを返す（本命）', () => {
    expect(planBridgeMove(M, `${M}/A/x.js`, `${M}/B/x.js`, ign)).toEqual({
      ok: true,
      oldRel: 'A/x.js',
      newRel: 'B/x.js',
    });
  });
  it('別のマウント・マウントの外へは任せない', () => {
    expect(planBridgeMove(M, `${M}/A`, `local/kukuri/auto-sekisan/A`, ign).ok).toBe(false);
    expect(planBridgeMove(M, `${M}/A`, `data/A`, ign).ok).toBe(false);
    expect(planBridgeMove(M, `data/A`, `${M}/A`, ign).ok).toBe(false);
  });
  it('マウントそのもの・自分の配下へは任せない', () => {
    expect(planBridgeMove(M, M, `${M}2`, ign).ok).toBe(false);
    expect(planBridgeMove(M, `${M}/A`, `${M}/A/inner`, ign).ok).toBe(false);
    expect(planBridgeMove(M, `${M}/A`, `${M}/A`, ign).ok).toBe(false);
  });
  it('無視パターンに当たるパスが絡むときは任せない（無視の中へ動かすのは「消す」が正しい）', () => {
    expect(planBridgeMove(M, `${M}/A/node_modules`, `${M}/B/nm`, ign).ok).toBe(false);
    expect(planBridgeMove(M, `${M}/A/x.txt`, `${M}/A/x.log`, ign).ok).toBe(false);
    expect(planBridgeMove(M, `${M}/A/x.txt`, `${M}/tmp/cache/x.txt`, ign).ok).toBe(false);
  });
  it('名前の前方が同じだけの隣（A → A2）は「配下」ではない', () => {
    expect(planBridgeMove(M, `${M}/A`, `${M}/A2`, ign).ok).toBe(true);
  });
});
