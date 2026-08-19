// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { ChatPanel } from './ChatPanel';

/**
 * 待機表示の文言（T-0028）
 *
 * 背景:
 *   index.html の #ai-typing には「● Thinking...」が静的に書かれている。
 *   以前 setProcessing は innerHTML を丸ごと上書きしており、静的マークアップが
 *   事実上死んでいた。それを直した際に「上書きしない」だけにしたため、
 *   今度は**常に Thinking... のまま**になり、Processing... が出なくなった。
 *
 *   そこで札だけを別要素（#ai-typing-label）に分け、文言だけを差し替える。
 *   ここで守るのは「文言が切り替わること」と「● のマークアップを壊さないこと」の両方である。
 */

function makePanel() {
  document.body.innerHTML = `
    <div id="ai-typing" class="hidden flex items-center gap-1">
      <span class="animate-pulse">●</span> <span id="ai-typing-label">Thinking...</span>
    </div>
    <button id="btn-stop" class="hidden"></button>
  `;
  const panel: any = Object.create(ChatPanel.prototype);
  panel.els = {
    AI_TYPING: document.getElementById('ai-typing'),
    AI_TYPING_LABEL: document.getElementById('ai-typing-label'),
    BTN_STOP: document.getElementById('btn-stop'),
  };
  return panel;
}

const label = () => document.getElementById('ai-typing-label')!.textContent;
const hidden = () => document.getElementById('ai-typing')!.classList.contains('hidden');

describe('ChatPanel: 待機表示の文言', () => {
  it('ツール実行中は Processing... と出る（本命 / これが出ていなかった）', () => {
    const panel = makePanel();
    panel.setProcessing(true, 'processing');
    expect(hidden()).toBe(false);
    expect(label()).toBe('Processing...');
  });

  it('モデル出力中は Thinking...', () => {
    const panel = makePanel();
    panel.setProcessing(true, 'thinking');
    expect(hidden()).toBe(false);
    expect(label()).toBe('Thinking...');
  });

  it('モードを省略したら Thinking...（送信直後など、従来どおり）', () => {
    const panel = makePanel();
    panel.setProcessing(true);
    expect(label()).toBe('Thinking...');
  });

  it('Processing のあと Thinking に戻せる', () => {
    const panel = makePanel();
    panel.setProcessing(true, 'processing');
    panel.setProcessing(true, 'thinking');
    expect(label()).toBe('Thinking...');
  });

  it('文言を切り替えても、点滅する ● のマークアップは壊さない（回帰防止）', () => {
    const panel = makePanel();
    panel.setProcessing(true, 'processing');
    // 以前は innerHTML ごと差し替えていたため、ここが消えていた。
    expect(document.querySelector('#ai-typing .animate-pulse')?.textContent).toBe('●');
  });

  it('止めるときは隠す（停止ボタンも一緒に隠れる）', () => {
    const panel = makePanel();
    panel.setProcessing(true, 'processing');
    panel.setProcessing(false);
    expect(hidden()).toBe(true);
    expect(document.getElementById('btn-stop')!.classList.contains('hidden')).toBe(true);
  });
});
