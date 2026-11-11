/**
 * src/shell/services/CognitiveManagerModels.test.ts
 * 選べるモデルの一覧（MetaOS.llm.models。T-0807）。鍵そのものは返さず、入っているかどうかだけを返す。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CognitiveManager } from './CognitiveManager';

const FUNCTIONS_BASE = 'https://asia-northeast1-x.cloudfunctions.net';
const CLOUD = { 'system/config/cloud.json': JSON.stringify({ functionsBase: FUNCTIONS_BASE }) };
const SIGNED_IN = {
  'system/temp/firebase_auth.json': JSON.stringify({ signedIn: true, idToken: 'ID-TOKEN', uid: 'u1' }),
};
const PROFILES = {
  'system/registry/llm_profiles.json': JSON.stringify({
    providers: [
      {
        id: 'anthropic',
        defaultCapabilities: { maxMediaSizeMB: 24, supportedMimes: ['image/*'] },
        defaultConfig: { temperature: null, max_tokens: null },
        models: [
          {
            id: 'claude-x',
            name: 'Claude X',
            contextTokens: 200000,
            pricing: { input: 3, output: 15 },
            capabilities: { supportedMimes: ['image/*', 'application/pdf'] },
            defaultConfig: { max_tokens: 4096 },
          },
          { id: 'claude-bare' },
        ],
      },
      { id: 'openai', models: [{ id: 'gpt-x', contextTokens: 0 }] },
      { id: 'custom', models: [{ id: 'local-model' }] },
    ],
  }),
};
const CATALOG = { models: [{ id: 'smart', name: '賢い', provider: 'anthropic', contextTokens: 1000000 }] };

function setSecrets(secrets: Record<string, string>) {
  const store: Record<string, string> = { itera_llm_secrets: JSON.stringify(secrets) };
  (globalThis as any).localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
  };
}

function manager(files: Record<string, string>) {
  const vfs = {
    exists: (_p: unknown, path: string) => path in files,
    readFile: async (_p: unknown, path: string) => files[path],
  } as any;
  const configManager = { get: () => undefined, paths: () => undefined, onUpdate: () => () => {} };
  return new CognitiveManager(configManager as any, { projector: null, llm: null } as any, null as any, vfs);
}

beforeEach(() => {
  globalThis.fetch = vi.fn(async (input: any) => {
    if (String(input) === `${FUNCTIONS_BASE}/llmProxy/models`) return { ok: true, json: async () => CATALOG } as any;
    return { ok: false, status: 404, json: async () => ({}) } as any;
  }) as any;
});
afterEach(() => {
  delete (globalThis as any).localStorage;
});

describe('CognitiveManager.listModels', () => {
  it('登録簿のモデルを provider/model の id で並べ、既定はプロバイダにモデルを重ねる', async () => {
    setSecrets({ anthropic: 'sk-ant-SECRET' });
    const models = await manager(PROFILES).listModels();
    const x = models.find((m) => m.id === 'anthropic/claude-x');
    expect(x).toEqual({
      id: 'anthropic/claude-x',
      provider: 'anthropic',
      providerName: 'Anthropic',
      model: 'claude-x',
      name: 'Claude X',
      contextTokens: 200000,
      pricing: { input: 3, output: 15 },
      capabilities: { maxMediaSizeMB: 24, supportedMimes: ['image/*', 'application/pdf'] },
      defaultConfig: { temperature: null, max_tokens: 4096 },
      available: true,
    });
    const bare = models.find((m) => m.id === 'anthropic/claude-bare')!;
    expect(bare.name).toBe('claude-bare');
    expect(bare.contextTokens).toBeNull();
    expect(bare.pricing).toBeNull();
    expect(bare.defaultConfig).toEqual({ temperature: null, max_tokens: null });
  });

  it('available は鍵が入っているかどうか。custom は常に true。値が 0 以下の上限は null', async () => {
    setSecrets({ anthropic: 'sk-ant-SECRET' });
    const models = await manager(PROFILES).listModels();
    const by = (id: string) => models.find((m) => m.id === id)!;
    expect(by('anthropic/claude-x').available).toBe(true);
    expect(by('openai/gpt-x').available).toBe(false);
    expect(by('openai/gpt-x').contextTokens).toBeNull();
    expect(by('custom/local-model').available).toBe(true);
  });

  it('鍵そのものはどこにも入らない', async () => {
    setSecrets({ anthropic: 'sk-ant-SECRET', openai: 'sk-proj-SECRET', custom_url: 'http://internal.example/v1' });
    const text = JSON.stringify(await manager({ ...PROFILES, ...CLOUD, ...SIGNED_IN }).listModels());
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('ID-TOKEN');
    expect(text).not.toContain('internal.example');
  });

  it('中継: 繋ぎ先が在れば台帳のモデルが並び、available はサインインしているか', async () => {
    setSecrets({});
    const signedIn = await manager({ ...PROFILES, ...CLOUD, ...SIGNED_IN }).listModels();
    const smart = signedIn.find((m) => m.id === 'itera/smart')!;
    expect(smart.name).toBe('賢い');
    expect(smart.contextTokens).toBe(1000000);
    expect(smart.available).toBe(true);

    // サインインしていなければ台帳は取れない。手元の一覧に中継のモデルが在っても available は false
    const withLocalList = {
      ...CLOUD,
      'system/registry/llm_profiles.json': JSON.stringify({ providers: [{ id: 'itera', models: [{ id: 'smart' }] }] }),
    };
    const signedOut = await manager(withLocalList).listModels();
    expect(signedOut.find((m) => m.id === 'itera/smart')?.available).toBe(false);

    // 繋ぎ先の無い配布物には中継のモデルは出ない
    const noCloud = await manager(PROFILES).listModels();
    expect(noCloud.some((m) => m.provider === 'itera')).toBe(false);
  });

  it('モデルを持たないプロバイダは並ばない', async () => {
    setSecrets({ openrouter: 'k' });
    const models = await manager(PROFILES).listModels();
    expect(models.some((m) => m.provider === 'openrouter')).toBe(false);
  });
});
