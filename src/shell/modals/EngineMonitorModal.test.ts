// @vitest-environment jsdom
/**
 * src/shell/modals/EngineMonitorModal.test.ts
 * 動いているエンジンの一覧（T-0916）。描く関数と、窓が束の表を 1 秒ごとに読み直すこと。見るだけ（止める・畳むボタンは無い）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineMonitorModal, engineRowHTML } from './EngineMonitorModal';
import type { EngineOverview } from '../services/EngineManager';

const base = (o: Partial<EngineOverview>): EngineOverview => ({
  id: 'root',
  role: 'root',
  ownerPid: null,
  ownerApp: null,
  running: false,
  busy: false,
  scheduled: false,
  outstandingTools: 0,
  turns: 0,
  serving: 0,
  model: null,
  contextTokens: null,
  ...o,
});

const dom = (html: string) => {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div;
};
const facts = (d: HTMLElement) =>
  Object.fromEntries([...d.querySelectorAll<HTMLElement>('[data-fact]')].map((f) => [f.dataset.fact, f.textContent]));
const states = (d: HTMLElement) => [...d.querySelectorAll<HTMLElement>('[data-state]')].map((s) => s.dataset.state);

describe('engineRowHTML', () => {
  it('ルート: 持ち主は無い。何も立っていなければ「待機」', () => {
    const d = dom(engineRowHTML(base({ turns: 12, serving: 5 })));
    expect(d.querySelector('[data-role]')!.textContent).toBe('root');
    expect(states(d)).toEqual(['idle']);
    expect(facts(d)).toEqual({ turns: 'Turns 12', serving: 'Processes 5' });
  });

  it('サブ: 持ち主のプロセス・立っている状態全部・モデルと文脈の長さ', () => {
    const d = dom(
      engineRowHTML(
        base({
          id: 'eng-abc',
          role: 'sub',
          ownerPid: 'viewer',
          ownerApp: 'viewer',
          running: true,
          busy: true,
          turns: 3,
          serving: 1,
          model: 'anthropic/claude',
          contextTokens: 12345,
        }),
      ),
    );
    expect(d.querySelector('[data-role]')!.textContent).toBe('sub');
    expect(states(d)).toEqual(['running', 'busy']);
    expect(facts(d)).toEqual({
      owner: 'Owner viewer',
      turns: 'Turns 3',
      serving: 'Processes 1',
      model: 'anthropic/claude',
      context: 'Context 12,345',
    });
  });

  it('持ち主のアプリが pid と違えば添える。値は逃がして埋める', () => {
    const d = dom(engineRowHTML(base({ id: 'eng-<x>', role: 'sub', ownerPid: 'viewer_2', ownerApp: 'viewer' })));
    expect(facts(d).owner).toBe('Owner viewer_2 (viewer)');
    expect(d.innerHTML).not.toContain('<x>');
  });

  it('予約だけ立っている', () => {
    expect(states(dom(engineRowHTML(base({ scheduled: true }))))).toEqual(['scheduled']);
  });
});

describe('EngineMonitorModal', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('束の表を 1 秒ごとに読み直す。畳まれたエンジンの行は消える。ボタンは閉じるとリンクだけ', () => {
    vi.useFakeTimers();
    let rows = [base({ serving: 2 }), base({ id: 'eng-a', role: 'sub', ownerPid: 'viewer' })];
    const m = new EngineMonitorModal();
    const opened: string[] = [];
    m.linkTo(() => opened.push('processes'));
    m.bind({ overview: () => rows });
    m.open();
    const ids = () => [...document.querySelectorAll<HTMLElement>('[data-engine]')].map((r) => r.dataset.engine);
    expect(ids()).toEqual(['root', 'eng-a']);

    rows = [rows[0]];
    vi.advanceTimersByTime(1000);
    expect(ids()).toEqual(['root']);

    // 見るだけ: 行にボタンは無い。窓のボタンは「閉じる」とリンクだけ
    expect(document.querySelectorAll('[data-engine] button')).toHaveLength(0);
    const link = document.querySelector<HTMLButtonElement>('[data-link="processes"]')!;
    expect(link.textContent).toContain('Activity Monitor');
    expect(document.querySelectorAll('[data-modal="engine-monitor"] button')).toHaveLength(2);

    link.click();
    expect(opened).toEqual(['processes']);
    expect(document.querySelector('[data-modal="engine-monitor"]')!.classList.contains('hidden')).toBe(true);
  });

  it('束の表が差される前に開いても落ちない（行が無いだけ）。差せば描く', () => {
    vi.useFakeTimers();
    const m = new EngineMonitorModal();
    m.open();
    expect(document.querySelectorAll('[data-engine]')).toHaveLength(0);
    m.bind({ overview: () => [base({})] });
    expect(document.querySelectorAll('[data-engine]')).toHaveLength(1);
    m.close();
  });
});
