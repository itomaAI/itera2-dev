import { describe, it, expect } from 'vitest';
import { GuestBoot, bootstrapHtml, nestedBootstrapHtml } from './guestBoot';
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

describe('nestedBootstrapHtml', () => {
  it('文書の目印を JSON リテラルで渡し、入口と同じブートストラップ本体を持つ（PID は渡さない）', () => {
    const html = nestedBootstrapHtml('__ITERA_ASSET_ab12_3__');
    expect(html).toContain('<script>window.__ITERA_DOC__ = "__ITERA_ASSET_ab12_3__";</script>');
    expect(html).not.toContain('window.__ITERA_PID__ =');
    expect(html).toContain("'itera:doc:v1'");
    expect(html).not.toContain('<script src=');
    // 中身は入口の 1 段目と同じスクリプト（違うのは渡す名前だけ）
    const script = (s: string) => s.slice(s.indexOf('<body><script>'));
    expect(script(html)).toBe(script(bootstrapHtml('p')));
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
