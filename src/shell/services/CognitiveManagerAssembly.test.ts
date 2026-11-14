/**
 * src/shell/services/CognitiveManagerAssembly.test.ts
 * 設定（llm.json）から上流へ送る一組を組み立てる規則の金型（T-0804）。
 *
 * どの設定・どの鍵・どの中継のとき、どの上流の「本文を作る側」と「送る側」が、どの引数で作られるか。
 * 組み立てを 1 か所（`resolveLlm`）に取り出す前のコードが作ったものを snapshot に固定してある。
 *
 * 🔴 金型を書き換えるのは、組み立ての規則を意図して変えるときだけ。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CognitiveManager } from './CognitiveManager';

const FUNCTIONS_BASE = 'https://asia-northeast1-x.cloudfunctions.net';
const CLOUD = { 'system/config/cloud.json': JSON.stringify({ functionsBase: FUNCTIONS_BASE }) };
const SIGNED_IN = {
  'system/temp/firebase_auth.json': JSON.stringify({
    signedIn: true,
    idToken: 'ID',
    uid: 'u1',
    firebaseConfig: { storageBucket: 'b.example' },
  }),
};
const SIGNED_IN_NO_BUCKET = {
  'system/temp/firebase_auth.json': JSON.stringify({ signedIn: true, idToken: 'ID', uid: 'u1' }),
};
const PROFILES = {
  'system/registry/llm_profiles.json': JSON.stringify({
    providers: [
      {
        id: 'openai',
        defaultCapabilities: { maxMediaSizeMB: 7 },
        models: [{ id: 'gpt-x', capabilities: { supportedMimes: ['image/png'] } }],
      },
    ],
  }),
};
const CATALOG = {
  models: [
    { id: 'smart', name: '賢い', aliases: ['かしこい'], provider: 'anthropic', capabilities: { maxMediaSizeMB: 9 } },
    { id: 'fast', provider: 'google' },
    { id: 'gpt', provider: 'openai' },
  ],
};

function fakeVfs(files: Record<string, string>) {
  return {
    exists: (_p: unknown, path: string) => path in files,
    readFile: async (_p: unknown, path: string) => files[path],
  } as any;
}

function setLocalStorage(secrets: Record<string, string>) {
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

beforeEach(() => {
  globalThis.fetch = vi.fn(async (input: any) => {
    const url = String(input);
    if (url === `${FUNCTIONS_BASE}/llmProxy/models`) return { ok: true, json: async () => CATALOG } as any;
    return { ok: false, status: 404, json: async () => ({}) } as any;
  }) as any;
});

afterEach(() => {
  delete (globalThis as any).localStorage;
});

/** 本文を作る側。割る前は Projector そのもの、割ったあとは Projector が持つ Renderer */
const rendererOf = (engine: any) => engine.projector?.renderer ?? engine.projector;

function summarize(engine: any, status: string[]) {
  const r = rendererOf(engine);
  const a = engine.llm;
  return {
    status,
    renderer: {
      kind: r.constructor.name.replace(/(Projector|Renderer)$/, ''),
      apiKey: r.apiKey ?? null,
      relay: r.relay ? r.relay.baseUrl : null,
      capabilities: r.capabilities,
    },
    adapter: {
      kind: a.constructor.name,
      apiKey: a.apiKey ?? null,
      modelName: a.modelName ?? null,
      baseUrl: a.baseUrl ?? null,
      config: a.config,
      reason: a.reason ?? null,
      relay: a.relay
        ? {
            baseUrl: a.relay.baseUrl,
            strictOpenAISchema: a.relay.strictOpenAISchema ?? null,
            stashBody: typeof a.relay.stashBody,
            authHeaders: await_(a.relay.getAuthHeaders),
          }
        : null,
    },
    relayShared: r.relay && a.relay ? r.relay === a.relay : null,
  };
}

/** 認証ヘッダの取り方は関数なので、金型には「呼べる」ことだけを残す（中身は下の試験で見る） */
const await_ = (fn: unknown) => typeof fn;

async function assemble(
  llm: any,
  opts: { secrets?: Record<string, string>; files?: Record<string, string>; logger?: any } = {},
) {
  setLocalStorage(opts.secrets ?? {});
  const engine: any = { projector: null, llm: null };
  const configManager = {
    get: (category: string) => (category === 'llm' ? llm : undefined),
    paths: () => undefined,
    onUpdate: () => () => {},
  };
  const logger = opts.logger ?? null;
  const manager = new CognitiveManager(configManager as any, engine, logger, fakeVfs(opts.files ?? {}));
  const status: string[] = [];
  manager.setStatusCallback((s) => status.push(s));
  await manager.refreshEngineConfig();
  return { engine, manager, summary: summarize(engine, status) };
}

