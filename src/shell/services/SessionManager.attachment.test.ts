/**
 * src/shell/services/SessionManager.attachment.test.ts
 * 会話の添付の置き場に置く口（T-0903）。
 *
 * 道具（take_screenshot）は名前と中身を渡すだけで、置き場（いまの会話のディレクトリ）と
 * 書く権限（システムの一時領域なので OS）は会話の側が持つ。
 */

import { describe, it, expect } from 'vitest';
import { SessionManager } from './SessionManager';
import { SYSTEM_PRINCIPAL } from '../../core/vfs/types';

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('SessionManager.putAttachment', () => {
  it('いまの会話の置き場に OS として書き、置いたパスを返す', async () => {
    const writes: any[] = [];
    const vfs: any = {
      writeFile: async (principal: unknown, path: string, content: unknown, opts: unknown) => {
        writes.push({ principal, path, content, opts });
        return 'ok';
      },
    };
    const history: any = {
      get: () => [],
      getCurrentMeta: async () => ({ id: 's1', createdAt: 1, title: '' }),
      setCurrentMeta: async () => {},
    };
    const sm = new SessionManager(vfs, history, { log: () => {} } as any, {} as any);
    await sm.init();

    const blob = new Blob(['x']);
    const path = await sm.putAttachment('shot.png', blob);

    expect(path).toBe(`${sm.currentMediaDir()}/shot.png`);
    expect(path).toContain('/s1/');
    expect(writes).toEqual([
      { principal: SYSTEM_PRINCIPAL, path, content: blob, opts: { overwrite: true, system: true } },
    ]);
  });
});
