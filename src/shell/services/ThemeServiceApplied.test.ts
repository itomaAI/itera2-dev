// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { ThemeService } from './ThemeService';

/** テーマを当て終えてから告げること（T-0539）。告知を受けた側が取り直したとき、新しい値が見えていなければならない。 */
function makeService(themeJson: string | null) {
  const configManager = { onUpdate: () => () => {} };
  const vfs = {
    exists: () => themeJson !== null,
    readFile: async () => themeJson ?? '',
  };
  return new ThemeService(configManager as any, vfs as any);
}

describe('ThemeService.onApplied', () => {
  afterEach(() => document.documentElement.removeAttribute('style'));

  it('fires after the theme variables are set', async () => {
    const svc = makeService(JSON.stringify({ colors: { bg: { app: '#112233' } } }));
    const seen: string[] = [];
    svc.onApplied(() => seen.push(document.documentElement.style.getPropertyValue('--c-bg-app')));
    await svc.applyAppearance({ theme: 'system/themes/x.json' });
    expect(seen).toEqual(['17 34 51']);
  });

  it('still fires when the theme file is missing (font size may have changed)', async () => {
    const svc = makeService(null);
    let n = 0;
    svc.onApplied(() => n++);
    await svc.applyAppearance({ theme: 'system/themes/missing.json', typography: { fontSize: 'large' } });
    expect(n).toBe(1);
  });

  it('a failing listener does not stop the others, and unsubscribing works', async () => {
    const svc = makeService(null);
    let n = 0;
    svc.onApplied(() => {
      throw new Error('boom');
    });
    const off = svc.onApplied(() => n++);
    await svc.applyAppearance({});
    off();
    await svc.applyAppearance({});
    expect(n).toBe(1);
  });
});
