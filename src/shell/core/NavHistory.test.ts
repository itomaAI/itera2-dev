/**
 * NavHistory（T-0453）
 * 守りたいこと:
 *   - 場所の変化を積む。同じ URI は積まない（pid だけ更新）。index より後ろは捨てる。上限で古いほうから落ちる
 *   - 戻る・進むは記録した URI を navigate に渡すだけ。到達中の変化は積まない
 *   - ブラウザ連動: 段ごとに pushState、back/forward は history.go に委ね、popstate（自分の state だけ）で go する
 */
import { describe, it, expect, vi } from 'vitest';
import { NavHistory } from './NavHistory';
import { USER_MOVER, engineMover } from '../windowing/processGate';

const mk = (opts: Partial<ConstructorParameters<typeof NavHistory>[0]> = {}) => {
  const navigate = vi.fn(async (_uri: string, _mover?: unknown) => {});
  const h = new NavHistory({ navigate, now: () => 1, ...opts });
  return { h, navigate };
};

describe('NavHistory', () => {
  it('積む・同じ URI は積まない・後ろを捨てる・上限', async () => {
    const { h } = mk({ max: 3 });
    expect(h.state()).toMatchObject({ canBack: false, canForward: false, current: null, index: -1, length: 0 });
    h.record({ pid: 'home', uri: 'metaos://run/apps/home.html' });
    h.record({ pid: 'home', uri: 'metaos://run/apps/home.html' }); // 同じ
    h.record({ pid: 'home2', uri: 'metaos://run/apps/home.html' }); // 同じ URI・別 pid → pid だけ
    expect(h.entries.length).toBe(1);
    expect(h.entries[0].pid).toBe('home2');
    h.record({ pid: 'a', uri: 'metaos://run/a.html' });
    h.record({ pid: 'a', uri: 'metaos://run/a.html?x=1' }); // 申告
    expect(h.state()).toMatchObject({ canBack: true, canForward: false, index: 2, length: 3 });
    h.record({ pid: 'b', uri: 'metaos://run/b.html' }); // 上限 3 → 先頭が落ちる
    expect(h.entries.map((e) => e.uri)).toEqual([
      'metaos://run/a.html',
      'metaos://run/a.html?x=1',
      'metaos://run/b.html',
    ]);
    expect(h.index).toBe(2);
    await h.go(0, USER_MOVER);
    h.record({ pid: 'c', uri: 'metaos://run/c.html' }); // 途中から新しい所へ → 後ろを捨てる
    expect(h.entries.map((e) => e.uri)).toEqual(['metaos://run/a.html', 'metaos://run/c.html']);
    expect(h.state()).toMatchObject({ index: 1, canBack: true, canForward: false });
  });

  it('戻る・進むは navigate に URI を渡すだけ。到達中の record は積まない。範囲外は false', async () => {
    const { h, navigate } = mk();
    h.record({ pid: 'a', uri: 'metaos://run/a.html' });
    h.record({ pid: 'b', uri: 'metaos://run/b.html' });
    h.record({ pid: 'c', uri: 'metaos://run/c.html' });
    expect(await h.back(USER_MOVER)).toBe(true);
    expect(navigate).toHaveBeenLastCalledWith('metaos://run/b.html', USER_MOVER);
    expect(h.state()).toMatchObject({ index: 1, canBack: true, canForward: true });
    // dispatch の中で場所が変わっても（navigating 中）積まない
    const { h: h2, navigate: n2 } = mk();
    n2.mockImplementation(async (uri: string) => h2.record({ pid: 'x', uri }));
    h2.record({ pid: 'a', uri: 'metaos://run/a.html' });
    h2.record({ pid: 'b', uri: 'metaos://run/b.html' });
    await h2.back(USER_MOVER);
    expect(h2.entries.length).toBe(2);
    expect(h2.index).toBe(0);
    expect(await h2.back(USER_MOVER)).toBe(false);
    expect(await h2.forward(USER_MOVER)).toBe(true);
    expect(await h2.forward(USER_MOVER)).toBe(false);
    expect(await h2.go(9, USER_MOVER)).toBe(false);
    // navigate が投げても index は動き、navigating は戻る
    const { h: h3, navigate: n3 } = mk();
    n3.mockImplementation(async () => {
      throw new Error('boom');
    });
    h3.record({ pid: 'a', uri: 'metaos://run/a.html' });
    h3.record({ pid: 'b', uri: 'metaos://run/b.html' });
    expect(await h3.back(USER_MOVER)).toBe(true);
    h3.record({ pid: 'c', uri: 'metaos://run/c.html' });
    expect(h3.entries.map((e) => e.uri)).toEqual(['metaos://run/a.html', 'metaos://run/c.html']);
  });

  it('ブラウザ連動: 段ごとに pushState、back は history.go(-1) に委ね、popstate の自分の state だけで go する', async () => {
    const browser = { pushState: vi.fn(), replaceState: vi.fn(), go: vi.fn() };
    const { h, navigate } = mk({ browser });
    expect(browser.replaceState).toHaveBeenCalledWith({ iteraNav: -1 }, '');
    h.record({ pid: 'a', uri: 'metaos://run/a.html' });
    h.record({ pid: 'b', uri: 'metaos://run/b.html' });
    expect(browser.pushState).toHaveBeenNthCalledWith(1, { iteraNav: 0 }, '');
    expect(browser.pushState).toHaveBeenNthCalledWith(2, { iteraNav: 1 }, '');
    expect(await h.back(USER_MOVER)).toBe(true);
    expect(browser.go).toHaveBeenCalledWith(-1);
    expect(navigate).not.toHaveBeenCalled(); // popstate が来るまで動かない
    expect(await h.onPopState({ iteraNav: 0 })).toBe(true);
    expect(navigate).toHaveBeenLastCalledWith('metaos://run/a.html', USER_MOVER);
    expect(h.index).toBe(0);
    // 外から来た popstate は無視
    expect(await h.onPopState(null)).toBe(false);
    expect(await h.onPopState({ foo: 1 })).toBe(false);
    expect(await h.onPopState({ iteraNav: -1 })).toBe(false);
    expect(await h.onPopState({ iteraNav: 0 })).toBe(false); // 同じ段
    // canBack が無いときは go を呼ばない
    expect(await h.back(USER_MOVER)).toBe(false);
    expect(browser.go).toHaveBeenCalledTimes(1);
  });

  it('誰が戻る・進むかを、navigate まで運ぶ', async () => {
    const { h, navigate } = mk();
    const SUB = engineMover('eng-a', 'a_app');
    for (const x of ['a', 'b', 'c']) h.record({ pid: x, uri: `metaos://run/${x}.html` });
    expect(await h.back(SUB)).toBe(true);
    expect(navigate).toHaveBeenLastCalledWith('metaos://run/b.html', SUB);
    expect(await h.forward(USER_MOVER)).toBe(true);
    expect(navigate).toHaveBeenLastCalledWith('metaos://run/c.html', USER_MOVER);
    expect(await h.go(0, SUB)).toBe(true);
    expect(navigate).toHaveBeenLastCalledWith('metaos://run/a.html', SUB);
  });

  it('ブラウザ連動: 頼んだ者を、行き先の段と一緒に popstate まで持ち越す。頼んでいない popstate は利用者', async () => {
    const browser = { pushState: vi.fn(), replaceState: vi.fn(), go: vi.fn() };
    const { h, navigate } = mk({ browser });
    const SUB = engineMover('eng-a', 'a_app');
    for (const x of ['a', 'b', 'c']) h.record({ pid: x, uri: `metaos://run/${x}.html` });
    // 頼んだ段の popstate → 頼んだ者として
    await h.back(SUB);
    expect(await h.onPopState({ iteraNav: 1 })).toBe(true);
    expect(navigate).toHaveBeenLastCalledWith('metaos://run/b.html', SUB);
    // 誰も頼んでいない popstate（ブラウザの戻る）→ 利用者
    expect(await h.onPopState({ iteraNav: 0 })).toBe(true);
    expect(navigate).toHaveBeenLastCalledWith('metaos://run/a.html', USER_MOVER);
    // 頼んだ段と違う段の popstate → 利用者。持ち越しは使い切る（あとで同じ段が来ても、頼んだ者にはならない）
    await h.forward(SUB);
    expect(await h.onPopState({ iteraNav: 2 })).toBe(true);
    expect(navigate).toHaveBeenLastCalledWith('metaos://run/c.html', USER_MOVER);
    expect(await h.onPopState({ iteraNav: 1 })).toBe(true);
    expect(navigate).toHaveBeenLastCalledWith('metaos://run/b.html', USER_MOVER);
    // 外から来た popstate（自分の state でない）は、持ち越しを消さない
    await h.back(SUB);
    expect(await h.onPopState(null)).toBe(false);
    expect(await h.onPopState({ foo: 1 })).toBe(false);
    expect(await h.onPopState({ iteraNav: 0 })).toBe(true);
    expect(navigate).toHaveBeenLastCalledWith('metaos://run/a.html', SUB);
    expect(navigate).toHaveBeenCalledTimes(5);
  });

  it('購読: 変化のたびに state が届く。購読側が投げても止まらない', async () => {
    const { h } = mk();
    const seen: number[] = [];
    h.onChange(() => {
      throw new Error('x');
    });
    h.onChange((s) => seen.push(s.index));
    h.record({ pid: 'a', uri: 'metaos://run/a.html' });
    h.record({ pid: 'b', uri: 'metaos://run/b.html' });
    await h.back(USER_MOVER);
    expect(seen).toEqual([0, 1, 0]);
  });
});

