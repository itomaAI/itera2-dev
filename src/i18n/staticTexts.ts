/**
 * src/i18n/staticTexts.ts
 * 属性で印を付けた要素の文を、今の言語で当て直す（P-0046 / T-0545）。
 *
 *   data-i18n="key"             … textContent
 *   data-i18n-title="key"       … title
 *   data-i18n-placeholder="key" … placeholder
 *   data-i18n-aria-label="key"  … aria-label
 *   data-i18n-params='{"n":1}'  … 引数（JSON）。上の全部に効く
 *
 * index.html に直書きした文字と、一度だけ組み立てて持ち続ける部品の文字はこれで追随させる。
 * 🔴 data-i18n は textContent を置き換えるので、子要素（アイコンなど）を持つ要素に付けない。文字だけの span に付ける。
 */

import { i18n, type I18n, type MessageKey, type MessageParams } from './i18n';

const ATTRS: ReadonlyArray<[string, string | null]> = [
  ['data-i18n', null],
  ['data-i18n-title', 'title'],
  ['data-i18n-placeholder', 'placeholder'],
  ['data-i18n-aria-label', 'aria-label'],
];

function paramsOf(el: Element): MessageParams | undefined {
  const raw = el.getAttribute('data-i18n-params');
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** root の下（root 自身を含む）の印の付いた要素を当て直す。 */
export function applyStaticTexts(root: ParentNode & Node = document, source: I18n = i18n): void {
  for (const [attr, target] of ATTRS) {
    const found: Element[] = [];
    if (root instanceof Element && root.hasAttribute(attr)) found.push(root);
    root.querySelectorAll(`[${attr}]`).forEach((el) => found.push(el));
    for (const el of found) {
      const key = el.getAttribute(attr);
      if (!key) continue;
      const text = source.tRaw(key, paramsOf(el));
      if (target === null) {
        if (el.textContent !== text) el.textContent = text;
      } else if (el.getAttribute(target) !== text) {
        el.setAttribute(target, text);
      }
    }
  }
}

/**
 * 要素に文の印を付けて、いまの言語で書く。組み立てた部品が切り替えに追随するようにするため。
 * 引数を持つ文は params を渡す（属性に JSON で残る）。
 */
export function bindText<T extends Element>(
  el: T,
  key: MessageKey,
  params?: MessageParams,
  attr: 'text' | 'title' | 'placeholder' | 'aria-label' = 'text',
): T {
  const name = attr === 'text' ? 'data-i18n' : `data-i18n-${attr}`;
  el.setAttribute(name, key);
  if (params) el.setAttribute('data-i18n-params', JSON.stringify(params));
  else el.removeAttribute('data-i18n-params');
  applyStaticTexts(el);
  return el;
}

/** 言語が切り替わるたびに文書全体を当て直す。起動の最初に 1 度呼ぶ。 */
export function startStaticTexts(doc: Document = document, source: I18n = i18n): () => void {
  applyStaticTexts(doc, source);
  return source.onChange(() => applyStaticTexts(doc, source));
}
