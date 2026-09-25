// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { LocaleService } from './LocaleService';
import { I18n } from '../../i18n/i18n';
import type { ConfigUpdateListener } from '../../core/sys/ConfigManager';

/**
 * 言語ファイルの重ね（P-0046 / T-0545）。
 * 英語（ホスト）← system/locales ← user/locales。言語の鎖（ja → ja-JP）は一般から個別へ。
 */
function makeEnv(files: Record<string, unknown>, locale = 'ja') {
  const store = new Map<string, string>(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  const vfs: any = {
    exists: (_p: any, path: string) => store.has(path) || [...store.keys()].some((k) => k.startsWith(`${path}/`)),
    readFile: async (_p: any, path: string) => {
      if (!store.has(path)) throw new Error('nope');
      return store.get(path)!;
    },
    listFiles: (_p: any, { path }: { path: string }) => [...store.keys()].filter((k) => k.startsWith(`${path}/`)),
  };
  const listeners: ConfigUpdateListener[] = [];
  const appearance: any = { locale };
  const configManager: any = {
    get: (c: string) => (c === 'appearance' ? appearance : undefined),
    onUpdate: (cb: ConfigUpdateListener) => {
      listeners.push(cb);
      return () => {};
    },
  };
  const subs: ((m: any[]) => void)[] = [];
  const eventBus: any = { subscribe: (cb: any) => (subs.push(cb), () => {}) };
  const target = new I18n({ 'k.a': 'A', 'k.b': 'B', 'k.c': 'C' } as any);
  const service = new LocaleService(configManager, vfs, eventBus, { target });
  return { store, appearance, listeners, subs, target, service };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('LocaleService', () => {
  it('ファイルが無ければ英語のまま（ホストは VFS が空でも動く）', async () => {
    const { service, target } = makeEnv({});
    await service.load();
    expect(target.locale).toBe('ja');
    expect(target.t('k.a' as any)).toBe('A');
    expect(document.documentElement.lang).toBe('ja');
  });

  it('user/locales が system/locales に勝ち、個別の言語が一般の言語に勝つ', async () => {
    const { service, target, appearance } = makeEnv({
      'system/locales/ja.json': { meta: { name: '日本語' }, messages: { 'k.a': 'あ(system)', 'k.b': 'い(system)' } },
      'user/locales/ja.json': { messages: { 'k.a': 'あ(user)' } },
      'system/locales/ja-JP.json': { messages: { 'k.b': 'い(ja-JP)' } },
    });
    await service.load();
    expect(target.t('k.a' as any)).toBe('あ(user)');
    expect(target.t('k.b' as any)).toBe('い(system)');
    appearance.locale = 'ja-JP';
    await service.load();
    expect(target.t('k.b' as any)).toBe('い(ja-JP)');
    expect(target.t('k.c' as any)).toBe('C');
  });

  it('ファイル名の大文字小文字を問わない', async () => {
    const { service, target } = makeEnv({ 'system/locales/zh-hans.json': { messages: { 'k.a': '甲' } } }, 'zh-Hans');
    await service.load();
    expect(target.t('k.a' as any)).toBe('甲');
  });

  it('壊れたファイルは飛ばす', async () => {
    const { service, target } = makeEnv({
      'system/locales/ja.json': { messages: { 'k.a': 'あ' } },
      'user/locales/ja.json': '{broken',
    });
    const warn = console.warn;
    console.warn = () => {};
    await service.load();
    console.warn = warn;
    expect(target.t('k.a' as any)).toBe('あ');
  });

  it('appearance の言語が変わったときだけ読み直す', async () => {
    const { service, target, appearance, listeners } = makeEnv({
      'system/locales/ja.json': { messages: { 'k.a': 'あ' } },
      'system/locales/fr.json': { messages: { 'k.a': 'à' } },
    });
    service.start();
    await service.load();
    appearance.locale = 'fr';
    listeners[0]({} as any, new Set(['llm']));
    await flush();
    expect(target.t('k.a' as any)).toBe('あ');
    listeners[0]({} as any, new Set(['appearance']));
    await flush();
    expect(target.t('k.a' as any)).toBe('à');
  });

  it('言語ファイルが書かれたら読み直す', async () => {
    const { service, target, store, subs } = makeEnv({ 'system/locales/ja.json': { messages: { 'k.a': 'あ' } } });
    service.start();
    await service.load();
    store.set('user/locales/ja.json', JSON.stringify({ messages: { 'k.a': 'あ!' } }));
    subs[0]([{ type: 'ATTACH', path: 'user/locales/ja.json' }]);
    await flush();
    expect(target.t('k.a' as any)).toBe('あ!');
    // 関係のないファイルでは読み直さない
    store.set('user/locales/ja.json', JSON.stringify({ messages: { 'k.a': 'x' } }));
    subs[0]([{ type: 'MUTATE', path: 'data/notes.json' }]);
    await flush();
    expect(target.t('k.a' as any)).toBe('あ!');
  });

  it('立て続けに読んだら最後の 1 回だけが効く', async () => {
    const { service, target, appearance } = makeEnv({
      'system/locales/ja.json': { messages: { 'k.a': 'あ' } },
      'system/locales/fr.json': { messages: { 'k.a': 'à' } },
    });
    const first = service.load();
    appearance.locale = 'fr';
    const second = service.load();
    await Promise.all([first, second]);
    expect(target.locale).toBe('fr');
    expect(target.t('k.a' as any)).toBe('à');
  });
});
