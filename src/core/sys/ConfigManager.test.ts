import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigManager, DEFAULT_HOME_PATH } from './ConfigManager';
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

describe('ConfigManager.homePath: ホームの既定は 1 か所（T-0316 / T-0533）', () => {
  const boot = async (files: Record<string, string>) => {
    const cm = new ConfigManager(makeVfs(files), new VfsEventBus());
    await cm.loadAll();
    return cm;
  };

  it('設定が無ければ既定（system/apps/home.html）', async () => {
    const cm = await boot({});
    expect(cm.homePath()).toBe(DEFAULT_HOME_PATH);
    expect(DEFAULT_HOME_PATH).toBe('system/apps/home.html');
  });

  it('設定があればそれを使う（自分用のコピーを指せる）', async () => {
    const cm = await boot({
      [`${CONFIG}/appearance.json`]: JSON.stringify({ layout: { homePath: 'apps/home.html' } }),
    });
    expect(cm.homePath()).toBe('apps/home.html');
  });

  it('空文字（設定画面で欄を空にした）なら既定へ落とす', async () => {
    const cm = await boot({ [`${CONFIG}/appearance.json`]: JSON.stringify({ layout: { homePath: '  ' } }) });
    expect(cm.homePath()).toBe(DEFAULT_HOME_PATH);
  });
});

/**
 * 既定以外の分類も、訊かれたときに層から読む（T-0553）。
 *
 * 背景: 起動時に読むのは既定の分類（preferences / appearance / llm / network）だけで、
 * それ以外（home.json・credentials.json など）はファイルが書かれるまで控えに無かった。
 * ゲストの口は「控えにあるか」で断っていたので、同じファイルが「その回のうちに書かれたか」で
 * 読めたり読めなかったりした。起動直後の oauth は、空の控えに 1 件足して書き、保存済みの鍵を消しえた。
 */
describe('ConfigManager.ensure: 起動後に触っていない分類も層から読む', () => {
  let bus: VfsEventBus;

  beforeEach(() => {
    bus = new VfsEventBus();
  });

  it('起動してから一度も書かれていない分類を読める', async () => {
    const files = { [`${CONFIG}/home.json`]: JSON.stringify({ contextCutAt: 400000 }) };
    const cm = new ConfigManager(makeVfs(files), bus);
    await cm.loadAll();
    expect(cm.get('home')).toBeUndefined(); // 起動時には読まない（既定の分類ではない）
    expect(await cm.ensure('home')).toEqual({ contextCutAt: 400000 });
    expect(cm.get('home')).toEqual({ contextCutAt: 400000 });
  });

  it('層を重ねて読む（後の層が勝つ）', async () => {
    const files = {
      'system/config/home.json': JSON.stringify({ a: 1, w: { lat: 1, label: 'Tokyo' } }),
      'user/config/home.json': JSON.stringify({ w: { label: 'Osaka' } }),
    };
    const cm = new ConfigManager(makeVfs(files), bus, ['system/config', 'user/config']);
    expect(await cm.ensure('home')).toEqual({ a: 1, w: { lat: 1, label: 'Osaka' } });
  });

  it('どの層にも無い分類は {} を返し、ファイルは作らない', async () => {
    const files: Record<string, string> = {};
    const cm = new ConfigManager(makeVfs(files), bus);
    expect(await cm.ensure('nothing_here')).toEqual({});
    expect(Object.keys(files)).toEqual([]);
  });

  it('パスとして読まれうる名前は断る', async () => {
    const cm = new ConfigManager(makeVfs({}), bus);
    for (const bad of ['../secret', 'a/b', 'x.json', '', ' home']) {
      await expect(cm.ensure(bad)).rejects.toThrow('Invalid config category');
    }
  });

  it('まだ読んでいない分類に update しても、ファイルにある既存のキーを消さない', async () => {
    const files = {
      [`${CONFIG}/credentials.json`]: JSON.stringify({ github: { type: 'header', key: 'Authorization', value: 'x' } }),
    };
    const cm = new ConfigManager(makeVfs(files), bus, [CONFIG]); // 書き先を見るので層を 1 つに固定する（itera2 の既定は 2 層）
    await cm.loadAll();
    await cm.update('credentials', { google: { type: 'header', key: 'Authorization', value: 'y' } });
    const saved = JSON.parse(files[`${CONFIG}/credentials.json`]);
    expect(Object.keys(saved).sort()).toEqual(['github', 'google']);
  });

  it('新しい分類を update で作ると、変わったとして知らせる', async () => {
    const files: Record<string, string> = {};
    const cm = new ConfigManager(makeVfs(files), bus, [CONFIG]); // 書き先を見るので層を 1 つに固定する（itera2 の既定は 2 層）
    const seen: string[][] = [];
    cm.onUpdate((_c, changed) => seen.push([...changed]));
    await cm.update('home', { contextCutAt: 300000 });
    expect(JSON.parse(files[`${CONFIG}/home.json`])).toEqual({ contextCutAt: 300000 });
    expect(seen).toEqual([['home']]);
  });

  it('2 層のとき、まだ読んでいない分類への update は最上位の層に差分だけ書き、既存のキーを保つ', async () => {
    const files: Record<string, string> = {
      'system/config/credentials.json': JSON.stringify({ github: { value: 'x' } }),
      'user/config/credentials.json': JSON.stringify({ brave: { value: 'b' } }),
    };
    const cm = new ConfigManager(makeVfs(files), bus, ['system/config', 'user/config']);
    await cm.update('credentials', { google: { value: 'y' } });
    expect(Object.keys(cm.get('credentials')).sort()).toEqual(['brave', 'github', 'google']);
    expect(JSON.parse(files['system/config/credentials.json'])).toEqual({ github: { value: 'x' } }); // 配信の層は触らない
    expect(Object.keys(JSON.parse(files['user/config/credentials.json'])).sort()).toEqual(['brave', 'google']);
  });

  it('同時に来た ensure は 1 回だけ読む', async () => {
    const files = { [`${CONFIG}/home.json`]: JSON.stringify({ a: 1 }) };
    const vfs = makeVfs(files);
    let reads = 0;
    const readFile = vfs.readFile;
    vfs.readFile = async (p: any, path: string) => {
      reads++;
      return readFile(p, path);
    };
    const cm = new ConfigManager(vfs, bus);
    const [x, y] = await Promise.all([cm.ensure('home'), cm.ensure('home')]);
    expect(x).toEqual({ a: 1 });
    expect(y).toEqual({ a: 1 });
    expect(reads).toBe(1);
    await cm.ensure('home'); // 読み終えた分類はもう読まない
    expect(reads).toBe(1);
  });
});
