import { describe, it, expect } from 'vitest';
import {
  EMPTY_GUEST_PATHS,
  GUEST_PATH_REFS,
  configLayersOf,
  localeLayersOf,
  normalizeGuestPath,
  normalizeGuestPaths,
  registryLayersOf,
  resolveGuestPathRef,
} from './GuestPaths';

/**
 * ゲスト空間の場所（system/config/paths.json）の整え方と、層の組み方（T-0614）。
 * 「無い」は null、「読めない」は null ＋理由。推測はしない。
 */
describe('normalizeGuestPath', () => {
  it('前後の / と ./ を落として相対パスにする', () => {
    expect(normalizeGuestPath('memory').path).toBe('memory');
    expect(normalizeGuestPath('/user/config/').path).toBe('user/config');
    expect(normalizeGuestPath('./個人/会話').path).toBe('個人/会話');
    expect(normalizeGuestPath('  agent/init.md ').path).toBe('agent/init.md');
  });

  it('null / undefined は「無い」。文字列でない・空・.. は捨てて理由を返す', () => {
    expect(normalizeGuestPath(null)).toEqual({ path: null });
    expect(normalizeGuestPath(undefined)).toEqual({ path: null });
    expect(normalizeGuestPath(42).problem).toMatch(/not a string/);
    expect(normalizeGuestPath('').problem).toBe('empty');
    expect(normalizeGuestPath('   ').problem).toBe('empty');
    expect(normalizeGuestPath('a/../b').problem).toMatch(/invalid segment/);
    expect(normalizeGuestPath('a//b').problem).toMatch(/invalid segment/);
  });

  it('OS が規定する側（system/ trash/）をゲスト空間の置き場として指せない', () => {
    expect(normalizeGuestPath('system/memory').problem).toMatch(/OS-regulated/);
    expect(normalizeGuestPath('system').problem).toMatch(/OS-regulated/);
    expect(normalizeGuestPath('trash/x').problem).toMatch(/OS-regulated/);
    // 名前が system で始まるだけなら別物
    expect(normalizeGuestPath('systems/x').path).toBe('systems/x');
  });
});

describe('normalizeGuestPaths', () => {
  it('知っている鍵だけ拾い、無い鍵は null、知らない鍵は無視する', () => {
    const r = normalizeGuestPaths({
      agent: { home: 'memory', init: 'memory/init.md', extra: 'x' },
      user: { sessions: 'data/sessions' },
      other: true,
    });
    expect(r.problems).toEqual([]);
    expect(r.paths).toEqual({
      agent: { home: 'memory', init: 'memory/init.md', scratch: null },
      user: { home: null, config: null, registry: null, locales: null, appRegistry: null, sessions: 'data/sessions' },
    });
  });

  it('壊れた値は null にして理由を残す（並び全体は捨てない）', () => {
    const r = normalizeGuestPaths({ agent: { home: 'system/x', init: 7 }, user: 'nope' });
    expect(r.paths.agent.home).toBeNull();
    expect(r.paths.agent.init).toBeNull();
    expect(r.paths.user).toEqual(EMPTY_GUEST_PATHS.user);
    expect(r.problems).toEqual([
      expect.stringMatching(/^agent\.home: .*OS-regulated/),
      expect.stringMatching(/^agent\.init: not a string/),
      'user is not an object',
    ]);
  });

  it('何も渡さなければ「何も知らない形」', () => {
    expect(normalizeGuestPaths(undefined).paths).toEqual(EMPTY_GUEST_PATHS);
    expect(normalizeGuestPaths({}).paths).toEqual(EMPTY_GUEST_PATHS);
    expect(normalizeGuestPaths([1, 2]).problems).toEqual(['paths is not an object']);
  });
});

describe('層の組み方', () => {
  it('2 段目は paths の user.* が指すときだけ付く', () => {
    expect(configLayersOf(EMPTY_GUEST_PATHS)).toEqual(['system/config']);
    expect(registryLayersOf(EMPTY_GUEST_PATHS)).toEqual(['system/registry']);
    expect(localeLayersOf(EMPTY_GUEST_PATHS)).toEqual(['system/locales']);
    const p = normalizeGuestPaths({
      user: { config: 'user/config', registry: 'user/registry', locales: '個人/言語' },
    }).paths;
    expect(configLayersOf(p)).toEqual(['system/config', 'user/config']);
    expect(registryLayersOf(p)).toEqual(['system/registry', 'user/registry']);
    expect(localeLayersOf(p)).toEqual(['system/locales', '個人/言語']);
  });
});

describe('resolveGuestPathRef', () => {
  const p = normalizeGuestPaths({ agent: { home: 'memory' } }).paths;
  it('知っている鍵は値（無ければ null）、知らない鍵は undefined', () => {
    expect(resolveGuestPathRef(p, 'agent.home')).toBe('memory');
    expect(resolveGuestPathRef(p, 'agent.scratch')).toBeNull();
    expect(resolveGuestPathRef(p, 'agent.nope')).toBeUndefined();
    expect(resolveGuestPathRef(p, 'agent.home.x')).toBeUndefined();
    expect(resolveGuestPathRef(p, 'system')).toBeUndefined();
  });
  it('受け付ける参照の一覧は型と一致する', () => {
    expect(GUEST_PATH_REFS).toEqual([
      'agent.home',
      'agent.init',
      'agent.scratch',
      'user.home',
      'user.config',
      'user.registry',
      'user.locales',
      'user.appRegistry',
      'user.sessions',
    ]);
  });
});
