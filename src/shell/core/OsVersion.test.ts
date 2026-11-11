// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import indexHtml from '../../../index.html?raw';
import mainSource from '../../main.ts?raw';
import { OS_VERSION } from '../../config/version';
import { applyOsVersion } from './OsVersion';

/**
 * OS の版（T-0805）。番号の正は src/config/version.ts の 1 か所で、画面はそこから出る。
 * 以前は index.html に `v2.0.0` と直書きしてあり、上げ忘れても誰も気づかなかった。
 */
const parse = (html: string): Document => new DOMParser().parseFromString(html, 'text/html');

describe('OS の版', () => {
  it('番号は x.y.z の形', () => {
    expect(OS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('index.html は番号を直書きせず、印の付いた要素を 1 つだけ持つ', () => {
    expect(indexHtml).not.toMatch(/>\s*v\d+\.\d+\.\d+\s*</);
    const els = parse(indexHtml).querySelectorAll('[data-os-version]');
    expect(els.length).toBe(1);
    expect(els[0].textContent?.trim()).toBe('');
  });

  it('印の付いた要素に v<番号> を書く', () => {
    const doc = parse(indexHtml);
    applyOsVersion(doc);
    expect(doc.querySelector('[data-os-version]')?.textContent).toBe(`v${OS_VERSION}`);
  });

  it('渡した番号をそのまま書く（印の無い要素には触らない）', () => {
    const doc = parse('<div data-os-version>old</div><div id="other">v0.0.1</div>');
    applyOsVersion(doc, '9.8.7');
    expect(doc.querySelector('[data-os-version]')?.textContent).toBe('v9.8.7');
    expect(doc.getElementById('other')?.textContent).toBe('v0.0.1');
  });

  it('起動の入口（main.ts）が呼んでいる', () => {
    expect(mainSource).toMatch(/applyOsVersion\(\)/);
  });
});
