import { describe, expect, it } from 'vitest';
import { normalizeEngineOverrides, overlayEngineConfig } from './engineConfig';

/** OS の設定の代わり。値を差し替えられる */
function fakeBase(initial: Record<string, unknown>) {
  const store: Record<string, unknown> = { ...initial };
  return {
    store,
    get: (category: string) => store[category],
  };
}

describe('overlayEngineConfig — OS の設定に、エンジンの上書きを 1 段重ねる', () => {
  it('上書きした鍵だけが勝ち、ほかは OS の値が見える', () => {
    const base = fakeBase({
      llm: { model: 'anthropic/a', temperature: 0.2, generationConfig: { maxOutputTokens: 100, topK: 5 } },
      preferences: { maxContinuousTools: 10, agentName: 'Itera', language: 'Japanese' },
    });
    const view = overlayEngineConfig(base, {
      llm: { model: 'google/b', generationConfig: { maxOutputTokens: 9 } },
      preferences: { maxContinuousTools: 50 },
    });
    expect(view.get('llm')).toEqual({
      model: 'google/b',
      temperature: 0.2,
      generationConfig: { maxOutputTokens: 9, topK: 5 },
    });
    expect(view.get('preferences')).toEqual({ maxContinuousTools: 50, agentName: 'Itera', language: 'Japanese' });
  });

  it('OS の設定が変わると、上書きしていない鍵は追随する（上書きした鍵は動かない）', () => {
    const base = fakeBase({ llm: { model: 'anthropic/a', temperature: 0.2 } });
    const view = overlayEngineConfig(base, { llm: { model: 'google/b' } });
    base.store.llm = { model: 'openai/c', temperature: 0.9 };
    expect(view.get('llm')).toEqual({ model: 'google/b', temperature: 0.9 });
  });

  it('上書きの無い分類は、OS の値そのもの（写しを作らない）', () => {
    const prefs = { maxContinuousTools: 10 };
    const base = fakeBase({ llm: { model: 'a/b' }, preferences: prefs });
    const view = overlayEngineConfig(base, { llm: { model: 'c/d' } });
    expect(view.get('preferences')).toBe(prefs);
    expect(overlayEngineConfig(base, {}).get('llm')).toBe(base.store.llm);
  });

  it('OS の値を書き換えない', () => {
    const llm = { model: 'a/b', generationConfig: { topK: 5 } };
    const base = fakeBase({ llm });
    overlayEngineConfig(base, { llm: { model: 'c/d', generationConfig: { topK: 1 } } }).get('llm');
    expect(llm).toEqual({ model: 'a/b', generationConfig: { topK: 5 } });
  });

  it('OS の側にその分類がまだ無くても、上書きだけで読める', () => {
    const view = overlayEngineConfig(fakeBase({}), { preferences: { language: 'English' } });
    expect(view.get('preferences')).toEqual({ language: 'English' });
    expect(view.get('llm')).toBeUndefined();
  });
});

describe('normalizeEngineOverrides — 受け付ける上書きの範囲', () => {
  it('無ければ空（上書きなし）', () => {
    expect(normalizeEngineOverrides(undefined)).toEqual({ overrides: {}, problems: [] });
    expect(normalizeEngineOverrides(null)).toEqual({ overrides: {}, problems: [] });
    expect(normalizeEngineOverrides({})).toEqual({ overrides: {}, problems: [] });
  });

  it('llm はそのまま、preferences は 4 つの鍵だけ', () => {
    const r = normalizeEngineOverrides({
      llm: { model: 'anthropic/x', thinkingTag: true, anything: { nested: 1 } },
      preferences: { maxContinuousTools: 30, agentName: 'Sub', username: 'U', language: 'English' },
    });
    expect(r.problems).toEqual([]);
    expect(r.overrides).toEqual({
      llm: { model: 'anthropic/x', thinkingTag: true, anything: { nested: 1 } },
      preferences: { maxContinuousTools: 30, agentName: 'Sub', username: 'U', language: 'English' },
    });
  });

  it('上書きできない分類・鍵は、理由を付けて断る（黙って捨てない）', () => {
    const r = normalizeEngineOverrides({
      network: { proxyUrl: 'https://x.example/' },
      preferences: { autoUpdateSystemFiles: false, hiddenEventTypes: [], language: 'English' },
    });
    expect(r.overrides).toEqual({ preferences: { language: 'English' } });
    expect(r.problems).toHaveLength(3);
    expect(r.problems.join('\n')).toMatch(/config\.network cannot be overridden/);
    expect(r.problems.join('\n')).toMatch(/config\.preferences\.autoUpdateSystemFiles cannot be overridden/);
    expect(r.problems.join('\n')).toMatch(/config\.preferences\.hiddenEventTypes cannot be overridden/);
  });

  it('型の違う値は断る', () => {
    const r = normalizeEngineOverrides({
      llm: { model: '' },
      preferences: { maxContinuousTools: '30', agentName: 5, language: 'English' },
    });
    expect(r.overrides).toEqual({ preferences: { language: 'English' } });
    expect(r.problems).toEqual([
      'config.llm.model must be a non-empty string',
      'config.preferences.maxContinuousTools must be a number',
      'config.preferences.agentName must be a string',
    ]);
    expect(normalizeEngineOverrides({ preferences: { maxContinuousTools: Number.NaN } }).problems).toEqual([
      'config.preferences.maxContinuousTools must be a number',
    ]);
  });

  it('形が違えば断る', () => {
    expect(normalizeEngineOverrides('x').problems).toEqual(['config must be an object']);
    expect(normalizeEngineOverrides([]).problems).toEqual(['config must be an object']);
    expect(normalizeEngineOverrides({ llm: 'x', preferences: [] }).problems).toEqual([
      'config.llm must be an object',
      'config.preferences must be an object',
    ]);
  });
});
