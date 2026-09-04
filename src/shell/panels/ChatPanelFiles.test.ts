// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { ChatPanel } from './ChatPanel';
import { LpmlRenderer } from '../services/LpmlRenderer';

/**
 * files 枠と VFS リンク（T-0344）。
 *
 * files の成果物は 1 件 1 行で「開く」「ダウンロード」を持ち、開くは open_path イベントに出る。
 * report の本文の `[名前](パス)` は data-vfs-link になり、クリックが同じ open_path に出る。
 * どちらも ChatPanel は「どのアプリで開くか」を知らない（EventOrchestrator が metaos://open へ運ぶ）。
 */
function makePanel() {
  document.body.innerHTML = '<div id="chat-history"></div>';
  const history = document.getElementById('chat-history') as HTMLElement;
  const panel: any = Object.create(ChatPanel.prototype);
  panel.renderer = new LpmlRenderer();
  panel.els = { HISTORY: history };
  panel.events = {};
  panel.vfs = null;
  panel.getActivePrincipal = () => ({ type: 'user' });
  return { panel, history };
}

function filesTurn(files: any[], title?: string) {
  return {
    id: 'm1',
    role: 'model',
    content: [
      {
        actionType: 'files',
        output: { ui: '📎 files (1)', log: 'Presented', artifact: { kind: 'files', title, files } },
      },
    ],
  };
}

describe('files 枠', () => {
  it('1 件 1 行。ファイルは「開く」「ダウンロード」、ディレクトリは「開く」だけ', () => {
    const { panel, history } = makePanel();
    panel.renderHistory([
      filesTurn(
        [
          { path: 'data/out.xlsx', name: 'out.xlsx', kind: 'file', size: 2048 },
          { path: 'data/dir', name: 'dir', kind: 'directory' },
        ],
        '結果',
      ),
    ]);
    const buttons = Array.from(history.querySelectorAll('[data-files-action]')).map((b) => b.textContent);
    expect(buttons).toEqual(['Open', 'Download', 'Open']);
    expect(history.textContent).toContain('結果');
    expect(history.textContent).toContain('out.xlsx');
    expect(history.textContent).toContain('2.0 KB');
  });

  it('「開く」は open_path にパスを出す', () => {
    const { panel, history } = makePanel();
    const opened: string[] = [];
    panel.events['open_path'] = (p: string) => opened.push(p);
    panel.renderHistory([filesTurn([{ path: 'data/out.xlsx', name: 'out.xlsx', kind: 'file', size: 1 }])]);
    (history.querySelector('[data-files-action="open"]') as HTMLButtonElement).click();
    expect(opened).toEqual(['data/out.xlsx']);
  });

  it('無いファイルは打ち消しで残し、釦を付けない', () => {
    const { panel, history } = makePanel();
    panel.renderHistory([filesTurn([{ path: 'data/nope.md', name: 'nope.md', kind: 'file', missing: true }])]);
    expect(history.querySelectorAll('[data-files-action]').length).toBe(0);
    expect(history.querySelector('.line-through')?.textContent).toBe('nope.md');
    expect(history.textContent).toContain('Not found');
  });

  it('ヘッダーは由来を書く（ITERA: FILES）', () => {
    const { panel, history } = makePanel();
    panel.renderHistory([filesTurn([{ path: 'a', name: 'a', kind: 'file' }])]);
    expect(history.textContent).toContain('Itera: files');
  });
});

describe('report の VFS リンク', () => {
  it('[名前](パス) が data-vfs-link になる', () => {
    const { panel, history } = makePanel();
    panel.renderHistory([
      {
        id: 'm2',
        role: 'model',
        content: [
          {
            actionType: 'report',
            output: { ui: '📢 report', artifact: { kind: 'speech', text: '結果は [見積](個人/見積.xlsx) です' } },
          },
        ],
      },
    ]);
    const a = history.querySelector('[data-vfs-link]') as HTMLElement;
    expect(a).not.toBeNull();
    expect(a.getAttribute('data-vfs-link')).toBe('個人/見積.xlsx');
  });

  it('クリックすると open_path に出る（履歴の容れ物で委譲。描き直しても効く）', () => {
    const { panel, history } = makePanel();
    const opened: string[] = [];
    panel.events['open_path'] = (p: string) => opened.push(p);
    // _bindEvents は在る要素にだけ張る（入力欄が無くても履歴の委譲は張られる）
    panel._bindEvents();
    history.innerHTML = '<p><a href="#" data-vfs-link="data/a.md">a</a></p>';
    (history.querySelector('a') as HTMLElement).click();
    expect(opened).toEqual(['data/a.md']);
  });
});
