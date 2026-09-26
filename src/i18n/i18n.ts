/**
 * src/i18n/i18n.ts
 * ホストの UI の文（P-0046 / T-0545）。
 *
 * ■ 形
 *   - 英語の辞書はホストの TS（messages_en.ts）に持つ。VFS が空でもホストは英語で動く
 *   - VFS の言語ファイル（`system/locales` → `user/locales` の順。後が勝つ）を英語の上に重ねる。欠けた鍵は英語に落ちる
 *   - 読むのは LocaleService（VFS と設定を知っている）。ここは VFS を知らない —— 渡された辞書を引くだけ
 *   - 鍵は意味の名前（`explorer.menu.delete`）。鍵の型は英語の辞書から作るので、打ち間違いは型検査で落ちる
 *
 * ■ 訳すのは人だけが見る面（ボタン・ラベル・通知の枠・ダイアログ）
 *   AI の文脈に入る文（ツールの出力・例外の本文・チャット欄のイベント文・ログ）は訳さず英語に固定する
 *   （2026-09-26 山内さん「AI は何語でも読めるので英語で固定で良い」）。UI の言語で AI への文が変わると、
 *   「UI 言語と AI の応答言語は別」という線が崩れる。
 *
 * ■ 🔴 訳文は文字列として扱う（HTML として解釈しない）
 *   利用者の層（itera2 では全端末へ同期される）が注入の経路にならないように、`t()` の結果は textContent に入れる。
 *   innerHTML の雛形に埋めるときは必ず escapeHtml を通す。
 *
 * ■ 描くときに引く
 *   文は描画のときに辞書を引く（焼き込まない）。切り替えたら onChange の購読者が描き直す。
 *   静的な要素は `data-i18n` の属性を付けておけば、applyStaticTexts がまとめて当て直す（staticTexts.ts）。
 */

import { EN, type MessageKey } from './messages_en';
import { DEFAULT_LOCALE, DEFAULT_LOCALE_MESSAGES } from '../config/config_layers';

export type { MessageKey } from './messages_en';

/** 複数形の形（Intl.PluralRules の区分）。other は必須。 */
export interface PluralForms {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
}

export type Message = string | PluralForms;
export type Messages = Record<string, Message>;
export type MessageParams = Record<string, string | number>;

const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;

/** 言語ファイルの 1 項目として受け入れられる形か。壊れた値は捨てる（英語に落ちる）。 */
export function isMessage(value: unknown): value is Message {
  if (typeof value === 'string') return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.other !== 'string') return false;
  return Object.keys(obj).every(
    (k) => (PLURAL_CATEGORIES as readonly string[]).includes(k) && typeof obj[k] === 'string',
  );
}

/** 受け取った辞書から、形の正しい項目だけを残す。 */
export function sanitizeMessages(raw: unknown): Messages {
  const out: Messages = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isMessage(value)) out[key] = value;
  }
  return out;
}

/** 言語の名前を正規の形にする（`zh-hans` → `zh-Hans`）。読めなければそのまま。 */
export function canonicalLocale(tag: string): string {
  const trimmed = String(tag || '').trim();
  if (!trimmed) return 'en';
  try {
    return Intl.getCanonicalLocales(trimmed)[0] || trimmed;
  } catch {
    return trimmed;
  }
}

/**
 * 探す順（一般 → 個別）。`zh-Hant-TW` → ['zh', 'zh-Hant', 'zh-Hant-TW']。
 * 重ねる順なので、後ろ（より個別）が勝つ。
 */
export function localeChain(tag: string): string[] {
  const parts = canonicalLocale(tag).split('-');
  const chain: string[] = [];
  for (let i = 1; i <= parts.length; i++) chain.push(parts.slice(0, i).join('-'));
  return chain;
}

/** `{name}` を差し込む。無い引数の印はそのまま残す（欠けが目に見えるように）。 */
export function interpolate(text: string, params: MessageParams | undefined, locale: string): string {
  if (!params) return text;
  return text.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return whole;
    const value = params[name];
    if (typeof value === 'number') {
      try {
        return value.toLocaleString(locale);
      } catch {
        return String(value);
      }
    }
    return String(value);
  });
}

function pluralCategory(locale: string, count: number): string {
  try {
    return new Intl.PluralRules(locale).select(count);
  } catch {
    return count === 1 ? 'one' : 'other';
  }
}

