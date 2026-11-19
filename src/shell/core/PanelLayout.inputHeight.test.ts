// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PanelLayout, readLayoutState } from './PanelLayout';
import indexHtml from '../../../index.html?raw';

/**
 * チャットの入力欄の高さの保存と復元（T-0884）。
 * 高さを変えるのは ChatPanel のつまみ（CSS 変数 `--chat-input-h`）。PanelLayout は実寸を観測して
 * 開閉・幅と同じ記録（localStorage）に残し、起動時に変数へ戻す。
 */

const KEY = 'itera.layout.v1';

function mount(): void {
  const m = /<body[^>]*>([\s\S]*)<\/body>/.exec(indexHtml);
  if (!m) throw new Error('index.html に body が無い');
  document.body.innerHTML = m[1];
  document.body.className = '';
}

function fakeStorage(init?: unknown): Storage & { writes: number } {
  const map = new Map<string, string>();
  if (init !== undefined) map.set(KEY, typeof init === 'string' ? init : JSON.stringify(init));
  const s = {
    writes: 0,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      s.writes++;
      map.set(k, v);
    },
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  };
  return s as unknown as Storage & { writes: number };
}

/** ResizeObserver の偽物。観察対象ごとに発火できる */
class FakeRO {
  static all: FakeRO[] = [];
  observed: Element[] = [];
  cb: () => void;
  constructor(cb: () => void) {
    this.cb = cb;
    FakeRO.all.push(this);
  }
  observe(t: Element) {
    this.observed.push(t);
  }
  disconnect() {
    this.observed = [];
  }
  static fireFor(el: Element) {
    for (const o of FakeRO.all) if (o.observed.includes(el)) o.cb();
  }
}

const input = () => document.getElementById('chat-input') as HTMLTextAreaElement;
const varH = () => input().style.getPropertyValue('--chat-input-h');
const setBox = (h: number) => Object.defineProperty(input(), 'offsetHeight', { configurable: true, get: () => h });
const setViewport = (w: number) => Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
const saved = (s: Storage) => JSON.parse(s.getItem(KEY) || '{}');

describe('readLayoutState: 入力欄の高さ', () => {
  it('正の数だけを読む。それ以外は「無い」', () => {
    expect(readLayoutState(fakeStorage({ chatInputHeight: 240 })).chatInputHeight).toBe(240);
    expect(readLayoutState(fakeStorage({ chatInputHeight: '240' })).chatInputHeight).toBeNull();
    expect(readLayoutState(fakeStorage({ chatInputHeight: -5 })).chatInputHeight).toBeNull();
    expect(readLayoutState(fakeStorage({ chatInputHeight: 0 })).chatInputHeight).toBeNull();
    expect(readLayoutState(fakeStorage({ chatWidth: 500 })).chatInputHeight).toBeNull();
    expect(readLayoutState(fakeStorage()).chatInputHeight).toBeNull();
    expect(readLayoutState(fakeStorage('{')).chatInputHeight).toBeNull();
  });
});

describe('PanelLayout: 入力欄の高さの保存と復元', () => {
  beforeEach(() => {
    mount();
    FakeRO.all = [];
    vi.stubGlobal('ResizeObserver', FakeRO);
    setViewport(1280);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setViewport(1024);
  });

  it('起動時、保存してあれば変数に戻す。無ければ何も書かない', () => {
    new PanelLayout(fakeStorage({ chatInputHeight: 240 })).init();
    expect(varH()).toBe('240px');
    mount();
    new PanelLayout(fakeStorage()).init();
    expect(varH()).toBe('');
  });

  it('観測した実寸を保存する', () => {
    const s = fakeStorage();
    new PanelLayout(s).init();
    setBox(300);
    FakeRO.fireFor(input());
    expect(saved(s).chatInputHeight).toBe(300);
    setBox(180.4);
    FakeRO.fireFor(input());
    expect(saved(s).chatInputHeight).toBe(180);
  });

  it('同じ値なら書かない', () => {
    const s = fakeStorage();
    new PanelLayout(s).init();
    setBox(300);
    FakeRO.fireFor(input());
    const n = s.writes;
    FakeRO.fireFor(input());
    expect(s.writes).toBe(n);
  });

  it('実寸が 0（チャットを畳んでいる）なら、前の値を残す', () => {
    const s = fakeStorage({ chatInputHeight: 240 });
    new PanelLayout(s).init();
    setBox(0);
    FakeRO.fireFor(input());
    expect(saved(s).chatInputHeight).toBe(240);
  });

  it('引き出し表示（幅 768 未満）では保存しない', () => {
    const s = fakeStorage({ chatInputHeight: 240 });
    new PanelLayout(s).init();
    setViewport(500);
    setBox(300);
    FakeRO.fireFor(input());
    expect(saved(s).chatInputHeight).toBe(240);
  });

  it('開閉・幅と同じ記録に入り、ほかの項目を消さない', () => {
    const s = fakeStorage({ explorer: false, chat: true, explorerWidth: 222, chatWidth: 500, chatInputHeight: 200 });
    new PanelLayout(s).init();
    setBox(260);
    FakeRO.fireFor(input());
    expect(saved(s)).toEqual({ explorer: false, chat: true, explorerWidth: 222, chatWidth: 500, chatInputHeight: 260 });
  });
});
