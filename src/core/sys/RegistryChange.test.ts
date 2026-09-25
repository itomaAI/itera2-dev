import { describe, it, expect } from 'vitest';
import { AppRegistry } from './AppRegistry';
import { FileAssociationResolver } from './FileAssociationResolver';
import { VfsEventBus } from '../vfs/VfsEventBus';

/**
 * 登録簿の「値が変わった」の知らせ（T-0540）。判定は旧値と新値を持つ持ち主に置く（T-0304）。
 * 書き直されただけで中身が同じなら知らせない。どの登録簿が変わったかを渡す。
 */
function makeVfs(files: Record<string, string>) {
  return {
    files,
    exists: (_p: any, path: string) => path in files,
    readFile: async (_p: any, path: string) => files[path],
    writeFile: async (_p: any, path: string, content: string) => {
      files[path] = content;
    },
  } as any;
}

const SYS = 'system/registry';
const tick = () => new Promise((r) => setTimeout(r, 0));

async function touch(bus: VfsEventBus, path: string) {
  bus.publish({ action: 'MUTATE', path } as any);
  bus.flushNow();
  await tick();
  await tick();
}

describe('AppRegistry.onChange', () => {
  const app = (id: string, name = id) => ({ id, name, icon: 'x', path: `apps/${id}.html` });

  it('names only the registry whose value changed', async () => {
    const files: Record<string, string> = {
      [`${SYS}/apps.json`]: JSON.stringify([app('a')]),
      [`${SYS}/services.json`]: JSON.stringify([]),
    };
    const bus = new VfsEventBus();
    const reg = new AppRegistry(makeVfs(files), bus, [SYS]);
    await reg.loadAll();
    const seen: string[][] = [];
    reg.onChange((changed) => seen.push([...changed]));

    files[`${SYS}/apps.json`] = JSON.stringify([app('a'), app('b')]);
    await touch(bus, `${SYS}/apps.json`);
    expect(seen).toEqual([['apps']]);
  });

  it('stays silent when the file is rewritten with the same value', async () => {
    const files: Record<string, string> = { [`${SYS}/apps.json`]: JSON.stringify([app('a')]) };
    const bus = new VfsEventBus();
    const reg = new AppRegistry(makeVfs(files), bus, [SYS]);
    await reg.loadAll();
    let n = 0;
    reg.onChange(() => n++);

    files[`${SYS}/apps.json`] = JSON.stringify([app('a')], null, 2);
    await touch(bus, `${SYS}/apps.json`);
    expect(n).toBe(0);
  });

  it('updateEntry announces the kind it changed', async () => {
    const files: Record<string, string> = {
      [`${SYS}/services.json`]: JSON.stringify([{ id: 's', name: 'S', path: 'x.html', autoStart: true }]),
    };
    const reg = new AppRegistry(makeVfs(files), new VfsEventBus(), [SYS]);
    await reg.loadAll();
    const seen: string[][] = [];
    const off = reg.onChange((changed) => seen.push([...changed]));
    await reg.updateEntry('services', 's', { autoStart: false });
    await reg.updateEntry('services', 's', { autoStart: false }); // 同じ値 → 黙る
    off();
    await reg.updateEntry('services', 's', { autoStart: true }); // 外した後 → 届かない
    expect(seen).toEqual([['services']]);
  });
});

describe('FileAssociationResolver.onChange', () => {
  it('fires only when the merged associations changed, and not on the first load', async () => {
    const files: Record<string, string> = {
      [`${SYS}/associations.json`]: JSON.stringify({ extensions: { md: 'notes' } }),
    };
    const vfs = makeVfs(files);
    const bus = new VfsEventBus();
    const reg = new AppRegistry(vfs, bus, [SYS]);
    const res = new FileAssociationResolver(vfs, reg, bus, [SYS]);
    let n = 0;
    res.onChange(() => n++);
    await res.loadAssociations();
    expect(n).toBe(0);

    await res.loadAssociations();
    expect(n).toBe(0);

    files[`${SYS}/associations.json`] = JSON.stringify({ extensions: { md: 'editor' } });
    await res.loadAssociations();
    expect(n).toBe(1);
  });
});

describe('AppRegistry: 読み込みの途中でも一覧が欠けない', () => {
  it('getAllApps during a reload returns the previous full list, never a partial one', async () => {
    const files: Record<string, string> = {
      [`${SYS}/apps.json`]: JSON.stringify([
        { id: 'a', name: 'a', icon: 'x', path: 'a.html' },
        { id: 'b', name: 'b', icon: 'x', path: 'b.html' },
      ]),
    };
    let gate: (() => void) | null = null;
    const vfs = {
      exists: (_p: any, path: string) => path in files,
      readFile: async (_p: any, path: string) => {
        if (gate === null && path.endsWith('apps.json')) {
          // 2 回目以降の読み込みを止めておき、その間に読む
          await new Promise<void>((r) => (gate = r));
        }
        return files[path];
      },
      writeFile: async () => {},
    } as any;
    const bus = new VfsEventBus();
    const reg = new AppRegistry(vfs, bus, [SYS]);
    gate = () => {}; // 最初の読み込みは止めない
    await reg.loadAll();
    gate = null;

    bus.publish({ action: 'MUTATE', path: `${SYS}/apps.json` } as any);
    bus.flushNow();
    await tick();
    expect(reg.getAllApps().map((x) => x.id)).toEqual(['a', 'b']);
    (gate as unknown as () => void)();
  });
});
