/**
 * VendorCatalog の試験（T-0685）: 目録の検査・名前から絶対 URL への解決・取り直し。
 */
import { describe, it, expect } from 'vitest';
import { VendorCatalog, parseVendorManifest, resolveVendor, vendorHrefOf } from './VendorCatalog';

const sample = {
  pdfjs: {
    version: '6.4.299',
    base: 'pdfjs/',
    entry: 'pdf.min.js',
    worker: 'pdf.worker.min.js',
    dirs: ['cmaps', 'standard_fonts/'],
  },
  mathjax: { version: '3.2.2', base: 'mathjax', entry: 'tex-mml-chtml.js' },
};

describe('parseVendorManifest', () => {
  it('末尾の / を揃えて受け取る', () => {
    const m = parseVendorManifest(sample);
    expect(m.mathjax.base).toBe('mathjax/');
    expect(m.pdfjs.dirs).toEqual(['cmaps/', 'standard_fonts/']);
  });

  it('形が違えば投げる（空や配列や version 無し）', () => {
    expect(() => parseVendorManifest(null)).toThrow(/object/);
    expect(() => parseVendorManifest([])).toThrow(/object/);
    expect(() => parseVendorManifest({ x: { base: 'x/' } })).toThrow(/version/);
    expect(() => parseVendorManifest({ x: { version: '1', base: '/abs/' } })).toThrow(/base/);
    expect(() => parseVendorManifest({ x: { version: '1', base: '../up/' } })).toThrow(/base/);
    expect(() => parseVendorManifest({ x: { version: '1', base: 'x/', dirs: [1] } })).toThrow(/dirs/);
  });
});

describe('resolveVendor', () => {
  const m = parseVendorManifest(sample);
  const href = 'https://example.test/itera2-dev/vendor/';

  it('名前から絶対 URL を組む（entry / worker / dirs も絶対）', () => {
    const r = resolveVendor(m, 'pdfjs', href);
    expect(r).toEqual({
      name: 'pdfjs',
      version: '6.4.299',
      url: 'https://example.test/itera2-dev/vendor/pdfjs/',
      entry: 'https://example.test/itera2-dev/vendor/pdfjs/pdf.min.js',
      worker: 'https://example.test/itera2-dev/vendor/pdfjs/pdf.worker.min.js',
      dirs: [
        'https://example.test/itera2-dev/vendor/pdfjs/cmaps/',
        'https://example.test/itera2-dev/vendor/pdfjs/standard_fonts/',
      ],
    });
  });

  it('worker の無いライブラリは worker を持たない', () => {
    const r = resolveVendor(m, 'mathjax', href);
    expect(r.entry).toBe('https://example.test/itera2-dev/vendor/mathjax/tex-mml-chtml.js');
    expect(r).not.toHaveProperty('worker');
  });

  it('無い名前は、入っている名前を添えて断る', () => {
    expect(() => resolveVendor(m, 'monaco', href)).toThrow(/not included.*Available: mathjax, pdfjs/);
  });
});

describe('vendorHrefOf', () => {
  it("vite の base './' は文書の場所に相対", () => {
    expect(vendorHrefOf('./', 'https://itomaai.github.io/itera2-dev/')).toBe(
      'https://itomaai.github.io/itera2-dev/vendor/',
    );
    expect(vendorHrefOf('./', 'https://host.test/agent/index.html')).toBe('https://host.test/agent/vendor/');
  });
  it('絶対の base はそのまま', () => {
    expect(vendorHrefOf('/agent/', 'https://host.test/other/')).toBe('https://host.test/agent/vendor/');
  });
});

describe('VendorCatalog', () => {
  function fetchOf(responses: Array<{ ok: boolean; status: number; body?: unknown }>) {
    const calls: string[] = [];
    const impl = async (url: string) => {
      calls.push(url);
      const r = responses.shift() ?? { ok: true, status: 200, body: sample };
      return { ok: r.ok, status: r.status, json: async () => r.body };
    };
    return { calls, impl };
  }

  it('目録は 1 度だけ取り、2 度目からは持っているものを使う', async () => {
    const f = fetchOf([{ ok: true, status: 200, body: sample }]);
    const c = new VendorCatalog('https://h.test/vendor', f.impl);
    const a = await c.resolve('pdfjs');
    const b = await c.resolve('mathjax');
    expect(a.url).toBe('https://h.test/vendor/pdfjs/');
    expect(b.url).toBe('https://h.test/vendor/mathjax/');
    expect(f.calls).toEqual(['https://h.test/vendor/manifest.json']);
    expect(await c.list()).toEqual(['mathjax', 'pdfjs']);
  });

  it('取れなかったら断り、次の呼び出しでもう一度取りに行く', async () => {
    const f = fetchOf([
      { ok: false, status: 404 },
      { ok: true, status: 200, body: sample },
    ]);
    const c = new VendorCatalog('https://h.test/vendor/', f.impl);
    await expect(c.resolve('pdfjs')).rejects.toThrow(/404/);
    await expect(c.resolve('pdfjs')).resolves.toMatchObject({ version: '6.4.299' });
    expect(f.calls).toHaveLength(2);
  });

  it('名前が無ければ断る', async () => {
    const c = new VendorCatalog('https://h.test/vendor/', fetchOf([]).impl);
    await expect(c.resolve('')).rejects.toThrow(/name is required/);
  });
});
