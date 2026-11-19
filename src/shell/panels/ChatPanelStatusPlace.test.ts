// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { ChatPanel } from './ChatPanel';
import indexHtml from '../../../index.html?raw';

/**
 * 待機の表示（Thinking... / Processing...）の置き場（T-0886）。
 *
 * 以前は #chat-composer の直下（入力欄の箱の上）に在り、出るたびに入力欄が 1 行ぶん押し上がって境界が動いた。
 * いまは箱の下の帯（添付と送信のボタンの行。もとから高さを取ってある）に出すので、出ても消えても何も動かない。
 * 並びは 表示・停止・送信 —— 増えるものは空いている左へ伸び、送信ボタンの位置は変わらない。
 * jsdom は描画しないので、ここでは「どこに在るか」と「並び」を押さえる。寸法は実ブラウザで見る。
 */

function mount(): void {
  const m = /<body[^>]*>([\s\S]*)<\/body>/.exec(indexHtml);
  if (!m) throw new Error('index.html に body が無い');
  document.body.innerHTML = m[1];
}

const el = (id: string) => document.getElementById(id) as HTMLElement;

describe('待機の表示の置き場', () => {
  beforeEach(mount);

  it('入力欄の箱の中に在り、#chat-composer の直下には無い', () => {
    const typing = el('ai-typing');
    const box = el('chat-input').parentElement as HTMLElement;
    expect(typing).not.toBeNull();
    expect(box.contains(typing)).toBe(true);
    expect(typing.parentElement).not.toBe(el('chat-composer'));
    // #chat-composer の直下で、出たり消えたりするのは添付のプレビューだけ
    const direct = [...el('chat-composer').children].filter((c) => c.classList.contains('hidden')).map((c) => c.id);
    expect(direct).toEqual(['file-preview-area']);
  });

  it('送信・停止と同じ組に、表示・停止・送信 の順で並ぶ', () => {
    const group = el('btn-send').parentElement as HTMLElement;
    expect([...group.children].map((c) => c.id)).toEqual(['ai-typing', 'btn-stop', 'btn-send']);
  });

  it('折り返さない・下の余白を持たない（帯の高さを変えない）', () => {
    const c = el('ai-typing').classList;
    expect(c.contains('whitespace-nowrap')).toBe(true);
    expect(c.contains('mb-2')).toBe(false);
  });

  it('setProcessing で、表示と停止ボタンが一緒に出て、一緒に消える', () => {
    const panel = new ChatPanel();
    const shown = (id: string) => !el(id).classList.contains('hidden');
    expect([shown('ai-typing'), shown('btn-stop')]).toEqual([false, false]);
    panel.setProcessing(true, 'thinking');
    expect([shown('ai-typing'), shown('btn-stop')]).toEqual([true, true]);
    expect(el('ai-typing-label').textContent).toBe('Thinking...');
    panel.setProcessing(true, 'processing');
    expect(el('ai-typing-label').textContent).toBe('Processing...');
    panel.setProcessing(false);
    expect([shown('ai-typing'), shown('btn-stop')]).toEqual([false, false]);
    expect(shown('btn-send')).toBe(true);
  });
});
