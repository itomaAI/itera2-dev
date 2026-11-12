import { describe, it, expect } from 'vitest';
import {
  lookupImport,
  moduleSpecifier,
  parseAppImportMap,
  serializeImportMap,
  VFS_SPECIFIER_PREFIX,
} from './guestImportMap';

/**
 * src/shell/windowing/guestImportMap.test.ts
 * ゲストのモジュールを結ぶ import map の部品（T-0822）。
 */

describe('guestImportMap: 合成の指定子', () => {
  it('VFS のパスの頭に @vfs/ を付けるだけ（裸の指定子。ブラウザは文字列の一致で引く）', () => {
    expect(VFS_SPECIFIER_PREFIX).toBe('@vfs/');
    expect(moduleSpecifier('apps/a/main.js')).toBe('@vfs/apps/a/main.js');
    expect(moduleSpecifier('データ/日本 語.js')).toBe('@vfs/データ/日本 語.js');
  });
});

describe('guestImportMap: アプリの import map を読む', () => {
  it('imports の文字列の値だけを取り、ほかの鍵は rest にそのまま残す', () => {
    const { map, problem } = parseAppImportMap(
      JSON.stringify({
        imports: { a: './a.js', n: 1, o: null, cdn: 'https://cdn.example/x.js' },
        scopes: { '/x/': { a: './b.js' } },
        integrity: { './a.js': 'sha384-x' },
      }),
    );
    expect(problem).toBeUndefined();
    expect(map).toEqual({
      imports: { a: './a.js', cdn: 'https://cdn.example/x.js' },
      rest: { scopes: { '/x/': { a: './b.js' } }, integrity: { './a.js': 'sha384-x' } },
    });
  });

  it('imports が無い・形が違うときは空の imports', () => {
    expect(parseAppImportMap('{}').map).toEqual({ imports: {}, rest: {} });
    expect(parseAppImportMap('{"imports":[1,2]}').map).toEqual({ imports: {}, rest: {} });
    expect(parseAppImportMap('{"imports":"x"}').map).toEqual({ imports: {}, rest: {} });
  });

  it('JSON として読めない・オブジェクトでないときは、理由を返して map は null', () => {
    const broken = parseAppImportMap('{ imports: ');
    expect(broken.map).toBeNull();
    expect(broken.problem).toMatch(/^not valid JSON/);
    for (const text of ['[]', '"x"', 'null', '1']) {
      const r = parseAppImportMap(text);
      expect(r.map).toBeNull();
      expect(r.problem).toBe('not an object');
    }
  });
});

describe('guestImportMap: 裸の指定子を引く', () => {
  const imports = {
    lib: './vendor/lib.js',
    'ui/': './ui/',
    'ui/icons/': './assets/icons/',
    'bad/': './no-trailing-slash',
    toString: './proto.js',
  };

  it('完全一致が先。無ければ / で終わる鍵のうち最長の前方一致', () => {
    expect(lookupImport('lib', imports)).toBe('./vendor/lib.js');
    expect(lookupImport('ui/button.js', imports)).toBe('./ui/button.js');
    expect(lookupImport('ui/icons/x.js', imports)).toBe('./assets/icons/x.js');
    expect(lookupImport('ui/', imports)).toBe('./ui/');
  });

  it('引けないものは null（鍵が無い・前方一致の行き先が / で終わらない・/ で終わらない鍵の前方一致）', () => {
    expect(lookupImport('unknown', imports)).toBeNull();
    expect(lookupImport('lib/sub.js', imports)).toBeNull();
    expect(lookupImport('bad/x.js', imports)).toBeNull();
    expect(lookupImport('ui', imports)).toBeNull();
  });

  it('Object の持ち物（toString など）を鍵と取り違えない', () => {
    expect(lookupImport('constructor', imports)).toBeNull();
    expect(lookupImport('toString', imports)).toBe('./proto.js');
    expect(lookupImport('hasOwnProperty', {})).toBeNull();
  });
});

describe('guestImportMap: 文書に置く JSON', () => {
  it('渡した順に並び、同じ鍵は後が勝つ。rest はそのまま載る', () => {
    const json = serializeImportMap(
      [
        ['lib', 'A'],
        ['@vfs/a.js', 'B'],
        ['lib', 'C'],
      ],
      { scopes: { '/x/': { a: 'b' } } },
    );
    expect(JSON.parse(json)).toEqual({ imports: { lib: 'C', '@vfs/a.js': 'B' }, scopes: { '/x/': { a: 'b' } } });
    expect(Object.keys(JSON.parse(json).imports)).toEqual(['lib', '@vfs/a.js']);
  });

  it('<script> の中に置いても閉じタグにならない（< > を \\u003c \\u003e に）。読み戻せば元の文字', () => {
    const json = serializeImportMap([['@vfs/a</script><b>.js', 'X']], { note: '</script>' });
    expect(json).not.toContain('<');
    expect(json).not.toContain('>');
    expect(JSON.parse(json)).toEqual({ imports: { '@vfs/a</script><b>.js': 'X' }, note: '</script>' });
  });
});
