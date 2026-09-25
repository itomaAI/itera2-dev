// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { I18n, canonicalLocale, localeChain, sanitizeMessages, formatMessage, escapeHtml, isMessage } from './i18n';
import { applyStaticTexts, bindText, startStaticTexts } from './staticTexts';

/**
 * ホストの文（P-0046 / T-0545）。
 * 欠けた鍵は英語に落ちる・切り替えは中身が変わったときだけ知らせる・訳文は文字列として扱う。
 */
const BASE = {
  'a.hello': 'Hello',
  'a.greet': 'Hello, {name}',
  'a.files': { one: '{count} file', other: '{count} files' },
} as any;

describe('I18n', () => {
  it('重ねた辞書に無い鍵は英語に落ちる。英語にも無ければ鍵そのもの', () => {
    const i = new I18n(BASE);
    i.set('ja', { 'a.hello': 'こんにちは' });
    expect(i.t('a.hello' as any)).toBe('こんにちは');
    expect(i.t('a.greet' as any, { name: 'X' })).toBe('Hello, X');
    expect(i.tRaw('no.such.key')).toBe('no.such.key');
  });

  it('引数を差し込む。無い引数の印は残す。数は言語の書き方にする', () => {
    expect(formatMessage('{a} and {b}', { a: 'x' }, 'en')).toBe('x and {b}');
    expect(formatMessage('{n}', { n: 12345 }, 'en')).toBe('12,345');
    expect(formatMessage('{n}', { n: 12345 }, 'de')).toBe('12.345');
  });

  it('複数形は count で選ぶ（英語は one / other、日本語は other だけ）', () => {
    const i = new I18n(BASE);
    expect(i.t('a.files' as any, { count: 1 })).toBe('1 file');
    expect(i.t('a.files' as any, { count: 3 })).toBe('3 files');
    i.set('ja', { 'a.files': { other: '{count} 件' } });
    expect(i.t('a.files' as any, { count: 1 })).toBe('1 件');
    // 訳が文字列でも受け入れる
    i.set('ja', { 'a.files': '{count} 個' });
    expect(i.t('a.files' as any, { count: 2 })).toBe('2 個');
  });

  it('count が無ければ other を使う', () => {
    expect(formatMessage({ one: 'one', other: 'many' }, undefined, 'en')).toBe('many');
  });

  it('形の壊れた項目は捨てる（英語に落ちる）', () => {
    const clean = sanitizeMessages({
      ok: 'x',
      num: 3,
      arr: ['a'],
      noOther: { one: 'a' },
      badForm: { other: 'a', lots: 'b' },
      plural: { one: 'a', other: 'b' },
    });
    expect(Object.keys(clean).sort()).toEqual(['ok', 'plural']);
    expect(sanitizeMessages(null)).toEqual({});
    expect(sanitizeMessages(['x'])).toEqual({});
    expect(isMessage({ other: 'x' })).toBe(true);
  });

  it('中身が変わったときだけ購読者に知らせる', () => {
    const i = new I18n(BASE);
    const cb = vi.fn();
    const off = i.onChange(cb);
    expect(i.set('ja', { 'a.hello': 'こんにちは' })).toBe(true);
    expect(i.set('ja', { 'a.hello': 'こんにちは' })).toBe(false);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('ja');
    off();
    i.set('en', {});
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('購読者が落ちても他の購読者には届く', () => {
    const i = new I18n(BASE);
    const good = vi.fn();
    i.onChange(() => {
      throw new Error('boom');
    });
    i.onChange(good);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    i.set('fr', {});
    expect(good).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('控え（localStorage）から起動の最初の言語を取り戻す', () => {
    localStorage.clear();
    const a = new I18n(BASE, { persist: true });
    a.set('ja', { 'a.hello': 'こんにちは' });
    const b = new I18n(BASE, { persist: true });
    expect(b.locale).toBe('ja');
    expect(b.t('a.hello' as any)).toBe('こんにちは');
    // 英語に戻したら控えは消える
    b.set('en', {});
    expect(localStorage.getItem('itera.i18n.v1')).toBeNull();
    localStorage.clear();
  });

  it('壊れた控えは無視する', () => {
    localStorage.setItem('itera.i18n.v1', '{broken');
    const i = new I18n(BASE, { persist: true });
    expect(i.locale).toBe('en');
    localStorage.clear();
  });
});

describe('言語の名前', () => {
  it('正規の形にする', () => {
    expect(canonicalLocale('zh-hans')).toBe('zh-Hans');
    expect(canonicalLocale('JA-jp')).toBe('ja-JP');
    expect(canonicalLocale('')).toBe('en');
    expect(canonicalLocale('!!')).toBe('!!');
  });

  it('探す順は一般 → 個別（後が勝つ）', () => {
    expect(localeChain('zh-Hant-TW')).toEqual(['zh', 'zh-Hant', 'zh-Hant-TW']);
    expect(localeChain('ja')).toEqual(['ja']);
  });
});

describe('escapeHtml', () => {
  it('HTML の記号を消す', () => {
    expect(escapeHtml(`<img src=x onerror="a('b')">&`)).toBe('&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
  });
});

describe('静的な文（data-i18n）', () => {
  it('属性で印を付けた要素を当て直し、切り替えに追随する', () => {
    const i = new I18n(BASE);
    document.body.innerHTML = `
      <span id="a" data-i18n="a.hello">Hello</span>
      <button id="b" data-i18n-title="a.greet" data-i18n-params='{"name":"Z"}'></button>
      <input id="c" data-i18n-placeholder="a.hello" />`;
    const off = startStaticTexts(document, i);
    expect(document.getElementById('b')!.getAttribute('title')).toBe('Hello, Z');
    i.set('ja', { 'a.hello': 'こんにちは', 'a.greet': 'やあ {name}' });
    expect(document.getElementById('a')!.textContent).toBe('こんにちは');
    expect(document.getElementById('b')!.getAttribute('title')).toBe('やあ Z');
    expect(document.getElementById('c')!.getAttribute('placeholder')).toBe('こんにちは');
    off();
  });

  it('訳文は文字列として入る（HTML にならない）', () => {
    const i = new I18n(BASE);
    i.set('xx', { 'a.hello': '<b id="evil">x</b>' });
    document.body.innerHTML = `<span id="a" data-i18n="a.hello"></span>`;
    applyStaticTexts(document, i);
    expect(document.getElementById('evil')).toBeNull();
    expect(document.getElementById('a')!.textContent).toBe('<b id="evil">x</b>');
  });

  it('bindText は印を付けて今の言語で書く', () => {
    const el = document.createElement('span');
    bindText(el, 'common.cancel');
    expect(el.getAttribute('data-i18n')).toBe('common.cancel');
    expect(el.textContent).toBe('Cancel');
    bindText(el, 'notice.repairFailed', { reason: 'r' });
    expect(el.textContent).toBe('Repair failed: r');
    bindText(el, 'common.ok');
    expect(el.hasAttribute('data-i18n-params')).toBe(false);
  });
});
