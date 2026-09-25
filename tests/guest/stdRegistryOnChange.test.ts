import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** std.js の App.Registry.onChange（T-0540）。registry_changed を名前で絞り、値を読み直して渡す。 */
const SRC = readFileSync(resolve(__dirname, '../../vfs_root/system/core/std.js'), 'utf-8');

function load() {
  const handlers = new Map<string, Set<(p: unknown) => void>>();
  const values: Record<string, unknown> = { apps: [{ id: 'a' }], associations: { extensions: {} } };
  const win: any = {
    MetaOS: {
      system: {
        on: (n: string, h: (p: unknown) => void) => {
          if (!handlers.has(n)) handlers.set(n, new Set());
          handlers.get(n)!.add(h);
        },
        off: (n: string, h: (p: unknown) => void) => handlers.get(n)?.delete(h),
        getRegistry: async (n: string) => values[n],
      },
    },
  };
  new Function('window', SRC)(win);
  const emit = async (payload: unknown) => {
    for (const h of handlers.get('registry_changed') ?? []) await h(payload);
  };
  return { App: win.App, emit, handlers };
}

describe('App.Registry.onChange', () => {
  it('calls back with the re-read value only for its registry', async () => {
    const { App, emit } = load();
    const got: unknown[] = [];
    App.Registry.onChange('apps', (v: unknown, names: string[]) => got.push([v, names]));
    await emit({ registries: ['services'] });
    expect(got).toEqual([]);
    await emit({ registries: ['apps', 'services'] });
    expect(got).toEqual([[[{ id: 'a' }], ['apps', 'services']]]);
  });

  it('ignores a malformed payload and unsubscribes', async () => {
    const { App, emit, handlers } = load();
    let n = 0;
    const off = App.Registry.onChange('apps', () => n++);
    await emit(undefined);
    await emit({ registries: 'apps' });
    off();
    expect(handlers.get('registry_changed')?.size ?? 0).toBe(0);
    await emit({ registries: ['apps'] });
    expect(n).toBe(0);
  });
});
