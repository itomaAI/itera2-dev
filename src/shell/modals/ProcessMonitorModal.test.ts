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
      { pid: 'notes', app: 'notes', path: 'system/apps/notes.html', type: 'app', state: 'foreground', engine: 'root' },
      { pid: 'helper', app: 'helper', path: 'apps/helper.html', type: 'app', state: 'background', engine: 'eng-abc' },
      { pid: 'sync', app: 'sync', path: 'system/services/sync.html', type: 'daemon', state: 'running', engine: 'root' },
    ];
    const pm = { listForHost: () => rows.map((r) => ({ ...r })), list: () => [], kill: vi.fn() };
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

describe('ProcessMonitorModal: 名前とアイコンは登録簿から（#237 の退行の直し。T-0916）', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('デーモンもアプリも、何のアプリか（app）で登録簿を引く。pid が app と違っても引ける', () => {
    vi.useFakeTimers();
    const rows = [
      {
        pid: 'web_search_daemon',
        app: 'web_search_daemon',
        path: 'system/services/web_search.html',
        type: 'daemon',
        state: 'running',
        engine: 'root',
      },
      {
        pid: 'loom_daemon-2',
        app: 'loom_daemon',
        path: 'system/services/loom.html',
        type: 'daemon',
        state: 'running',
        engine: 'eng-abc',
      },
      { pid: 'notes', app: 'notes', path: 'system/apps/notes.html', type: 'app', state: 'background', engine: 'root' },
      {
        pid: 'stray',
        app: 'stray',
        path: 'system/services/stray.html',
        type: 'daemon',
        state: 'running',
        engine: 'root',
      },
    ];
    const services: Record<string, { name: string; icon: string }> = {
      web_search_daemon: { name: 'Web Search', icon: '🔎' },
      loom_daemon: { name: 'Loom Service', icon: '🧵' },
    };
    const pm = { listForHost: () => rows.map((r) => ({ ...r })), list: () => [], kill: vi.fn() };
    const registry = {
      getService: (id: string) => services[id],
      getAllApps: () => [{ id: 'notes', name: 'Notes', icon: '📝', path: 'system/apps/notes.html' }],
    };
    const config = { homePath: () => 'system/apps/home.html' };
    const m = new ProcessMonitorModal(pm as any, registry as any, config as any);
    m.open();
    const shown = Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>('[data-pid]')].map((row) => [
        row.dataset.pid,
        [row.querySelector('.text-2xl')!.textContent, row.querySelector('.font-bold.text-sm')!.textContent],
      ]),
    );
    expect(shown).toEqual({
      web_search_daemon: ['🔎', 'Web Search'],
      'loom_daemon-2': ['🧵', 'Loom Service'],
      notes: ['📝', 'Notes'],
      // 登録簿に無いものは、いままでどおり pid と既定のアイコン
      stray: ['⚙️', 'stray'],
    });
    m.close();
  });
});
