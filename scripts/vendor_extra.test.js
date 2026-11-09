import { describe, it, expect } from 'vitest';
import { parseVendorExtra, applyVendorExtra } from './vendor_extra.js';

const io = (files, copies = []) => ({
  rootDir: '/repo',
  vendorDir: '/repo/public/vendor',
  join: (...p) => p.join('/').replace(/\/+/g, '/'),
  exists: (p) => files.has(p),
  isDir: (p) => files.get(p) === 'dir',
  copyDir: (s, d) => copies.push([s, d]),
});

describe('parseVendorExtra', () => {
  it('名前・version・src を検め、dirs の末尾に / を揃える', () => {
    const e = parseVendorExtra({
      'hiroi-gp-model': { version: '1', src: 'assets/hiroi/', entry: 'gp.onnx', dirs: ['sub'] },
    });
    expect(e['hiroi-gp-model']).toEqual({ version: '1', src: 'assets/hiroi', entry: 'gp.onnx', dirs: ['sub/'] });
  });
  it('形が違えば投げる', () => {
    expect(() => parseVendorExtra([])).toThrow(/object/);
    expect(() => parseVendorExtra({ 'a b': { version: '1', src: 'x' } })).toThrow(/name/);
    expect(() => parseVendorExtra({ a: { src: 'x' } })).toThrow(/version/);
    expect(() => parseVendorExtra({ a: { version: '1', src: '/abs' } })).toThrow(/src/);
    expect(() => parseVendorExtra({ a: { version: '1', src: '../up' } })).toThrow(/src/);
    expect(() => parseVendorExtra({ a: { version: '1', src: 'x', entry: '../e' } })).toThrow(/entry/);
    expect(() => parseVendorExtra({ a: { version: '1', src: 'x', dirs: ['/d'] } })).toThrow(/dirs/);
  });
});

describe('applyVendorExtra', () => {
  it('src を public/vendor/<名前>/ に写し、base "<名前>/" で目録に足す', () => {
    const files = new Map([
      ['/repo/assets/hiroi', 'dir'],
      ['/repo/assets/hiroi/gp.onnx', 'file'],
      ['/repo/assets/hiroi/sub/', 'dir'],
    ]);
    const copies = [];
    const manifest = { pdfjs: { version: '6', base: 'pdfjs/' } };
    const added = applyVendorExtra(
      manifest,
      parseVendorExtra({ 'hiroi-gp-model': { version: '1', src: 'assets/hiroi', entry: 'gp.onnx', dirs: ['sub'] } }),
      io(files, copies),
    );
    expect(added).toEqual(['hiroi-gp-model']);
    expect(copies).toEqual([['/repo/assets/hiroi', '/repo/public/vendor/hiroi-gp-model']]);
    expect(manifest['hiroi-gp-model']).toEqual({
      version: '1',
      base: 'hiroi-gp-model/',
      entry: 'gp.onnx',
      dirs: ['sub/'],
    });
    expect(manifest.pdfjs).toEqual({ version: '6', base: 'pdfjs/' });
  });
  it('同梱の名前と重なれば止まる（上書きしない）', () => {
    const files = new Map([['/repo/x', 'dir']]);
    const manifest = { pdfjs: { version: '6', base: 'pdfjs/' } };
    expect(() =>
      applyVendorExtra(manifest, parseVendorExtra({ pdfjs: { version: '1', src: 'x' } }), io(files)),
    ).toThrow(/already shipped/);
    expect(manifest.pdfjs.version).toBe('6');
  });
  it('src や entry が無ければ止まる（無いものを「在る」と書かない）', () => {
    const copies = [];
    expect(() =>
      applyVendorExtra({}, parseVendorExtra({ a: { version: '1', src: 'missing' } }), io(new Map(), copies)),
    ).toThrow(/not found/);
    const files = new Map([['/repo/x', 'dir']]);
    expect(() =>
      applyVendorExtra({}, parseVendorExtra({ a: { version: '1', src: 'x', entry: 'nope.js' } }), io(files, copies)),
    ).toThrow(/nope\.js/);
    expect(copies).toEqual([]);
  });
});
