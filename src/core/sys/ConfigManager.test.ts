import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigManager } from './ConfigManager';
import { VfsEventBus } from '../vfs/VfsEventBus';

/**
 * 「設定が変わったか」を判定するのは ConfigManager である（T-0304）。
 *
 * 背景: 設定アプリは 1 回の保存で 4 本まとめて書く（preferences / llm / network / appearance）。
 * モデル名しか変えていなくても 4 本書かれ、そのうち 3 本は中身が同じ書き直しである。
 * 「ファイルが書かれた」を「設定が変わった」として配ると、購読者は空振りを強いられる。
 * 旧値と新値を同時に持つのはここだけなので、この判定はここにしか置けない。
 */

/** VFS の代わり。ファイルの中身を文字列で持つだけ */
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

/** VFS の書き込み 1 本ぶんの通知（束ねの窓を待たずに流し込む） */
async function touch(bus: VfsEventBus, path: string) {
  bus.publish({ action: 'MUTATE', path } as any);
  bus.flushNow();
  // 購読者は async（読み込みを待つ）ので、マイクロタスクを数回回す
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

const CONFIG = 'system/config';

describe('ConfigManager: 値が変わったときだけ知らせる', () => {
  let bus: VfsEventBus;
  let notified: number;

  beforeEach(() => {
    bus = new VfsEventBus();
    notified = 0;
  });

  function boot(files: Record<string, string>) {
    const cm = new ConfigManager(makeVfs(files), bus);
    cm.onUpdate(() => {
      notified++;
    });
    return cm;
  }

  it('中身が同じ書き直しでは知らせない（updatedAt だけが変わる書き込み）', async () => {
    const files = { [`${CONFIG}/preferences.json`]: JSON.stringify({ username: 'Ryutaro' }) };
    boot(files);

    await touch(bus, `${CONFIG}/preferences.json`); // 既定から変わるので鳴る
    expect(notified).toBe(1);

    await touch(bus, `${CONFIG}/preferences.json`); // 同じ中身を書き直しただけ
    expect(notified).toBe(1);
  });

  it('中身が変われば知らせる', async () => {
    const files = { [`${CONFIG}/preferences.json`]: JSON.stringify({ username: 'Ryutaro' }) };
    const cm = boot(files);

    await touch(bus, `${CONFIG}/preferences.json`);
    expect(notified).toBe(1);

    files[`${CONFIG}/preferences.json`] = JSON.stringify({ username: 'Taro' });
    await touch(bus, `${CONFIG}/preferences.json`);

    expect(notified).toBe(2);
    expect(cm.get('preferences').username).toBe('Taro');
  });

  it('キーの並びが違うだけなら知らせない', async () => {
    const files = {
      [`${CONFIG}/network.json`]: JSON.stringify({ proxyUrl: 'https://a/', allowCredentialsWithProxy: true }),
    };
    boot(files);

    await touch(bus, `${CONFIG}/network.json`);
    expect(notified).toBe(1);

    files[`${CONFIG}/network.json`] = JSON.stringify({ allowCredentialsWithProxy: true, proxyUrl: 'https://a/' });
    await touch(bus, `${CONFIG}/network.json`);

    expect(notified).toBe(1);
  });

  it('本番の順を写す: 設定アプリの 4 本まとめ書きで、変わったのが 1 本なら通知も 1 回', async () => {
    const files = {
      [`${CONFIG}/preferences.json`]: JSON.stringify({ username: 'Ryutaro' }),
      [`${CONFIG}/llm.json`]: JSON.stringify({ model: 'gemini-3.6-flash' }),
      [`${CONFIG}/network.json`]: JSON.stringify({ proxyUrl: 'https://a/' }),
      [`${CONFIG}/appearance.json`]: JSON.stringify({ theme: 'system/themes/dark.json' }),
    };
    boot(files);

    // 起動時のぶん（既定との差）を先に消化しておく
    for (const name of ['preferences', 'llm', 'network', 'appearance']) {
      await touch(bus, `${CONFIG}/${name}.json`);
    }
    notified = 0;

    // モデル名だけを変えて保存 —— 書かれるのは 4 本、間隔は束ねの窓より広いので別々に届く
    files[`${CONFIG}/llm.json`] = JSON.stringify({ model: 'claude-opus-5' });
    await touch(bus, `${CONFIG}/preferences.json`);
    await touch(bus, `${CONFIG}/llm.json`);
    await touch(bus, `${CONFIG}/network.json`);
    await touch(bus, `${CONFIG}/appearance.json`);

    expect(notified).toBe(1);
  });

  it('apps.json と services.json は別のマネージャの持ち物なので、触れても知らせない', async () => {
    boot({ [`${CONFIG}/apps.json`]: '{}', [`${CONFIG}/services.json`]: '{}' });

    await touch(bus, `${CONFIG}/apps.json`);
    await touch(bus, `${CONFIG}/services.json`);

    expect(notified).toBe(0);
  });

  it('update() は値を変えたときだけ知らせる（変えた者が知らせる）', async () => {
    const files: Record<string, string> = {};
    const cm = boot(files);

    await cm.update('preferences', { username: 'Ryutaro' });
    expect(notified).toBe(1);

    await cm.update('preferences', { username: 'Ryutaro' }); // 同じ値
    expect(notified).toBe(1);
  });

  it('変わったカテゴリの名前を伝える（購読者が「自分に関わるか」を決められるように）', async () => {
    const files = {
      [`${CONFIG}/llm.json`]: JSON.stringify({ model: 'gemini-3.6-flash' }),
      [`${CONFIG}/appearance.json`]: JSON.stringify({ theme: 'system/themes/dark.json' }),
    };
    const cm = new ConfigManager(makeVfs(files), bus);
    const seen: string[][] = [];
    cm.onUpdate((_config, changed) => seen.push([...changed].sort()));

    await touch(bus, `${CONFIG}/llm.json`);
    await touch(bus, `${CONFIG}/appearance.json`);
    seen.length = 0;

    files[`${CONFIG}/llm.json`] = JSON.stringify({ model: 'claude-opus-5' });
    await touch(bus, `${CONFIG}/llm.json`);
    await touch(bus, `${CONFIG}/appearance.json`); // 中身は同じ（設定アプリのまとめ書き）

    expect(seen).toEqual([['llm']]);
  });

  it('update() の書き込みで飛ぶイベントは、二重には鳴らさない', async () => {
    const files: Record<string, string> = {};
    const cm = boot(files);

    await cm.update('preferences', { username: 'Ryutaro' });
    expect(notified).toBe(1);

    // 書き込みが VFS イベントとして返ってくる（本番と同じ経路）
    await touch(bus, `${CONFIG}/preferences.json`);

    expect(notified).toBe(1);
  });
});
