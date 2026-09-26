// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { LOCALE_LAYERS, DEFAULT_LOCALE, DEFAULT_LOCALE_MESSAGES } from './config_layers';
import { I18n, I18N_CACHE_KEY } from '../i18n/i18n';
import { EN } from '../i18n/messages_en';

/**
 * UI の言語の定数（配布物ごと。T-0556）。Itera の既定は英語で、同梱の辞書は無い。
 * 共通部品の I18n は、控え（localStorage）が無いときに配布物の既定の言語で始まる（ミャク楽 T-0554 と同じ実装）。
 */
describe('Itera の言語の定数', () => {
  it('既定の言語は en で辞書は無い。層は system/locales → user/locales', () => {
    expect(DEFAULT_LOCALE).toBe('en');
    expect(DEFAULT_LOCALE_MESSAGES).toBeUndefined();
    expect(LOCALE_LAYERS).toEqual(['system/locales', 'user/locales']);
  });

  it('既定のまま作ると、控えが無ければ英語で始まる（これまでと同じ）', () => {
    localStorage.removeItem(I18N_CACHE_KEY);
    const fresh = new I18n(EN, {
      persist: true,
      initialLocale: DEFAULT_LOCALE,
      initialMessages: DEFAULT_LOCALE_MESSAGES,
    });
    expect(fresh.locale).toBe('en');
    expect(fresh.t('boot.action.reload')).toBe(EN['boot.action.reload']);
  });

  it('initialLocale / initialMessages を渡すと控えが無いときその言語で始まり、控えがあれば控えが勝つ', () => {
    localStorage.removeItem(I18N_CACHE_KEY);
    const opts = { persist: true, initialLocale: 'ja', initialMessages: { 'boot.action.reload': '再読み込み' } };
    const fresh = new I18n(EN, opts);
    expect(fresh.locale).toBe('ja');
    expect(fresh.t('boot.action.reload')).toBe('再読み込み');

    localStorage.setItem(I18N_CACHE_KEY, JSON.stringify({ locale: 'en', messages: {} }));
    const cached = new I18n(EN, opts);
    expect(cached.locale).toBe('en');
    expect(cached.t('boot.action.reload')).toBe(EN['boot.action.reload']);
    localStorage.removeItem(I18N_CACHE_KEY);
  });
});
