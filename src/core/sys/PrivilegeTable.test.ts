/**
 * 配信物の特権の表（T-0904）。
 * 特権は「このプロセスのファイルが、配信物の表に載っている」ことだけで決まる。
 */
import { describe, expect, it, vi } from 'vitest';
import { PRIVILEGE_TABLE_PATH, PrivilegeTable } from './PrivilegeTable';
import { dir, fakeTree, file, type FakeNode } from '../vfs/distributionTestKit';

const SYNC = 'system/services/sync.html';
const table = (paths: unknown) => JSON.stringify({ systemPrivilege: paths });

const tree = (extra: Record<string, FakeNode> = {}) =>
  fakeTree({
    system: dir('readonly'),
    'system/services': dir('readonly'),
    [SYNC]: file('readonly'),
    'system/services/other.html': file('readonly'),
    [PRIVILEGE_TABLE_PATH]: file('readonly', table([SYNC])),
    'system/temp': dir('open'),
    'system/temp/evil.html': file('open'),
    ...extra,
  });

const loaded = async (vfs: ReturnType<typeof fakeTree>) => {
  const t = new PrivilegeTable(vfs);
  await t.load();
  return t;
};

describe('PrivilegeTable', () => {
  it('表に載っている配信物のファイルに特権を与える', async () => {
    const t = await loaded(tree());
    expect(t.grants(SYNC)).toBe(true);
    expect(t.grants(`/${SYNC}`)).toBe(true);
  });

  it('表に載っていないファイルには与えない（配信物でも）', async () => {
    const t = await loaded(tree());
    expect(t.grants('system/services/other.html')).toBe(false);
    expect(t.grants('')).toBe(false);
  });

  it('表に載っていても、誰でも書ける場所のファイルには与えない', async () => {
    const t = await loaded(tree({ [PRIVILEGE_TABLE_PATH]: file('readonly', table([SYNC, 'system/temp/evil.html'])) }));
    expect(t.grants('system/temp/evil.html')).toBe(false);
    expect(t.grants(SYNC)).toBe(true);
  });

  it('表そのものが配信物でなければ、誰にも与えない', async () => {
    // 表が書けるファイルになっている
    expect((await loaded(tree({ [PRIVILEGE_TABLE_PATH]: file('open', table([SYNC])) }))).grants(SYNC)).toBe(false);
    // 表を置くディレクトリが書ける
    expect((await loaded(tree({ 'system/services': dir('open') }))).grants(SYNC)).toBe(false);
  });

  it('表が無い・壊れている・形が違うときは、誰にも与えない（落ちない）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const none = tree();
    delete none.nodes[PRIVILEGE_TABLE_PATH];
    expect((await loaded(none)).grants(SYNC)).toBe(false);
    expect((await loaded(tree({ [PRIVILEGE_TABLE_PATH]: file('readonly', '{ broken') }))).grants(SYNC)).toBe(false);
    expect((await loaded(tree({ [PRIVILEGE_TABLE_PATH]: file('readonly', table(SYNC)) }))).grants(SYNC)).toBe(false);
    expect((await loaded(tree({ [PRIVILEGE_TABLE_PATH]: file('readonly', '[]') }))).grants(SYNC)).toBe(false);
    warn.mockRestore();
  });

  it('文字列でない項目・空の項目は読み飛ばす', async () => {
    const t = await loaded(
      tree({ [PRIVILEGE_TABLE_PATH]: file('readonly', table([null, 3, '', ' ', { path: SYNC }, SYNC])) }),
    );
    expect(t.grants(SYNC)).toBe(true);
  });

  it('ACL は毎回見る: 読んだあとでファイルが書ける場所になったら与えない', async () => {
    const vfs = tree();
    const t = await loaded(vfs);
    expect(t.grants(SYNC)).toBe(true);
    vfs.nodes[SYNC] = file('open');
    expect(t.grants(SYNC)).toBe(false);
  });

  it('表が変わったら読み直す。ほかのファイルの変更では読み直さない', async () => {
    const vfs = tree();
    let notify: (mutations: Array<{ path: string }>) => void = () => {};
    const t = new PrivilegeTable(vfs, { subscribe: (cb) => (notify = cb) });
    await t.load();
    expect(vfs.reads).toEqual([PRIVILEGE_TABLE_PATH]);

    notify([{ path: 'system/registry/services.json' }, { path: 'data/x.md' }]);
    await Promise.resolve();
    expect(vfs.reads).toEqual([PRIVILEGE_TABLE_PATH]);

    vfs.nodes[PRIVILEGE_TABLE_PATH] = file('readonly', table(['system/services/other.html']));
    notify([{ path: PRIVILEGE_TABLE_PATH }]);
    await vi.waitFor(() => expect(t.grants('system/services/other.html')).toBe(true));
    expect(t.grants(SYNC)).toBe(false);
  });
});
