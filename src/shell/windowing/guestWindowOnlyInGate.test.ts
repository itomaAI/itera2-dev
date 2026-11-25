/**
 * src/shell/windowing/guestWindowOnlyInGate.test.ts
 * ゲストの窓へ送るのは、関所（ProcessManager）だけ（T-0912）。
 *
 * プロセスを動かす・プロセスに頼む・知らせる は、どれも ProcessManager の口を通る。
 * 関所の外のコードがゲストの窓（iframe の contentWindow）や、ゲスト宛ての道（HostTransport の invokeGuest / sendEvent）を
 * 直に掴むと、「誰が」の判定を通らない道がもう 1 本できる。ここでは、そういう呼び手がソースに無いことを見る
 * （道具が主体を名乗らないことを見る core/control/tools/noPrincipalInTools.test.ts と同じ型）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const SRC = resolve(__dirname, '../..');
const GATE = 'shell/windowing/ProcessManager.ts';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

// ホストのソース（試験と、配信物を畳んだ生成物を除く）
const sources = walk(SRC)
  .filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('default_files.ts'))
  .map((path) => ({ rel: relative(SRC, path).split('\\').join('/'), text: readFileSync(path, 'utf-8') }));

const filesWith = (pattern: RegExp) =>
  sources
    .filter((s) => pattern.test(s.text))
    .map((s) => s.rel)
    .sort();

describe('ゲストの窓へ送るのは関所だけ', () => {
  it('ソースを読めている（検査が空振りしていない）', () => {
    expect(sources.length).toBeGreaterThan(100);
    expect(sources.map((s) => s.rel)).toEqual(
      expect.arrayContaining([GATE, 'ipc/HostTransport.ts', 'api/HostApiRouter.ts', 'core/vfs/ProviderManager.ts']),
    );
  });

  it('ゲスト宛ての要求と知らせ（invokeGuest / sendEvent）を呼ぶのは ProcessManager だけ', () => {
    expect(filesWith(/\.(invokeGuest|sendEvent)\(/)).toEqual([GATE]);
  });

  it('ゲストの窓（contentWindow）に触るのは ProcessManager と、送り主の確かめ（読むだけ）だけ', () => {
    expect(filesWith(/\bcontentWindow\b/)).toEqual(['shell/core/SystemBootstrapper.ts', GATE]);
    // SystemBootstrapper が触るのは 1 か所: ゲストから来た要求の窓が、名乗った pid の窓かを比べるだけ（送らない）
    const boot = sources.find((s) => s.rel === 'shell/core/SystemBootstrapper.ts')!.text;
    expect(boot.match(/\bcontentWindow\b/g)).toHaveLength(1);
    expect(boot).toContain('proc.iframe.contentWindow === sourceWindow');
  });

  it('動かす口は「誰が」を受け取る。判定の内側の口（_kill・restartAll）は外に出ていない', () => {
    const gate = sources.find((s) => s.rel === GATE)!.text;
    expect(gate).toMatch(/^ {2}async spawn\(mover: Mover, options: SpawnOptions\): Promise<void> \{$/m);
    expect(gate).toMatch(/^ {2}kill\(mover: Mover, pid: string\): boolean \{$/m);
    expect(gate).toMatch(/^ {2}async evalIn\(mover: Mover, pid: string, code: string\): Promise<unknown> \{$/m);
    expect(gate).toMatch(/^ {2}private _kill\(/m);
    expect(gate).toMatch(/^ {2}private async restartAll\(/m);
    // 関所の外から、判定の内側の口を呼ぶ者は居ない
    expect(filesWith(/\._kill\(|\.restartAll\(/)).toEqual([GATE]);
  });
});
