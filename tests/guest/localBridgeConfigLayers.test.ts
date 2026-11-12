import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * tests/guest/localBridgeConfigLayers.test.ts
 * Local Bridge の設定は OS の設定の層から読み書きする — T-0831
 *
 * 以前はデーモン・設定アプリ・ホームが `system/config/local_bridge.json` を `MetaOS.fs` で直接読み書きしていた。
 * 設定の層（配信の既定 → 利用者の上書き。itera2 は `user/config/`）を通らないので、利用者の層にある設定を見ず、
 * 設定が無いと見なして既定（127.0.0.1:8001）に繋いだ。
 */

const FILES = {
  daemon: 'vfs_root/system/services/local_bridge.html',
  settings: 'vfs_root/system/apps/local_bridge_settings.html',
  home: 'vfs_root/system/apps/home.html',
};
const read = (rel: string) => readFileSync(resolve(__dirname, '../..', rel), 'utf-8');

describe('Local Bridge の設定の読み書き', () => {
  for (const [name, rel] of Object.entries(FILES)) {
    it(`${name}: 設定のファイルを直接読み書きしない`, () => {
      const src = read(rel);
      expect(src.includes('local_bridge.json')).toBe(false);
    });
  }

  it('デーモン: getConfig で読み、updateConfig で書く', () => {
    const src = read(FILES.daemon);
    expect(src).toMatch(/const CONFIG_CATEGORY = 'local_bridge';/);
    expect(src).toMatch(/MetaOS\.system\.getConfig\(CONFIG_CATEGORY\)/);
    expect((src.match(/MetaOS\.system\.updateConfig\(CONFIG_CATEGORY, /g) || []).length).toBe(2);
  });

  it('設定アプリ: 読む 2 か所と書く 1 か所が層を通る', () => {
    const src = read(FILES.settings);
    expect(src).toMatch(/const CONFIG_CATEGORY = 'local_bridge';/);
    expect((src.match(/cfg = await readConfig\(\);/g) || []).length).toBe(2);
    expect(src).toMatch(/MetaOS\.system\.updateConfig\(CONFIG_CATEGORY, next\)/);
  });

  it('ホーム: 層から読み、変わったら読み直す', () => {
    const src = read(FILES.home);
    expect(src).toMatch(/App\.Config\.get\('local_bridge'\)/);
    expect(src).toMatch(/App\.Config\.onChange\('local_bridge', \(\) => loadBridge\(\)\)/);
  });
});
