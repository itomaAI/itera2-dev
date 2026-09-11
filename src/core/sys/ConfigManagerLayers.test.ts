import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigManager } from './ConfigManager';
import { VfsEventBus } from '../vfs/VfsEventBus';

/**
 * 設定の層（T-0427）。
 *
 * 配信の既定と利用者の上書きが同じファイルに同居していると、
 *   - 配信で上書きする  → 利用者の設定が消える
 *   - 配信で上書きしない → 新しい既定が既存の環境へ永久に届かない
 * のどちらかしか選べない。層に分ければどちらも起きない。
 *
 * ここで守りたいことは 2 つ:
 *   1. 後の層が勝ち、下の層にしか無い項目は残る
 *   2. 🔴 **書くのは差分だけ**。併合した全体を書くと下の層が写しとして固まり、
 *      あとから既定が変わっても届かなくなる（層に分けた意味が消える）
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

async function touch(bus: VfsEventBus, path: string) {
  bus.publish({ action: 'MUTATE', path } as any);
  bus.flushNow();
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

const SYS = 'system/config';
const USR = 'user/config';
const LAYERS = [SYS, USR];

describe('ConfigManager: 層', () => {
  let bus: VfsEventBus;

  beforeEach(() => {
    bus = new VfsEventBus();
  });

  it('後の層が勝つ', async () => {
    const files = {
      [`${SYS}/preferences.json`]: JSON.stringify({ username: 'Distributed' }),
      [`${USR}/preferences.json`]: JSON.stringify({ username: 'Ryutaro' }),
    };
    const cm = new ConfigManager(makeVfs(files), bus, LAYERS);
    await cm.loadAll();
    expect(cm.get('preferences').username).toBe('Ryutaro');
  });

  it('下の層にしか無い項目は残る（上書きは項目ごと）', async () => {
    const files = {
      [`${SYS}/preferences.json`]: JSON.stringify({ username: 'Distributed', agentName: 'Itera' }),
      [`${USR}/preferences.json`]: JSON.stringify({ username: 'Ryutaro' }),
    };
    const cm = new ConfigManager(makeVfs(files), bus, LAYERS);
    await cm.loadAll();
    expect(cm.get('preferences').username).toBe('Ryutaro');
    expect(cm.get('preferences').agentName).toBe('Itera');
  });

  it('入れ子も項目ごとに重なる', async () => {
    const files = {
      [`${SYS}/appearance.json`]: JSON.stringify({ typography: { uiFont: 'serif', fontSize: 'large' } }),
      [`${USR}/appearance.json`]: JSON.stringify({ typography: { fontSize: 'small' } }),
    };
    const cm = new ConfigManager(makeVfs(files), bus, LAYERS);
    await cm.loadAll();
    expect(cm.get('appearance').typography?.uiFont).toBe('serif');
    expect(cm.get('appearance').typography?.fontSize).toBe('small');
  });

  it('壊れている層は飛ばし、そこまでに積んだ値は保つ', async () => {
    const files = {
      [`${SYS}/preferences.json`]: JSON.stringify({ username: 'Distributed' }),
      [`${USR}/preferences.json`]: '{ これは JSON ではない',
    };
    const cm = new ConfigManager(makeVfs(files), bus, LAYERS);
    await cm.loadAll();
    // 既定へ丸ごと戻らず、下の層の値が生きている
    expect(cm.get('preferences').username).toBe('Distributed');
  });

  it('層が無ければコードの既定になる', async () => {
    const cm = new ConfigManager(makeVfs({}), bus, LAYERS);
    await cm.loadAll();
    expect(cm.get('preferences').username).toBe('User');
  });

  it('update() は最後の層へ書く（配信の層には触らない）', async () => {
    const files: Record<string, string> = {
      [`${SYS}/preferences.json`]: JSON.stringify({ username: 'Distributed' }),
    };
    const cm = new ConfigManager(makeVfs(files), bus, LAYERS);
    await cm.loadAll();
    await cm.update('preferences', { username: 'Ryutaro' });

    expect(JSON.parse(files[`${SYS}/preferences.json`]).username).toBe('Distributed');
    expect(JSON.parse(files[`${USR}/preferences.json`]).username).toBe('Ryutaro');
  });

  it('🔴 書くのは差分だけ —— 下の層の値を写し取らない', async () => {
    const files: Record<string, string> = {
      [`${SYS}/preferences.json`]: JSON.stringify({ username: 'Distributed', agentName: 'Itera' }),
    };
    const cm = new ConfigManager(makeVfs(files), bus, LAYERS);
    await cm.loadAll();
    await cm.update('preferences', { username: 'Ryutaro' });

    const written = JSON.parse(files[`${USR}/preferences.json`]);
    expect(written).toEqual({ username: 'Ryutaro' });
    // 触っていない項目を写していない（写すと下の層が固まる）
    expect(Object.prototype.hasOwnProperty.call(written, 'agentName')).toBe(false);
  });

  it('🔴 上書きしたあとでも、配信側の別の項目の変更は届く', async () => {
    const files: Record<string, string> = {
      [`${SYS}/preferences.json`]: JSON.stringify({ username: 'Distributed', agentName: 'Itera' }),
    };
    const cm = new ConfigManager(makeVfs(files), bus, LAYERS);
    await cm.loadAll();
    await cm.update('preferences', { username: 'Ryutaro' });

    // 配信が agentName を変えた（OS 更新）
    files[`${SYS}/preferences.json`] = JSON.stringify({ username: 'Distributed', agentName: 'Aria' });
    await touch(bus, `${SYS}/preferences.json`);

    expect(cm.get('preferences').agentName).toBe('Aria'); // 届く
    expect(cm.get('preferences').username).toBe('Ryutaro'); // 利用者の上書きは残る
  });

  it('同じ値に戻したら、上書きしていない状態に戻る', async () => {
    const files: Record<string, string> = {
      [`${SYS}/preferences.json`]: JSON.stringify({ username: 'Distributed' }),
    };
    const cm = new ConfigManager(makeVfs(files), bus, LAYERS);
    await cm.loadAll();
    await cm.update('preferences', { username: 'Ryutaro' });
    await cm.update('preferences', { username: 'Distributed' });

    expect(JSON.parse(files[`${USR}/preferences.json`])).toEqual({});
    expect(cm.get('preferences').username).toBe('Distributed');
  });

  it('どの層のファイルが変わっても拾う', async () => {
    const files: Record<string, string> = {
      [`${SYS}/llm.json`]: JSON.stringify({ model: 'a' }),
    };
    const cm = new ConfigManager(makeVfs(files), bus, LAYERS);
    await cm.loadAll();

    files[`${USR}/llm.json`] = JSON.stringify({ model: 'b' });
    await touch(bus, `${USR}/llm.json`);
    expect(cm.get('llm').model).toBe('b');

    files[`${SYS}/llm.json`] = JSON.stringify({ model: 'c' });
    await touch(bus, `${SYS}/llm.json`);
    expect(cm.get('llm').model).toBe('b'); // 上の層が勝ち続ける
  });

  it('層が 1 つのときは、これまでと同じ場所を読み書きする', async () => {
    const files: Record<string, string> = {};
    const cm = new ConfigManager(makeVfs(files), bus, [SYS]);
    await cm.loadAll();
    await cm.update('preferences', { username: 'Ryutaro' });

    expect(Object.keys(files)).toEqual([`${SYS}/preferences.json`]);
    expect(JSON.parse(files[`${SYS}/preferences.json`])).toEqual({ username: 'Ryutaro' });
  });
});
