import { describe, expect, it } from 'vitest';
import { unregisterHostServiceWorkers } from './hostServiceWorkers';

/** ホストの範囲の登録だけを解除する（T-0838） */
function container(scopes: string[]) {
  const removed: string[] = [];
  return {
    removed,
    getRegistrations: async () =>
      scopes.map((scope) => ({
        scope,
        unregister: async () => {
          removed.push(scope);
          return true;
        },
      })),
  };
}

describe('unregisterHostServiceWorkers', () => {
  it('ホストの文書のあるディレクトリ以下だけを解除する', async () => {
    const c = container([
      'https://example.github.io/itera2-dev/',
      'https://example.github.io/itera2-dev/api/',
      'https://example.github.io/other-repo/',
      'https://example.github.io/',
    ]);
    const done = await unregisterHostServiceWorkers('https://example.github.io/itera2-dev/index.html?x=1', c);
    expect(done).toEqual(['https://example.github.io/itera2-dev/', 'https://example.github.io/itera2-dev/api/']);
    expect(c.removed).toEqual(done);
  });

  it('ホストがオリジンの根なら、そのオリジンの登録を全部解除する', async () => {
    const c = container(['https://itera2.web.app/', 'https://itera2.web.app/api/']);
    expect(await unregisterHostServiceWorkers('https://itera2.web.app/', c)).toHaveLength(2);
  });

  it('Service Worker の無いブラウザでは何もしない', async () => {
    expect(await unregisterHostServiceWorkers('https://itera2.web.app/', undefined)).toEqual([]);
  });

  it('1 つの解除が失敗しても残りは解除する', async () => {
    const c = {
      getRegistrations: async () => [
        { scope: 'https://h/a/', unregister: async () => Promise.reject(new Error('x')) },
        { scope: 'https://h/b/', unregister: async () => true },
      ],
    };
    expect(await unregisterHostServiceWorkers('https://h/', c)).toEqual(['https://h/b/']);
  });
});
