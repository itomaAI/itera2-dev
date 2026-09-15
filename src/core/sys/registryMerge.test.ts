import { describe, it, expect } from 'vitest';
import { overlayEntry, diffEntry, isEmptyDiff, overlayProviders, isSameValue } from './registryMerge';

/**
 * 登録簿の層を重ねる規則（T-0447）。
 * 項目は `id` で突き合わせ、後の層は持っている鍵だけ勝つ。書くときは下の層との差分だけ。
 * llm_profiles.json の providers[] は CognitiveManager が PROVIDERS へ重ねていた規則をそのまま層に。
 */
describe('registryMerge: 項目', () => {
  it('後の層は持っている鍵だけ勝つ', () => {
    const below = { id: 'a', name: 'A', path: 'system/a.html', autoStart: true };
    expect(overlayEntry(below, { id: 'a', autoStart: false })).toEqual({
      id: 'a',
      name: 'A',
      path: 'system/a.html',
      autoStart: false,
    });
    expect(overlayEntry(undefined, { id: 'a', autoStart: false })).toEqual({ id: 'a', autoStart: false });
  });

  it('差分は下の層と違う鍵だけ。同じ値に戻せば id だけになる', () => {
    const below = { id: 'a', name: 'A', path: 'system/a.html', autoStart: true };
    expect(diffEntry(below, { ...below, autoStart: false })).toEqual({ id: 'a', autoStart: false });
    const same = diffEntry(below, { ...below });
    expect(same).toEqual({ id: 'a' });
    expect(isEmptyDiff(same)).toBe(true);
    // 下の層に無ければ丸ごと
    expect(diffEntry(undefined, { id: 'm', path: 'user/m.html' })).toEqual({ id: 'm', path: 'user/m.html' });
  });

  it('値の同一性はキーの並びを見ない', () => {
    expect(isSameValue({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(isSameValue({ a: 1 }, { a: 2 })).toBe(false);
    expect(isSameValue([1, 2], [2, 1])).toBe(false);
  });
});

describe('registryMerge: LLM の提供者', () => {
  const base = [
    {
      id: 'google',
      name: 'Google',
      models: [{ id: 'g-1', name: 'G1' }],
      defaultCapabilities: { maxMediaSizeMB: 100, supportedMimes: ['image/*'] },
      defaultConfig: { generationConfig: { temperature: null } },
    },
  ];

  it('models は丸ごと差し替え、defaultCapabilities は浅く併合、知らない id は足す', () => {
    const merged = overlayProviders(base, [
      { id: 'google', models: [{ id: 'g-2', name: 'G2' }], defaultCapabilities: { maxMediaSizeMB: 20 } },
      { id: 'mine', name: 'Mine', models: [] },
    ]);
    const google = merged.find((p) => p.id === 'google');
    expect(google.models).toEqual([{ id: 'g-2', name: 'G2' }]);
    expect(google.defaultCapabilities).toEqual({ maxMediaSizeMB: 20, supportedMimes: ['image/*'] });
    expect(google.defaultConfig).toEqual({ generationConfig: { temperature: null } }); // 触っていないものは残る
    expect(merged.map((p) => p.id)).toEqual(['google', 'mine']);
    // 元の配列は書き換えない
    expect(base[0].models).toEqual([{ id: 'g-1', name: 'G1' }]);
  });

  it('配列でないもの・id の無い項目は無視する', () => {
    expect(overlayProviders(base, undefined)).toEqual(base);
    expect(overlayProviders(base, [{ name: 'no id' }, null])).toEqual(base);
  });

  it('層を順に重ねると、最後の層の models が勝つ', () => {
    const l1 = overlayProviders(base, [{ id: 'google', models: [{ id: 'g-2' }] }]);
    const l2 = overlayProviders(l1, [{ id: 'google', models: [{ id: 'g-3' }] }]);
    expect(l2[0].models).toEqual([{ id: 'g-3' }]);
  });
});
