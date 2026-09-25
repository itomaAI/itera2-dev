// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GuestCompiler, blobUrlWith } from './GuestCompiler';
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

/**
 * blob URL に query を付けない（T-0542）
 *
 * 守りたいこと:
 *   `?query` を付けた blob URL を Firefox は読まない（iframe は load が来ないまま止まり、fetch は NetworkError）。
 *   ゲストが `?view=history` のような場所を申告したあとアドレスバーで再読み込みすると、
 *   `x.html?view=history` がそのまま来て、iframe の src が `blob:…?view=history` になっていた。
 *   `#hash` は Firefox でも読めるので残す。
 */
function vfsWithFiles(files: Record<string, string>): VfsService {
  return {
    exists: (_principal: unknown, path: string) => path in files,
    stat: () => ({ kind: 'file', updatedAt: 1 }),
    readFile: async (_principal: unknown, path: string) => files[path],
    readBlob: async (_principal: unknown, path: string) => new Blob([files[path]]),
  } as unknown as VfsService;
}

describe('GuestCompiler: blob URL に query を付けない（T-0542）', () => {
  it('入口の HTML に ?query が付いていても、返す blob URL には付けない', async () => {
    const compiler = new GuestCompiler();
    const vfs = vfsWithFiles({ 'apps/a.html': '<html><head></head><body>a</body></html>' });
    const { entryUrl } = await compiler.compile(vfs, 'apps/a.html?skill=%E8%A6%8B&view=history', 'test');

    expect(entryUrl).toMatch(/^blob:/);
    expect(entryUrl).not.toContain('?');
  });

  it('#hash は残す', async () => {
    const compiler = new GuestCompiler();
    const vfs = vfsWithFiles({ 'apps/a.html': '<html><head></head><body>a</body></html>' });
    const { entryUrl } = await compiler.compile(vfs, 'apps/a.html?x=1#sec', 'test');

    expect(entryUrl).toMatch(/^blob:[^?]*#sec$/);
  });

  it('HTML から参照する資源の ?v=2 も付けない（キャッシュ済みの 2 回目も同じ）', async () => {
    const compiler = new GuestCompiler();
    const vfs = vfsWithFiles({
      'apps/a.html': '<html><head><script src="lib.js?v=2"></script></head><body></body></html>',
      'apps/lib.js': 'window.x = 1;',
    });
    for (let i = 0; i < 2; i++) {
      blobs.length = 0;
      await compiler.compile(vfs, 'apps/a.html', 'test');
      const html = await blobs[blobs.length - 1].text();
      // lib.js は blob に置き換わり（元のパスは残らない）、その blob URL に ?v=2 は付かない
      expect(html).not.toContain('lib.js');
      const srcs = [...html.matchAll(/src="(blob:[^"]*)"/g)].map((m) => m[1]);
      expect(srcs.length).toBeGreaterThanOrEqual(2); // ブリッジ ＋ lib.js
      for (const src of srcs) expect(src).not.toContain('?');
    }
  });

  it('blobUrlWith は hash だけを載せる', () => {
    expect(blobUrlWith('blob:x/1', '?a=1', '#h')).toBe('blob:x/1#h');
    expect(blobUrlWith('blob:x/1', '?a=1', '')).toBe('blob:x/1');
  });
});
