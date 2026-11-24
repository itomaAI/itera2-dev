/**
 * src/api/chatPost.test.ts
 * 会話にターンを置く手順（T-0908）。MetaOS.chat.append と MetaOS.engine の append が通る 1 本の道。
 * 計画そのものの規則は chatApi.test.ts。ここは「誰の権限で読むか・どこへ置くか・断り方」を見る。
 */
import { describe, expect, it, vi } from 'vitest';
import { postToBundle } from './chatPost';
import type { Principal } from '../core/vfs/types';

const APP: Principal = { type: 'app', id: 'viewer' };
const CALLER = { pid: 'viewer-1', principal: APP };

/** files の値が null のパスはディレクトリ。無いパスの stat は投げる */
function world(files: Record<string, string | null> = {}) {
  const stats: Array<[Principal, string]> = [];
  const blobs: Array<[Principal, string]> = [];
  const vfs = {
    stat: (principal: Principal, path: string) => {
      stats.push([principal, path]);
      if (!(path in files)) throw new Error(`File not found: ${path}`);
      const body = files[path];
      // ディレクトリの stat にも大きさが在る（小さいと、文字の候補として中身を読みに行ける大きさ）
      return body === null ? { kind: 'directory', size: 4 } : { kind: 'file', size: body.length };
    },
    withBlob: async (principal: Principal, path: string, fn: (blob: Blob) => Promise<unknown>) => {
      blobs.push([principal, path]);
      return fn(new Blob([files[path] as string]));
    },
  };
  const post = vi.fn(async (role: string, content: any, meta: any) => ({
    id: 'turn-1',
    timestamp: 1,
    role,
    content,
    meta,
  }));
  return { vfs: vfs as any, bundle: { post } as any, post, stats, blobs };
}
const textOf = (content: any[]) => content.map((p) => (typeof p.text === 'string' ? p.text : '')).join('\n');

describe('postToBundle: 置く', () => {
  it('ターンを 1 つ置いて、その id を返す。出どころは呼び手の pid・起こすのは wake のときだけ', async () => {
    const w = world();

    expect(await postToBundle(w.vfs, w.bundle, CALLER, { role: 'user', content: 'hi', opts: { wake: true } })).toEqual({
      id: 'turn-1',
    });
    expect(w.post).toHaveBeenLastCalledWith('user', [{ text: 'hi' }], { trigger_llm: true, source: 'viewer-1' });

    await postToBundle(w.vfs, w.bundle, CALLER, { role: 'user', content: 'quiet' });
    expect(w.post).toHaveBeenLastCalledWith('user', [{ text: 'quiet' }], { trigger_llm: false, source: 'viewer-1' });

    await postToBundle(w.vfs, w.bundle, CALLER, { role: 'system', content: 'note', opts: { visible: false } });
    expect(w.post).toHaveBeenLastCalledWith('system', [{ text: 'note' }], {
      trigger_llm: false,
      source: 'viewer-1',
      type: 'event_log',
      eventType: 'app_event',
      visible: false,
    });
    // 添付が無ければ、VFS には触らない
    expect(w.stats).toEqual([]);
  });

  it('受けられない形は、置かずに、呼んだ口の名前を付けて断る', async () => {
    const w = world();

    await expect(postToBundle(w.vfs, w.bundle, CALLER, { role: 'model', content: 'x' })).rejects.toThrow(
      "chat.append: role must be 'user' or 'system'",
    );
    await expect(postToBundle(w.vfs, w.bundle, CALLER, { role: 'user', content: '' }, 'engine.append')).rejects.toThrow(
      'engine.append: content is empty',
    );
    expect(w.post).not.toHaveBeenCalled();
  });
});

describe('postToBundle: 添付', () => {
  it('文字の添付は、呼び手の権限で読んで本文に展開する', async () => {
    const w = world({ 'data/n.txt': 'hello attachment' });

    await postToBundle(w.vfs, w.bundle, CALLER, {
      role: 'user',
      content: 'see',
      opts: { attachments: ['data/n.txt'] },
    });

    const content = w.post.mock.calls[0][1];
    expect(textOf(content)).toContain('hello attachment');
    expect(textOf(content)).toContain('data/n.txt');
    expect(content.at(-1)).toEqual({ text: 'see' });
    // 読んだのは呼び手の主体（OS の主体で代わりに読まない）
    expect(w.stats).toEqual([[APP, 'data/n.txt']]);
    expect(w.blobs).toEqual([[APP, 'data/n.txt']]);
  });

  it('読めない添付・ディレクトリは、注記だけになる（投げない・中身を読まない）', async () => {
    const w = world({ 'data/dir.txt': null });

    await postToBundle(w.vfs, w.bundle, CALLER, {
      role: 'user',
      content: 'see',
      opts: { attachments: ['data/missing.txt', 'data/dir.txt'] },
    });

    const content = w.post.mock.calls[0][1];
    expect(textOf(content)).toContain('data/missing.txt');
    expect(textOf(content)).toContain('data/dir.txt');
    expect(w.stats.map(([, path]) => path)).toEqual(['data/missing.txt', 'data/dir.txt']);
    expect(w.blobs).toEqual([]);
  });

  it('添付の実体は写さない: ターンが持つのは、渡されたパス', async () => {
    const w = world({ 'data/a.png': 'PNG' });

    await postToBundle(w.vfs, w.bundle, CALLER, {
      role: 'user',
      content: 'look',
      opts: { attachments: ['data/a.png'] },
    });

    const content = w.post.mock.calls[0][1];
    expect(content[0]).toEqual({ media: { path: 'data/a.png', mimeType: 'image/png', metadata: {} } });
  });
});
