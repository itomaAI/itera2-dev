/**
 * src/core/state/HistoryManager.test.ts
 * 1 つの会話（メモリの turns と変更の知らせ）。T-0903 で保存（HistoryStore）と分けた。
 *
 * 守りたいこと:
 *   - 保存に触らない（IndexedDB の無い環境で作れて動く）。エンジンごとに 1 つ持てる
 *   - 変更の知らせは 5 種類（append / update / delete / clear / load）で、中身は分ける前と同じ
 *   - 2 つの会話は互いに独立（片方の変更が、もう片方の聞き手に届かない）
 */

import { describe, it, expect } from 'vitest';
import { HistoryManager, type HistoryEventPayload } from './HistoryManager';

function watched() {
  const history = new HistoryManager();
  const seen: HistoryEventPayload[] = [];
  const off = history.on('change', (p) => seen.push(p));
  return { history, seen, off };
}

describe('HistoryManager: 1 つの会話', () => {
  it('IndexedDB の無い環境で作れる（保存はここに無い）', () => {
    expect(typeof (globalThis as { indexedDB?: unknown }).indexedDB).toBe('undefined');
    const history = new HistoryManager();
    expect(history.get()).toEqual([]);
    expect(history.getLast()).toBeNull();
  });

  it('append は既定の meta（message・見える・起こす）に重ねて積み、知らせる', () => {
    const { history, seen } = watched();
    const a = history.append('user', 'hi');
    const b = history.append('system', 'note', { type: 'event_log', trigger_llm: false });
    expect(a.meta).toEqual({ type: 'message', visible: true, trigger_llm: true });
    expect(b.meta).toEqual({ type: 'event_log', visible: true, trigger_llm: false });
    expect(a.id).not.toBe(b.id);
    expect(history.get()).toEqual([a, b]);
    expect(history.getLast()).toBe(b);
    expect(seen).toEqual([
      { type: 'append', count: 1, turn: a },
      { type: 'append', count: 2, turn: b },
    ]);
  });

  it('update は中身と meta を重ね、無い id には何もしない', () => {
    const { history, seen } = watched();
    const a = history.append('model', '', { type: 'model_thought', trigger_llm: false });
    const updated = history.update(a.id, 'done', { status: 'completed' });
    expect(updated).toBe(a);
    expect(a.content).toBe('done');
    expect(a.meta).toMatchObject({ type: 'model_thought', trigger_llm: false, status: 'completed' });
    // 中身を渡さなければ meta だけ
    history.update(a.id, undefined, { status: 'error' });
    expect(a.content).toBe('done');
    expect(history.update('nope', 'x')).toBeNull();
    expect(seen.map((p) => p.type)).toEqual(['append', 'update', 'update']);
  });

  it('delete は消したターンを知らせ、無い id は知らせない', () => {
    const { history, seen } = watched();
    const a = history.append('user', 'a');
    const b = history.append('user', 'b');
    history.delete(a.id);
    history.delete('nope');
    expect(history.get()).toEqual([b]);
    expect(seen[2]).toEqual({ type: 'delete', count: 1, turn: a });
    expect(seen).toHaveLength(3);
  });

  it('clear は前の件数を添えて知らせ、load は丸ごと差し替える（配列でなければ空）', () => {
    const { history, seen } = watched();
    history.append('user', 'a');
    history.append('user', 'b');
    history.clear();
    expect(history.get()).toEqual([]);
    expect(seen[2]).toEqual({ type: 'clear', count: 0, previousCount: 2, turn: null });

    const turns = [{ id: 'x', timestamp: 1, role: 'user' as const, content: 'x', meta: {} }];
    history.load(turns);
    expect(history.get()).toBe(turns);
    expect(seen[3]).toEqual({ type: 'load', count: 1, turn: null });
    history.load(null as never);
    expect(history.get()).toEqual([]);
  });

  it('聞くのをやめられる（on の戻り値）', () => {
    const { history, seen, off } = watched();
    history.append('user', 'a');
    off();
    history.append('user', 'b');
    expect(seen).toHaveLength(1);
  });

  it('2 つの会話は互いに独立', () => {
    const one = watched();
    const two = watched();
    one.history.append('user', 'only in one');
    expect(one.history.get()).toHaveLength(1);
    expect(two.history.get()).toEqual([]);
    expect(two.seen).toEqual([]);
  });
});
