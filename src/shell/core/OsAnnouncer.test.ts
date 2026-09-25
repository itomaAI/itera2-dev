import { describe, it, expect } from 'vitest';
import { wireOsAnnouncements, CONFIG_CHANGED, THEME_CHANGED, NAV_CHANGED, REGISTRY_CHANGED } from './OsAnnouncer';

/** 持ち主の知らせを名前を付けて配るだけであること（T-0539）。 */
function harness() {
  const configListeners = new Set<(c: unknown, changed: ReadonlySet<string>) => void>();
  const themeListeners = new Set<() => void>();
  const navListeners = new Set<(s: any) => void>();
  const regListeners = new Set<(changed: ReadonlySet<string>) => void>();
  const assocListeners = new Set<() => void>();
  const sent: Array<[string, unknown]> = [];
  const deps = {
    configManager: {
      onUpdate(cb: (c: unknown, changed: ReadonlySet<string>) => void) {
        configListeners.add(cb);
        return () => configListeners.delete(cb);
      },
    },
    themeService: {
      onApplied(cb: () => void) {
        themeListeners.add(cb);
        return () => themeListeners.delete(cb);
      },
    },
    navHistory: {
      onChange(cb: (s: any) => void) {
        navListeners.add(cb);
        return () => navListeners.delete(cb);
      },
    },
    appRegistry: {
      onChange(cb: (changed: ReadonlySet<string>) => void) {
        regListeners.add(cb);
        return () => regListeners.delete(cb);
      },
    },
    associations: {
      onChange(cb: () => void) {
        assocListeners.add(cb);
        return () => assocListeners.delete(cb);
      },
    },
    broadcast: (name: string, payload: unknown) => sent.push([name, payload]),
  };
  const fireConfig = (changed: string[]) => configListeners.forEach((cb) => cb({}, new Set(changed)));
  const fireTheme = () => themeListeners.forEach((cb) => cb());
  const fireNav = (s: unknown) => navListeners.forEach((cb) => cb(s));
  const fireRegistry = (changed: string[]) => regListeners.forEach((cb) => cb(new Set(changed)));
  const fireAssoc = () => assocListeners.forEach((cb) => cb());
  return {
    deps,
    sent,
    fireConfig,
    fireTheme,
    fireNav,
    fireRegistry,
    fireAssoc,
    configListeners,
    themeListeners,
    navListeners,
    regListeners,
    assocListeners,
  };
}

describe('wireOsAnnouncements', () => {
  it('config_changed carries only the changed categories, not the values', () => {
    const h = harness();
    wireOsAnnouncements(h.deps);
    h.fireConfig(['appearance', 'llm']);
    expect(h.sent).toEqual([[CONFIG_CHANGED, { categories: ['appearance', 'llm'] }]]);
  });

  it('theme_changed is sent when the theme service says it finished applying', () => {
    const h = harness();
    wireOsAnnouncements(h.deps);
    h.fireTheme();
    expect(h.sent).toEqual([[THEME_CHANGED, {}]]);
  });

  it('nav_changed keeps its old shape (index / length are not sent)', () => {
    const h = harness();
    wireOsAnnouncements(h.deps);
    h.fireNav({ canBack: true, canForward: false, current: { uri: 'u', pid: 'p' }, index: 3, length: 4 });
    expect(h.sent).toEqual([[NAV_CHANGED, { canBack: true, canForward: false, current: { uri: 'u', pid: 'p' } }]]);
  });

  it('registry_changed names the registries like getRegistry does', () => {
    const h = harness();
    wireOsAnnouncements(h.deps);
    h.fireRegistry(['apps', 'services']);
    h.fireAssoc();
    expect(h.sent).toEqual([
      [REGISTRY_CHANGED, { registries: ['apps', 'services'] }],
      [REGISTRY_CHANGED, { registries: ['associations'] }],
    ]);
  });

  it('does not decide anything on its own: nothing is sent until an owner speaks', () => {
    const h = harness();
    wireOsAnnouncements(h.deps);
    expect(h.sent).toEqual([]);
  });

  it('the returned function unwires both', () => {
    const h = harness();
    const off = wireOsAnnouncements(h.deps);
    off();
    expect(h.configListeners.size).toBe(0);
    expect(h.themeListeners.size).toBe(0);
    expect(h.navListeners.size).toBe(0);
    expect(h.regListeners.size).toBe(0);
    expect(h.assocListeners.size).toBe(0);
    h.fireConfig(['appearance']);
    h.fireTheme();
    h.fireNav({ canBack: false, canForward: false, current: null });
    expect(h.sent).toEqual([]);
  });
});
