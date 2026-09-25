import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** std.js の App.Config.onChange（T-0539）。ホストの config_changed を区分で絞り、値を読み直して渡す。 */
const SRC = readFileSync(resolve(__dirname, '../../vfs_root/system/core/std.js'), 'utf-8');

function load() {
  const handlers = new Map<string, Set<(p: unknown) => void>>();
  const values: Record<string, unknown> = { appearance: { locale: 'ja' }, llm: { model: 'm' } };
  const win: any = {
    MetaOS: {
      system: {
        on: (n: string, h: (p: unknown) => void) => {
          if (!handlers.has(n)) handlers.set(n, new Set());
          handlers.get(n)!.add(h);
        },
        off: (n: string, h: (p: unknown) => void) => handlers.get(n)?.delete(h),
        getConfig: async (c: string) => values[c],
      },
    },
  };
  new Function('window', SRC)(win);
  const emit = async (payload: unknown) => {
    for (const h of handlers.get('config_changed') ?? []) await h(payload);
  };
  return { App: win.App, emit, handlers, values };
}

describe('App.Config.onChange', () => {
  it('calls back with the re-read value only for its category', async () => {
    const { App, emit } = load();
    const got: unknown[] = [];
    App.Config.onChange('appearance', (v: unknown, cats: string[]) => got.push([v, cats]));
    await emit({ categories: ['llm'] });
    expect(got).toEqual([]);
    await emit({ categories: ['appearance', 'llm'] });
    expect(got).toEqual([[{ locale: 'ja' }, ['appearance', 'llm']]]);
  });

  it('ignores a malformed payload', async () => {
    const { App, emit } = load();
    let n = 0;
    App.Config.onChange('appearance', () => n++);
    await emit(undefined);
    await emit({ categories: 'appearance' });
    expect(n).toBe(0);
  });

  it('returns a function that unsubscribes', async () => {
    const { App, emit, handlers } = load();
    let n = 0;
    const off = App.Config.onChange('appearance', () => n++);
    off();
    expect(handlers.get('config_changed')?.size ?? 0).toBe(0);
    await emit({ categories: ['appearance'] });
    expect(n).toBe(0);
  });
});