/** 1 項目を文にする。複数形なら params.count で形を選ぶ。 */
export function formatMessage(message: Message, params: MessageParams | undefined, locale: string): string {
  let text: string;
  if (typeof message === 'string') {
    text = message;
  } else {
    const count = typeof params?.count === 'number' ? params.count : Number.NaN;
    const category = Number.isFinite(count) ? pluralCategory(locale, count) : 'other';
    text = (message as unknown as Record<string, string | undefined>)[category] ?? message.other;
  }
  return interpolate(text, params, locale);
}

/** 切り替えの控え（localStorage）。起動の最初（VFS が読める前）から同じ言語で描くため。 */
export const I18N_CACHE_KEY = 'itera.i18n.v1';

interface CacheShape {
  locale: string;
  messages: Messages;
}

function readCache(): CacheShape | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(I18N_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.locale !== 'string') return null;
    return { locale: parsed.locale, messages: sanitizeMessages(parsed.messages) };
  } catch {
    return null;
  }
}

function writeCache(value: CacheShape): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (value.locale === 'en' && Object.keys(value.messages).length === 0) {
      localStorage.removeItem(I18N_CACHE_KEY);
      return;
    }
    localStorage.setItem(I18N_CACHE_KEY, JSON.stringify(value));
  } catch {
    /* 控えが書けなくても、次の起動で VFS から読み直すだけ */
  }
}

export type I18nListener = (locale: string) => void;

export class I18n {
  private _locale = 'en';
  private overlay: Messages = {};
  private readonly base: Messages;
  private listeners = new Set<I18nListener>();
  private readonly persist: boolean;

  /**
   * @param opts.initialLocale / opts.initialMessages 控えが無いときに使う言語と、英語の上に重ねる辞書
   *   （配布物の既定の言語。Itera は en で辞書なし、ミャク楽は ja と同梱の辞書。T-0554 / T-0556）。VFS を読んだあとは LocaleService が差し替える。
   */
  constructor(
    base: Messages = EN,
    opts: { persist?: boolean; initialLocale?: string; initialMessages?: unknown } = {},
  ) {
    this.base = base;
    this.persist = opts.persist ?? false;
    if (opts.initialLocale) {
      this._locale = canonicalLocale(opts.initialLocale);
      this.overlay = sanitizeMessages(opts.initialMessages);
    }
    if (this.persist) {
      const cached = readCache();
      if (cached) {
        this._locale = cached.locale;
        this.overlay = cached.messages;
      }
    }
  }

  get locale(): string {
    return this._locale;
  }

  /**
   * 言語と、英語の上に重ねる辞書を差し替える。中身が変わったときだけ購読者へ知らせる
   * （同じものを読み直しただけで画面を描き直さない。T-0304）。
   */
  set(locale: string, overlay: Messages): boolean {
    const next = { locale: canonicalLocale(locale), messages: sanitizeMessages(overlay) };
    const same = next.locale === this._locale && JSON.stringify(next.messages) === JSON.stringify(this.overlay);
    if (same) return false;
    this._locale = next.locale;
    this.overlay = next.messages;
    if (this.persist) writeCache(next);
    for (const cb of [...this.listeners]) {
      try {
        cb(this._locale);
      } catch (e) {
        console.warn('[i18n] A listener failed', e);
      }
    }
    return true;
  }

  /** 文を引く。重ねた辞書 → 英語 → 鍵そのもの の順に落ちる。 */
  t(key: MessageKey, params?: MessageParams): string {
    const message = this.overlay[key] ?? this.base[key];
    if (message === undefined) return key;
    return formatMessage(message, params, this._locale);
  }

  /** 型の無い鍵（`data-i18n` の属性など）から引く。 */
  tRaw(key: string, params?: MessageParams): string {
    return this.t(key as MessageKey, params);
  }

  has(key: string): boolean {
    return key in this.overlay || key in this.base;
  }

  /** 言語が切り替わったら呼ぶ。戻り値を呼ぶと外れる。 */
  onChange(cb: I18nListener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** 日付・時刻を今の言語で書く。 */
  formatDate(value: Date | number, options?: Intl.DateTimeFormatOptions): string {
    const date = value instanceof Date ? value : new Date(value);
    try {
      return date.toLocaleString(this._locale, options);
    } catch {
      return date.toLocaleString('en', options);
    }
  }
}

/** ホスト全体で 1 つ。 */
export const i18n = new I18n(EN, {
  persist: true,
  initialLocale: DEFAULT_LOCALE,
  initialMessages: DEFAULT_LOCALE_MESSAGES,
});

/** 文を引く。`t('explorer.menu.delete')`。 */
export function t(key: MessageKey, params?: MessageParams): string {
  return i18n.t(key, params);
}

/** innerHTML の雛形に文を埋めるときに通す。 */
export function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