describe('組み立ての金型: 利用者の鍵で直接', () => {
  const cases: Array<[string, any, Record<string, string>]> = [
    ['llm.json が無い（既定）', undefined, { google: 'GK' }],
    ['前置きなし → Google', { model: 'gemini-3.8-flash', temperature: 0.5 }, { google: 'GK' }],
    ['google/…・鍵なし', { model: 'google/gemini-x' }, {}],
    ['openai/…', { model: 'openai/gpt-x', reasoning_effort: 'high' }, { openai: 'OK' }],
    ['openrouter/…（モデル名に / が入る）', { model: 'openrouter/vendor/model-y' }, { openrouter: 'RK' }],
    ['custom/…（URL あり）', { model: 'custom/local' }, { custom: 'CK', custom_url: 'http://127.0.0.1:8811/v1/' }],
    ['custom/…（URL なし）', { model: 'custom/local' }, {}],
    ['anthropic/…', { model: 'anthropic/claude-x', thinking: { type: 'enabled' } }, { anthropic: 'AK' }],
    ['知らない前置き → Google の組', { model: 'foo/bar' }, { foo: 'FK' }],
    ['前置きは大文字でも', { model: 'OpenAI/gpt-x' }, { openai: 'OK' }],
  ];
  for (const [name, llm, secrets] of cases) {
    it(name, async () => {
      expect((await assemble(llm, { secrets })).summary).toMatchSnapshot();
    });
  }

  it('登録簿の層（llm_profiles.json）の capabilities が重なる', async () => {
    const { summary } = await assemble({ model: 'openai/gpt-x' }, { secrets: { openai: 'OK' }, files: PROFILES });
    expect(summary).toMatchSnapshot();
  });

  it('logger はそのまま送る側へ渡る', async () => {
    const logger = { log: () => {} };
    const { engine } = await assemble({ model: 'anthropic/claude-x' }, { logger });
    expect(engine.llm.logger).toBe(logger);
  });
});

describe('組み立ての金型: 運営の中継（itera/…）', () => {
  const signedIn = { ...CLOUD, ...SIGNED_IN };

  for (const model of ['itera/smart', 'itera/賢い', 'itera/かしこい', 'itera/fast', 'itera/gpt']) {
    it(model, async () => {
      expect((await assemble({ model, temperature: 0.2 }, { files: signedIn })).summary).toMatchSnapshot();
    });
  }

  it('バケットが分からなければ、大きな本文の置き場は無い', async () => {
    const { summary } = await assemble({ model: 'itera/smart' }, { files: { ...CLOUD, ...SIGNED_IN_NO_BUCKET } });
    expect(summary).toMatchSnapshot();
  });

  it('繋ぎ先（cloud.json）が無い → 生成時に理由を出す組', async () => {
    expect((await assemble({ model: 'itera/smart' }, { files: SIGNED_IN })).summary).toMatchSnapshot();
  });

  it('台帳に無いモデル → 生成時に理由を出す組', async () => {
    expect((await assemble({ model: 'itera/nope' }, { files: signedIn })).summary).toMatchSnapshot();
  });

  it('サインインしていない（台帳を見に行けていない）→ 生成時に理由を出す組', async () => {
    expect((await assemble({ model: 'itera/smart' }, { files: CLOUD })).summary).toMatchSnapshot();
  });

  it('認証ヘッダは呼ぶたびに読み直す。サインインが切れていれば投げる', async () => {
    const files: Record<string, string> = { ...signedIn };
    const { engine } = await assemble({ model: 'itera/smart' }, { files });
    expect(await engine.llm.relay.getAuthHeaders()).toEqual({ Authorization: 'Bearer ID' });
    files['system/temp/firebase_auth.json'] = JSON.stringify({ signedIn: true, idToken: 'ID2', uid: 'u1' });
    expect(await engine.llm.relay.getAuthHeaders()).toEqual({ Authorization: 'Bearer ID2' });
    files['system/temp/firebase_auth.json'] = JSON.stringify({ signedIn: false });
    await expect(engine.llm.relay.getAuthHeaders()).rejects.toThrow(/Sign in/);
  });
});

describe('システムプロンプト', () => {
  it('<thinking> の節は thinkingTag: true のときだけ入る（既定は入れない。T-0856）', async () => {
    const def = (await assemble({ model: 'anthropic/x' })).engine.projector.systemPrompt as string;
    const on = (await assemble({ model: 'anthropic/x', thinkingTag: true })).engine.projector.systemPrompt as string;
    const off = (await assemble({ model: 'anthropic/x', thinkingTag: false })).engine.projector.systemPrompt as string;
    expect(on).toContain('<define_tag name="thinking">');
    expect(def).not.toContain('<define_tag name="thinking">');
    expect(def).toBe(off);
  });
});
