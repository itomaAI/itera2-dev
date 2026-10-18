// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { PanelLayout } from './PanelLayout';
import indexHtml from '../../../index.html?raw';

/**
 * 集中モード（T-0641）。
 * 上の帯・エクスプローラ・中央の道具帯を隠して主画面をアプリだけにし、チャットは右から重なる引き出しにする。
 * ここでは jsdom で「印（class）の付け外し」の規則だけを押さえる。見た目は CSS（src/style.css）と画面写真で見る。
 */

function mount(): void {
  const m = /<body[^>]*>([\s\S]*)<\/body>/.exec(indexHtml);
  if (!m) throw new Error('index.html に body が無い');
  document.body.innerHTML = m[1];
  document.body.className = '';
}

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

const esc = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
const click = (id: string) => (document.getElementById(id) as HTMLElement).click();
const inFocus = () => document.body.classList.contains('focus-mode');
const drawerOpen = () => document.getElementById('chat-panel')!.classList.contains('focus-chat-open');

describe('PanelLayout 集中モード', () => {
  let layout: PanelLayout;
  beforeEach(() => {
    mount();
    layout = new PanelLayout(fakeStorage());
    layout.init();
  });

  it('index.html に隠す相手と釦がある', () => {
    for (const id of [
      'shell-header',
      'center-toolbar',
      'btn-focus',
      'focus-controls',
      'btn-focus-chat',
      'btn-focus-exit',
    ]) {
      expect(document.getElementById(id), id).not.toBeNull();
    }
  });

  it('釦で入り、釦と Esc で出る。入ったときは引き出しが閉じている', () => {
    expect(inFocus()).toBe(false);
    click('btn-focus');
    expect(inFocus()).toBe(true);
    expect(layout.isFocus).toBe(true);
    expect(drawerOpen()).toBe(false);
    click('btn-focus-exit');
    expect(inFocus()).toBe(false);
    click('btn-focus');
    esc();
    expect(inFocus()).toBe(false);
  });

  it('引き出し: 釦で開閉。Esc は 1 回目で引き出しを閉じ、2 回目で集中モードを出る', () => {
    layout.setFocus(true);
    click('btn-focus-chat');
    expect(drawerOpen()).toBe(true);
    expect(layout.isFocusChatOpen).toBe(true);
    esc();
    expect(drawerOpen()).toBe(false);
    expect(inFocus()).toBe(true);
    esc();
    expect(inFocus()).toBe(false);
  });

  it('引き出しが開いている間は、浮き釦を引き出しの左隣へずらす（閉じると戻る）', () => {
    const controls = document.getElementById('focus-controls') as HTMLElement;
    layout.setFocus(true);
    expect(controls.style.right).toBe('');
    layout.setFocusChat(true);
    expect(controls.style.right).toMatch(/px$/);
    layout.setFocusChat(false);
    expect(controls.style.right).toBe('');
  });

  it('集中モードの外では引き出しを開けない。出ると引き出しの印も消える', () => {
    layout.setFocusChat(true);
    expect(drawerOpen()).toBe(false);
    layout.setFocus(true);
    layout.setFocusChat(true);
    layout.setFocus(false);
    expect(drawerOpen()).toBe(false);
    expect(layout.isFocusChatOpen).toBe(false);
  });

  it('入るとチャットの全画面は解ける（引き出しと両立しない）', () => {
    layout.setChatFullscreen(true);
    expect(document.getElementById('chat-panel')!.classList.contains('chat-full')).toBe(true);
    layout.setFocus(true);
    expect(layout.isChatFullscreen).toBe(false);
    expect(document.getElementById('chat-panel')!.classList.contains('chat-full')).toBe(false);
  });

  it('引き出しの中でチャットの全画面にすると、集中モードを出て全画面になる', () => {
    layout.setFocus(true);
    layout.setFocusChat(true);
    layout.setChatFullscreen(true);
    expect(inFocus()).toBe(false);
    expect(layout.isChatFullscreen).toBe(true);
  });

  it('登録簿の immersive: 前面に出たら自動で入り、別のアプリに替わったら自動で出る', () => {
    layout.onForegroundApp(true);
    expect(inFocus()).toBe(true);
    layout.onForegroundApp(false);
    expect(inFocus()).toBe(false);
  });

  it('手で入ったときは、別のアプリに替わっても出ない。Esc で出たあとは immersive のアプリが来るまで入らない', () => {
    layout.setFocus(true);
    layout.onForegroundApp(false);
    expect(inFocus()).toBe(true);
    esc();
    expect(inFocus()).toBe(false);
    layout.onForegroundApp(false);
    expect(inFocus()).toBe(false);
    layout.onForegroundApp(true);
    expect(inFocus()).toBe(true);
  });

  it('自動で入ったあと手で入り直すと、自動では出なくなる', () => {
    layout.onForegroundApp(true);
    layout.setFocus(true); // 釦をもう一度押した相当（もう入っている）
    layout.onForegroundApp(false);
    expect(inFocus()).toBe(true);
  });

  it('集中モードは保存しない（開閉の状態はそのまま）', () => {
    const storage = fakeStorage();
    const l = new PanelLayout(storage);
    l.init();
    l.setExplorer(false);
    l.setFocus(true);
    const saved = JSON.parse(storage.getItem('itera.layout.v1')!);
    expect(saved.explorer).toBe(false);
    expect('focus' in saved).toBe(false);
  });
});
