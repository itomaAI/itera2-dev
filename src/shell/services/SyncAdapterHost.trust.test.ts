/**
 * アダプタはホストの窓で動く。読むのは配信物（readonly の領域のファイル）だけ（T-0904）:
 * 一覧は `system/adapters/adapters.json`、本体も配信物であること。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncAdapterHost } from './SyncAdapterHost';
import { dir, fakeTree, file, type FakeNode } from '../../core/vfs/distributionTestKit';

/* eslint-disable @typescript-eslint/no-explicit-any */
const LIST = 'system/adapters/adapters.json';
const BODY = 'system/adapters/a.js';
const OLD_LIST = 'system/registry/adapters.json';
const SOURCE = 'export async function init() {}';
const list = (...paths: string[]) =>
  JSON.stringify({ adapters: paths.map((path, i) => ({ id: `a${i}`, name: `A${i}`, path, enabled: true })) });

const tree = (extra: Record<string, FakeNode> = {}) =>
  fakeTree({
    system: dir('readonly'),
    'system/adapters': dir('readonly'),
    [LIST]: file('readonly', list(BODY)),
    [BODY]: file('readonly', SOURCE),
    'system/registry': dir('open'),
    [OLD_LIST]: file('open', list('data/evil.js')),
    'system/temp': dir('open'),
    'system/temp/evil.js': file('open', SOURCE),
    data: dir('open'),
    'data/evil.js': file('open', SOURCE),
    ...extra,
  });

const load = async (vfs: ReturnType<typeof fakeTree>) => {
  const host = new SyncAdapterHost(vfs as any, {} as any, {} as any);
  await host.loadAll();
  return host;
};

describe('SyncAdapterHost: 読むのは配信物だけ', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('一覧は system/adapters/adapters.json から読み、載っている本体を読む。登録簿の側は読まない', async () => {
    const vfs = tree();
    await load(vfs);
    expect(vfs.reads).toEqual([LIST, BODY]);
    expect(vfs.reads).not.toContain(OLD_LIST);
    expect(vfs.reads).not.toContain('data/evil.js');
  });

  it('一覧が配信物でなければ（書けるファイル・書けるディレクトリ）、何も読み込まない', async () => {
    const cases: Array<Record<string, FakeNode>> = [
      { [LIST]: file('open', list(BODY)) },
      { 'system/adapters': dir('open') },
    ];
    for (const extra of cases) {
      const vfs = tree(extra);
      const host = await load(vfs);
      expect(vfs.reads).toEqual([]);
      expect(host.getAdapters()).toEqual([]);
    }
  });

  it('一覧が無ければ、何も読み込まない', async () => {
    const vfs = tree();
    delete vfs.nodes[LIST];
    const host = await load(vfs);
    expect(vfs.reads).toEqual([]);
    expect(host.getAdapters()).toEqual([]);
  });

  it('本体が配信物でない項目は飛ばし、ほかの項目は読む', async () => {
    const vfs = tree({ [LIST]: file('readonly', list('data/evil.js', 'system/temp/evil.js', BODY)) });
    await load(vfs);
    expect(vfs.reads).toEqual([LIST, BODY]);
  });
});
