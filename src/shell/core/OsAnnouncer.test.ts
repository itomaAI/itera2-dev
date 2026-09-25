import { describe, it, expect } from 'vitest';
import { wireOsAnnouncements, CONFIG_CHANGED, THEME_CHANGED } from './OsAnnouncer';

/** 持ち主の知らせを名前を付けて配るだけであること（T-0539）。 */
function harness() {
  const configListeners = new Set<(c: unknown, changed: ReadonlySet<string>) => void>();
  const themeListeners = new Set<() => void>();
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
    broadcast: (name: string, payload: unknown) => sent.push([name, payload]),
  };
  const fireConfig = (changed: string[]) => configListeners.forEach((cb) => cb({}, new Set(changed)));
  const fireTheme = () => themeListeners.forEach((cb) => cb());
  return { deps, sent, fireConfig, fireTheme, configListeners, themeListeners };
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
    h.fireConfig(['appearance']);
    h.fireTheme();
    expect(h.sent).toEqual([]);
  });
});
