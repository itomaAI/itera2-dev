// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GuestCompiler } from './GuestCompiler';
import type { VfsService } from '../../core/vfs/VfsService';

/**
 * src/shell/windowing/GuestCompiler.test.ts
 * 読み込めないパスの扱い（T-0196）
 *
 * 守りたいこと:
 *   コンパイラが「見つからないので、要求された相対パスをそのまま返す」と、
 *   iframe はそのパスを実際に HTTP で取りに行く。配信先が SPA リライト
 *   （未知の URL すべてに index.html を 200 で返す）を行っていると、返ってくるのは
 *   404 ではなく**親 OS の HTML** である。それが iframe の中で起動し、
 *   OS の中で OS が動く（ミャク楽 Agent の利用者環境で実際に起きた）。
 *
 *   したがって観測点は「404 の画面が出ること」ではなく、
 *   **要求されたパスを返さないこと**に置く。
 */

const blobs: Blob[] = [];
const originalCreateObjectURL = URL.createObjectURL;

beforeEach(() => {
  blobs.length = 0;
  URL.createObjectURL = ((blob: Blob) => {
    blobs.push(blob);
    return `blob:mock/${blobs.length}`;
  }) as typeof URL.createObjectURL;
});

afterEach(() => {
  URL.createObjectURL = originalCreateObjectURL;
});

/** exists / stat だけを持つ最小の VFS。ここでは読み込みまで進まない。 */
function vfsWith(entries: Record<string, 'file' | 'directory'>): VfsService {
  return {
    exists: (_principal: unknown, path: string) => path in entries,
    stat: (_principal: unknown, path: string) => ({ kind: entries[path], updatedAt: 1 }),
  } as unknown as VfsService;
}

describe('GuestCompiler: 読み込めないパス', () => {
  it('存在しないパスを、要求されたまま返さない', async () => {
    const compiler = new GuestCompiler();
    const { entryUrl, blobUrls } = await compiler.compile(vfsWith({}), 'apps/missing.html', 'test');

    expect(entryUrl).not.toBe('apps/missing.html');
    expect(entryUrl).toMatch(/^blob:/);
    // 解放できるように控えが残ること（残らないと Blob が漏れる）
    expect(blobUrls).toContain(entryUrl);
  });

  it('代わりに出すのは、OS を起動しない静的な画面である', async () => {
    const compiler = new GuestCompiler();
    await compiler.compile(vfsWith({}), 'apps/missing.html', 'test');

    expect(blobs).toHaveLength(1);
    const html = await blobs[0].text();
    expect(html).toContain('404');
    expect(html).toContain('apps/missing.html');
    expect(html).not.toContain('<script');
  });

  it('ディレクトリを指されたときも同じ（同じ罠にかかるため）', async () => {
    const compiler = new GuestCompiler();
    const { entryUrl } = await compiler.compile(vfsWith({ apps: 'directory' }), 'apps', 'test');

    expect(entryUrl).not.toBe('apps');
    expect(entryUrl).toMatch(/^blob:/);
  });

  it('外部 URL と data URI は、これまでどおりそのまま返す', async () => {
    const compiler = new GuestCompiler();
    const external = await compiler.compile(vfsWith({}), 'https://example.com/x.js', 'test');
    expect(external.entryUrl).toBe('https://example.com/x.js');
    expect(blobs).toHaveLength(0);
  });
});
