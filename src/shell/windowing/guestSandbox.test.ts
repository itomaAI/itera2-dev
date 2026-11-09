import { describe, it, expect } from 'vitest';
import { GUEST_SANDBOX, GUEST_ALLOW_FEATURES, guestAllow } from './guestSandbox';

/**
 * src/shell/windowing/guestSandbox.test.ts
 * 番人（T-0785）: ゲストはホストと同一オリジンではない。
 * この試験が落ちるのは、誰かが `allow-same-origin` を戻したとき —— それは信頼境界を変える決定で、ここで止まって問い直す。
 */
describe('guest sandbox', () => {
  const flags = GUEST_SANDBOX.split(/\s+/);

  it('allow-same-origin を含まない（ゲストは opaque origin）', () => {
    expect(flags).not.toContain('allow-same-origin');
  });

  it('アプリとして動くための旗はある', () => {
    for (const f of ['allow-scripts', 'allow-forms', 'allow-modals', 'allow-popups', 'allow-downloads']) {
      expect(flags).toContain(f);
    }
  });

  it('開いた先の外のサイトに sandbox を継がせない', () => {
    expect(flags).toContain('allow-popups-to-escape-sandbox');
  });

  it('旗は重複しない・知らない旗は無い', () => {
    const known = new Set([
      'allow-scripts',
      'allow-forms',
      'allow-modals',
      'allow-popups',
      'allow-popups-to-escape-sandbox',
      'allow-downloads',
    ]);
    expect(new Set(flags).size).toBe(flags.length);
    for (const f of flags) expect(known.has(f)).toBe(true);
  });

  it('クリップボードは書きだけ委ね、読みは委ねない', () => {
    expect(GUEST_ALLOW_FEATURES).toContain('clipboard-write');
    expect(GUEST_ALLOW_FEATURES).not.toContain('clipboard-read');
  });

  it('allow 属性は、ブラウザが知っている機能だけを並べる', () => {
    const knows = (names: string[]) => ({ featurePolicy: { features: () => names } }) as unknown as Document;
    expect(guestAllow(knows(['clipboard-write', 'camera']))).toBe('clipboard-write *');
    expect(guestAllow(knows(['camera']))).toBe('');
    expect(guestAllow({} as Document)).toBe('');
  });
});
