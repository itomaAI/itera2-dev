// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildGuestThemeCss, GUEST_THEME_VARS } from './guestThemeCss';

/** 起動時の焼き込みと取り直しが使う唯一の作り方（T-0539）。 */
describe('buildGuestThemeCss', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.removeAttribute('style');
    document.documentElement.removeAttribute('data-animations');
  });

  const fakeComputed = (values: Record<string, string>) =>
    vi
      .spyOn(window, 'getComputedStyle')
      .mockReturnValue({ getPropertyValue: (n: string) => values[n] ?? '' } as unknown as CSSStyleDeclaration);

  it('copies the computed theme variables that have a value, and skips the empty ones', () => {
    fakeComputed({ '--c-bg-app': ' 1 2 3 ', '--c-text-main': '4 5 6' });
    const css = buildGuestThemeCss();
    expect(css).toContain('--c-bg-app: 1 2 3;');
    expect(css).toContain('--c-text-main: 4 5 6;');
    expect(css).not.toContain('--c-bg-panel');
    expect(css.startsWith(':root {')).toBe(true);
  });

  it('reads the variables the guest Tailwind config depends on', () => {
    expect(GUEST_THEME_VARS).toContain('--c-bg-app');
    expect(GUEST_THEME_VARS).toContain('--c-accent-primary');
    expect(GUEST_THEME_VARS).toContain('--font-sans');
  });

  it('carries the root font size (default 16px)', () => {
    fakeComputed({});
    expect(buildGuestThemeCss()).toContain('font-size: 16px;');
    document.documentElement.style.fontSize = '18px';
    expect(buildGuestThemeCss()).toContain('font-size: 18px;');
  });

  it('turns animations off only when the host has them off', () => {
    fakeComputed({});
    expect(buildGuestThemeCss()).not.toContain('animation-duration');
    document.documentElement.setAttribute('data-animations', 'false');
    expect(buildGuestThemeCss()).toContain('animation-duration: 0.001ms');
  });
});
