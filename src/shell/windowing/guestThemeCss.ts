/**
 * src/shell/windowing/guestThemeCss.ts
 *
 * ゲストへ配るテーマの CSS（ホストの :root で計算済みの変数・字の大きさ・アニメーションの有無）を作る。
 *
 * 使い手は 2 つ（T-0539）:
 *   - 起動時の焼き込み（GuestCompiler が <style id="itera-guest-theme"> として HTML に入れる）
 *   - 起動中のアプリの取り直し（theme_changed を受けたブリッジが sys:get_theme_css で呼ぶ）
 * 作り方を 2 か所に置くと、起動時と取り直しで見た目が食い違う。ここ 1 つにする。
 *
 * 変数を計算するのはホスト（ThemeService がテーマのファイルから作る）で、ゲストは自分では計算できない。
 */

/** OS がアプリへ入れる <style> の id。ブリッジ（guest_bridge.js）はこの要素だけを差し替える。 */
export const GUEST_THEME_STYLE_ID = 'itera-guest-theme';

/** ゲストへ渡す CSS 変数。ui.js の Tailwind 設定はこれらを参照している。 */
export const GUEST_THEME_VARS: readonly string[] = [
  '--c-bg-app',
  '--c-bg-panel',
  '--c-bg-card',
  '--c-bg-hover',
  '--c-bg-overlay',
  '--c-border-main',
  '--c-border-highlight',
  '--c-text-main',
  '--c-text-muted',
  '--c-text-inverted',
  '--c-text-system',
  '--c-text-tag-attr',
  '--c-text-tag-content',
  '--c-accent-primary',
  '--c-accent-success',
  '--c-accent-warning',
  '--c-accent-error',
  '--c-tag-thinking',
  '--c-tag-plan',
  '--c-tag-report',
  '--c-tag-error',
  '--font-sans',
  '--font-mono',
];

export function buildGuestThemeCss(root: HTMLElement = document.documentElement): string {
  const styles = getComputedStyle(root);
  let css = ':root {\n';
  for (const v of GUEST_THEME_VARS) {
    const val = styles.getPropertyValue(v).trim();
    if (val) css += `  ${v}: ${val};\n`;
  }

  const fontSize = root.style.fontSize || '16px';
  css += `  font-size: ${fontSize};\n`;
  css += '}';

  if (root.getAttribute('data-animations') === 'false') {
    css +=
      '\n* { animation-duration: 0.001ms !important; transition-duration: 0.001ms !important; scroll-behavior: auto !important; }';
  }
  return css;
}
