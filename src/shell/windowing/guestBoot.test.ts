import { describe, it, expect } from 'vitest';
import { GuestBoot, bootstrapHtml } from './guestBoot';
import type { CompiledGuest } from './GuestCompiler';

/**
 * src/shell/windowing/guestBoot.test.ts
 * 二段起動のホスト側の記録（T-0784）。spawn は `ready` を待ち、`ready` は本体の load・起動の失敗・kill のどれでも解ける。
 */

const settled = (p: Promise<unknown>) =>
  Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 20))]);

describe('bootstrapHtml', () => {
  it('PID を JSON リテラルで渡し、ブートストラップ本体を body のインラインで持つ', () => {
    const html = bootstrapHtml('p"</script><x>');
    expect(html).toContain('window.__ITERA_PID__ = "p\\"\\u003c/script\\u003e\\u003cx\\u003e"');
    expect(html).toContain("action: 'sys:boot'");
    expect(html).not.toContain('<script src=');
    expect(html.length).toBeLessThan(6000); // 1 段目は小さいまま（T-0770 E4: 1.1 KB。ブリッジはここに入れない）
  });
});

describe('GuestBoot', () => {
  const body: CompiledGuest = { html: '<html></html>', hash: '', assets: [] };

  it('ready は本体の load（markReady）で解ける', async () => {
    const boot = new GuestBoot(Promise.resolve(body));
    expect(await settled(boot.ready)).toBe(false);
    boot.markReady();
    expect(await settled(boot.ready)).toBe(true);
    expect(await boot.body).toBe(body);
  });

  it('compile が失敗しても ready は解ける（spawn を待たせない）。失敗は body に残る', async () => {
    const boot = new GuestBoot(Promise.reject(new Error('compile failed')));
    expect(await settled(boot.ready)).toBe(true);
    await expect(boot.body).rejects.toThrow('compile failed');
  });

  it('abandon（kill）でも解ける。2 度解いても害は無い', async () => {
    const boot = new GuestBoot(Promise.resolve(body));
    boot.abandon();
    boot.markReady();
    expect(await settled(boot.ready)).toBe(true);
  });
});
