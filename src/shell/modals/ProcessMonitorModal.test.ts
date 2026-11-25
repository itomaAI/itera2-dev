// @vitest-environment jsdom
/**
 * src/shell/modals/ProcessMonitorModal.test.ts
 * プロセスモニタの行に、そのプロセスの持ち主（仕えるエンジン）が出る（T-0916）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessMonitorModal, ownerBadgeHTML } from './ProcessMonitorModal';

const badge = (html: string) => {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.querySelector('[data-owner]') as HTMLElement;
};

describe('ownerBadgeHTML', () => {
  it('root は控えめ（色を付けない）', () => {
    const b = badge(ownerBadgeHTML('root'));
    expect(b.dataset.owner).toBe('root');
    expect(b.dataset.ownerRole).toBe('root');
    expect(b.className).toContain('text-text-muted');
    expect(b.className).not.toContain('text-primary');
    expect(b.textContent).toBe('Engineroot');
  });

  it('サブは見分けがつく色。id は字のとおり', () => {
    const b = badge(ownerBadgeHTML('eng-0a1B2c'));
    expect(b.dataset.ownerRole).toBe('sub');
    expect(b.className).toContain('text-primary');
    expect(b.lastElementChild!.textContent).toBe('eng-0a1B2c');
  });

  it('id は逃がして埋める', () => {
    expect(ownerBadgeHTML('<x>')).not.toContain('<x>');
  });
});

describe('ProcessMonitorModal: 行ごとに持ち主を出す', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('ルートに仕えるものとサブに仕えるものが、それぞれの持ち主の札を持つ', () => {
    vi.useFakeTimers();
    const rows = [
      { pid: 'notes', path: 'system/apps/notes.html', type: 'app', state: 'foreground', engine: 'root' },
      { pid: 'helper', path: 'apps/helper.html', type: 'app', state: 'background', engine: 'eng-abc' },
      { pid: 'sync', path: 'system/services/sync.html', type: 'daemon', state: 'running', engine: 'root' },
    ];
    const pm = { listWithEngine: () => rows.map((r) => ({ ...r })), list: () => [], kill: vi.fn() };
    const registry = { getService: () => null, getAllApps: () => [] };
    const config = { homePath: () => 'system/apps/home.html' };
    const m = new ProcessMonitorModal(pm as any, registry as any, config as any);
    m.open();
    const owners = Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>('[data-pid]')].map((row) => [
        row.dataset.pid,
        row.querySelector<HTMLElement>('[data-owner]')!.dataset.owner,
      ]),
    );
    expect(owners).toEqual({ notes: 'root', helper: 'eng-abc', sync: 'root' });
    m.close();
  });
});
