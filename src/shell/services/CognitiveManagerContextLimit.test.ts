/**
 * src/shell/services/CognitiveManagerContextLimit.test.ts
 * いま選んでいるモデルの文脈の上限（T-0806）。モデルの一覧に書いてある値だけを返し、無ければ null（推測しない）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CognitiveManager } from './CognitiveManager';

const FUNCTIONS_BASE = 'https://asia-northeast1-x.cloudfunctions.net';
const CLOUD = { 'system/config/cloud.json': JSON.stringify({ functionsBase: FUNCTIONS_BASE }) };
const SIGNED_IN = { 'system/temp/firebase_auth.json': JSON.stringify({ signedIn: true, idToken: 'ID', uid: 'u1' }) };
const PROFILES = {
  'system/registry/llm_profiles.json': JSON.stringify({
    providers: [
      {
        id: 'anthropic',
        models: [
          { id: 'claude-x', contextTokens: 200000 },
          { id: 'claude-nolimit' },
          { id: 'claude-zero', contextTokens: 0 },
        ],
      },
      { id: 'custom', models: [{ id: 'local-model', contextTokens: 32000 }] },
    ],
  }),
};
const CATALOG = {
  models: [
    { id: 'smart', name: '賢い', aliases: ['かしこい'], provider: 'anthropic', contextTokens: 1000000 },
    { id: 'fast', provider: 'google' },
  ],
};

let catalogFetches = 0;

function manager(model: unknown, files: Record<string, string> = PROFILES) {
  const vfs = {
    exists: (_p: unknown, path: string) => path in files,
    readFile: async (_p: unknown, path: string) => files[path],
  } as any;
  const configManager = {
    get: (category: string) => (category === 'llm' ? (model === undefined ? undefined : { model }) : undefined),
    paths: () => undefined,
    onUpdate: () => () => {},
  };
  return new CognitiveManager(configManager as any, { projector: null, llm: null } as any, null as any, vfs);
}

beforeEach(() => {
  catalogFetches = 0;
  globalThis.fetch = vi.fn(async (input: any) => {
    if (String(input) === `${FUNCTIONS_BASE}/llmProxy/models`) {
      catalogFetches += 1;
      return { ok: true, json: async () => CATALOG } as any;
    }
    return { ok: false, status: 404, json: async () => ({}) } as any;
  }) as any;
});
afterEach(() => {
  delete (globalThis as any).localStorage;
});

describe('CognitiveManager.contextLimit', () => {
  it('選んでいるモデルの contextTokens を返す', async () => {
    expect(await manager('anthropic/claude-x').contextLimit()).toBe(200000);
    expect(await manager('custom/local-model').contextLimit()).toBe(32000);
  });

  it('一覧に無い・値が無い・0 以下なら null（推測しない）', async () => {
    expect(await manager('anthropic/claude-unknown').contextLimit()).toBeNull();
    expect(await manager('anthropic/claude-nolimit').contextLimit()).toBeNull();
    expect(await manager('anthropic/claude-zero').contextLimit()).toBeNull();
    expect(await manager('anthropic/claude-x', {}).contextLimit()).toBeNull();
  });

  it('モデルが決まっていなければ null', async () => {
    expect(await manager(undefined).contextLimit()).toBeNull();
    expect(await manager('').contextLimit()).toBeNull();
    expect(await manager(42).contextLimit()).toBeNull();
  });

  it('選んでいるプロバイダの下に無ければ、同じ id のモデルを一覧の全体から探す', async () => {
    expect(await manager('custom/claude-x').contextLimit()).toBe(200000);
    expect(await manager('openrouter/claude-x').contextLimit()).toBe(200000);
  });

  it('中継: 台帳の値（別名でも引ける）', async () => {
    const files = { ...PROFILES, ...CLOUD, ...SIGNED_IN };
    expect(await manager('itera/smart', files).contextLimit()).toBe(1000000);
    expect(await manager('itera/賢い', files).contextLimit()).toBe(1000000);
    expect(await manager('itera/fast', files).contextLimit()).toBeNull();
  });

  it('中継を選んでいなければ台帳を取りに行かない', async () => {
    const files = { ...PROFILES, ...CLOUD, ...SIGNED_IN };
    await manager('anthropic/claude-x', files).contextLimit();
    expect(catalogFetches).toBe(0);
    await manager('itera/smart', files).contextLimit();
    expect(catalogFetches).toBe(1);
  });
});
