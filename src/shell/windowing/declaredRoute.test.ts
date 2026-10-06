import { describe, expect, it } from 'vitest';
import { declaredRoute } from './declaredRoute';

const proc = {
  path: 'system/apps/explorer.html?path=user',
  currentUri: 'metaos://run/system/apps/explorer.html?path=user',
};

describe('declaredRoute', () => {
  it('? は base に付け足す。intent は保つ', () => {
    expect(declaredRoute(proc, '?path=agent')).toEqual({
      path: 'system/apps/explorer.html?path=agent',
      uri: 'metaos://run/system/apps/explorer.html?path=agent',
    });
    expect(declaredRoute(proc, '#top').path).toBe('system/apps/explorer.html#top');
  });

  it('空なら base に戻る', () => {
    expect(declaredRoute(proc, '')).toEqual({
      path: 'system/apps/explorer.html',
      uri: 'metaos://run/system/apps/explorer.html',
    });
  });

  it('完全な URI は intent とパスに分ける（二重に前置しない）', () => {
    expect(declaredRoute(proc, 'metaos://open/user/notes/a.md')).toEqual({
      path: 'user/notes/a.md',
      uri: 'metaos://open/user/notes/a.md',
    });
  });

  it('intent が無い URI なら open', () => {
    expect(declaredRoute({ path: 'x.html', currentUri: '' }, '?v=1').uri).toBe('metaos://open/x.html?v=1');
  });
});
