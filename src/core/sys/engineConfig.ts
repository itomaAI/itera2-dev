/**
 * src/core/sys/engineConfig.ts
 * エンジンが読む設定（T-0908）。
 *
 * エンジンの設定 ＝ OS の設定に、そのエンジンの上書きを 1 段重ねたもの。重ね方は設定の層と同じ
 * （持っている鍵だけ勝つ。`mergeConfig`）。上書きしていない鍵は、読むたびに OS の設定を見に行くので、
 * OS の設定が変われば追随する。ルートは上書きを持たない（OS の設定そのもの）。
 *
 * 上書きを受けるのは、エンジンが読む所だけ:
 *   llm         … 上流とプロンプトの組み立て（CognitiveManager の装備）
 *   preferences … maxContinuousTools（Engine が毎サイクル読む）・agentName / username / language（投影がプロンプトに入れる）
 * API の鍵と接続先は設定ではなくホストの持ち物なので、ここを通らない。
 */

import { mergeConfig } from './ConfigManager';

/** エンジン・投影・装備が設定を読む口。OS の ConfigManager はこの形を満たす */
export interface EngineConfigReader {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(category: 'llm' | 'preferences'): any;
}

/** `preferences` のうち上書きできる鍵と、その型 */
export const OVERRIDABLE_PREFERENCES = {
  maxContinuousTools: 'number',
  agentName: 'string',
  username: 'string',
  language: 'string',
} as const;

export interface EngineConfigOverrides {
  llm?: Record<string, unknown>;
  preferences?: Partial<{ maxContinuousTools: number; agentName: string; username: string; language: string }>;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 外から渡された上書きを検査して整える。受け付けないものは捨てずに理由を返す
 * （黙って落とすと、渡した側は「効いている」と思ったまま走る）。
 */
export function normalizeEngineOverrides(raw: unknown): { overrides: EngineConfigOverrides; problems: string[] } {
  const problems: string[] = [];
  const overrides: EngineConfigOverrides = {};
  if (raw === undefined || raw === null) return { overrides, problems };
  if (!isPlainObject(raw)) return { overrides, problems: ['config must be an object'] };

  for (const category of Object.keys(raw)) {
    const value = raw[category];
    if (category === 'llm') {
      if (!isPlainObject(value)) {
        problems.push('config.llm must be an object');
        continue;
      }
      if ('model' in value && (typeof value.model !== 'string' || !value.model.trim())) {
        problems.push('config.llm.model must be a non-empty string');
        continue;
      }
      overrides.llm = { ...value };
    } else if (category === 'preferences') {
      if (!isPlainObject(value)) {
        problems.push('config.preferences must be an object');
        continue;
      }
      const prefs: Record<string, unknown> = {};
      for (const key of Object.keys(value)) {
        const expected = (OVERRIDABLE_PREFERENCES as Record<string, string>)[key];
        if (!expected) {
          problems.push(
            `config.preferences.${key} cannot be overridden (allowed: ${Object.keys(OVERRIDABLE_PREFERENCES).join(', ')})`,
          );
        } else if (typeof value[key] !== expected || (expected === 'number' && !Number.isFinite(value[key]))) {
          problems.push(`config.preferences.${key} must be a ${expected}`);
        } else {
          prefs[key] = value[key];
        }
      }
      if (Object.keys(prefs).length > 0) overrides.preferences = prefs;
    } else {
      problems.push(`config.${category} cannot be overridden (allowed: llm, preferences)`);
    }
  }
  return { overrides, problems };
}

/**
 * 上書きを重ねた読み口。読むたびに下（OS の設定）を読み直すので、下の変更に追随する。
 * 上書きが無い分類は、下の値をそのまま返す。
 */
export function overlayEngineConfig(base: EngineConfigReader, overrides: EngineConfigOverrides): EngineConfigReader {
  return {
    get(category) {
      const below = base.get(category);
      const layer = overrides[category];
      return layer ? mergeConfig(below || {}, layer) : below;
    },
  };
}
