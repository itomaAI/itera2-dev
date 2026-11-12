// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import bridgeSource from './guest_bridge.js?raw';
import { resolveRelativePath } from '../utils/path';

/**
 * src/api/guest_bridge.app.test.ts
 * MetaOS.app —— アプリが自分の場所を知る口（T-0822）。
 *   - GuestCompiler が入口の文書に差し込む `window.__ITERA_PATH__` から、path・dir を同期で返す
 *   - resolve(rel) は、コンパイラが静的な参照を解決するときと同じ規則（src/utils/path.ts の resolveRelativePath）。
 *     ブリッジは TS を import できないので規則の写しを持つ。ここで 2 つを同じ表で突き合わせる
 */

function loadApp(path: unknown, pid = 'p1') {
  (window as any).__ITERA_PID__ = pid;
  if (path === undefined) delete (window as any).__ITERA_PATH__;
  else (window as any).__ITERA_PATH__ = path;
  delete (window as any).MetaOS;
  window.postMessage = (() => {}) as any;
  new Function(bridgeSource)();
  return (window as any).MetaOS.app as {
    pid: string;
    path: string;
    dir: string;
    resolve: (rel?: unknown) => string;
  };
}

describe('guest_bridge.js: MetaOS.app', () => {
  it('pid・path・dir を同期で返す（await も IPC も要らない）', () => {
    const app = loadApp('apps/mine/index.html', 'mine');
    expect(app.pid).toBe('mine');
    expect(app.path).toBe('apps/mine/index.html');
    expect(app.dir).toBe('apps/mine');
  });

  it('VFS の根に在る文書の dir は空文字', () => {
    const app = loadApp('index.html');
    expect(app.path).toBe('index.html');
    expect(app.dir).toBe('');
    expect(app.resolve('data/x.json')).toBe('data/x.json');
  });

  it('パスが差し込まれていない（古いコンパイラ・404 の画面）ときは空文字で、resolve は根からになる', () => {
    for (const missing of [undefined, null, 42]) {
      const app = loadApp(missing);
      expect(app.path).toBe('');
      expect(app.dir).toBe('');
      expect(app.resolve('./a.json')).toBe('a.json');
    }
  });

  it('resolve は自分のフォルダから: ./ ../ 裸の名前は相対、先頭の / は VFS の根。根より上には出ない', () => {
    const app = loadApp('apps/mine/index.html');
    expect(app.resolve('data/items.json')).toBe('apps/mine/data/items.json');
    expect(app.resolve('./img/a.png')).toBe('apps/mine/img/a.png');
    expect(app.resolve('../shared/x.png')).toBe('apps/shared/x.png');
    expect(app.resolve('/system/lib/std.js')).toBe('system/lib/std.js');
    expect(app.resolve('../../../../above-root.txt')).toBe('above-root.txt');
    expect(app.resolve('')).toBe('apps/mine');
    expect(app.resolve()).toBe('apps/mine');
    expect(app.resolve(null)).toBe('apps/mine');
    expect(app.resolve(7)).toBe('apps/mine/7');
  });

  it('規則はコンパイラ（resolveRelativePath）と同じ —— 同じ表で突き合わせる', () => {
    const rels = [
      'a.json',
      './a.json',
      'sub/a.json',
      './sub/../a.json',
      '../a.json',
      '../../a.json',
      '../../../a.json',
      '/a.json',
      '/x/../y/./z.json',
      '',
      '.',
      './',
      '..',
      '/',
      'a//b/./c',
      'sub/',
      '日本 語/ファイル.json',
      '.hidden/x',
      '...',
    ];
    for (const path of ['index.html', 'apps/index.html', 'apps/mine/deep/index.html', 'データ/アプリ/index.html']) {
      const app = loadApp(path);
      for (const rel of rels) {
        expect(app.resolve(rel), `${path} + ${JSON.stringify(rel)}`).toBe(resolveRelativePath(app.dir, rel));
      }
    }
  });

  it('書き換えられない（アプリが誤って上書きしても、ほかのスクリプトが読む値は変わらない）', () => {
    const app = loadApp('apps/mine/index.html');
    expect(Object.isFrozen(app)).toBe(true);
    try {
      (app as any).dir = 'elsewhere';
    } catch {
      // strict mode では TypeError。どちらでも値は変わらない
    }
    expect(app.dir).toBe('apps/mine');
  });
});