describe('queryFromArgs（spawn の引数を URI に写す。ProcessManager）', async () => {
  const { queryFromArgs } = await import('../windowing/ProcessManager');
  it('文字列・数・真偽だけなら ? に写す。物や配列があれば写さない。path が ? を持てば触らない', () => {
    expect(queryFromArgs('a.html', { skill: '見積転記', view: 'new' })).toBe(
      '?skill=%E8%A6%8B%E7%A9%8D%E8%BB%A2%E8%A8%98&view=new',
    );
    expect(queryFromArgs('a.html', { n: 1, b: true, z: null })).toBe('?n=1&b=true');
    expect(queryFromArgs('a.html', { items: [{ estimateId: 'E1' }] })).toBe('');
    expect(queryFromArgs('a.html', {})).toBe('');
    expect(queryFromArgs('a.html', undefined)).toBe('');
    expect(queryFromArgs('a.html?x=1', { y: '2' })).toBe('');
  });
});

describe('moveQueryToArgs（起動する path の ?query を args へ移す。ProcessManager・T-0542）', async () => {
  const { moveQueryToArgs } = await import('../windowing/ProcessManager');
  it('query を args に移し、path からは外す', () => {
    expect(moveQueryToArgs('apps/s.html?skill=%E8%A6%8B%E7%A9%8D&view=history')).toEqual({
      path: 'apps/s.html',
      args: { skill: '見積', view: 'history' },
    });
  });
  it('query の値が起動時の args より優先し、query に無いものは残す', () => {
    expect(moveQueryToArgs('apps/s.html?view=history', { skill: 'x', view: 'new' })).toEqual({
      path: 'apps/s.html',
      args: { skill: 'x', view: 'history' },
    });
  });
  it('#hash は path に残す', () => {
    expect(moveQueryToArgs('apps/s.html?a=1#sec')).toEqual({ path: 'apps/s.html#sec', args: { a: '1' } });
  });
  it('query が無ければ何もしない（args も同じ物のまま）', () => {
    const args = { a: '1' };
    const r = moveQueryToArgs('apps/s.html#sec', args);
    expect(r.path).toBe('apps/s.html#sec');
    expect(r.args).toBe(args);
    expect(moveQueryToArgs('apps/s.html')).toEqual({ path: 'apps/s.html', args: undefined });
  });
});
