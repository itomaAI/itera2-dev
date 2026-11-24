/**
 * src/shell/services/CognitiveManagerEquip.test.ts
 * エンジンごとの装備（T-0908）: プロンプトと上流を、エンジンごとの設定と役割から差す。
 *
 * 守りたいこと:
 *   - ルートは OS の設定そのもの・役割 root（いままでどおり）
 *   - ほかのエンジンは、自分の設定（OS の設定＋上書き）と役割から差される
 *   - OS の設定が変わると全部を差し直す。上書きした鍵は動かず、していない鍵は追随する
 *   - 外したエンジンには、もう差さない
 *   - 画面に出すモデル名（status）はルートのものだけ
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CognitiveManager } from './CognitiveManager';
import { overlayEngineConfig } from '../../core/sys/engineConfig';

function fakeOsConfig(llm: Record<string, unknown>) {
  const store: Record<string, unknown> = { llm, preferences: {} };
  const listeners: Array<(config: unknown, changed: ReadonlySet<string>) => void> = [];
  return {
    store,
    get: (category: string) => store[category],
    paths: () => undefined,
    onUpdate(cb: (config: unknown, changed: ReadonlySet<string>) => void) {
      listeners.push(cb);
      return () => {};
    },
    async fire(changed: string[]) {
      for (const cb of listeners) cb({}, new Set(changed));
      // 差し直しは非同期（上流の組み立てを待つ）
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

const fakeVfs = { exists: () => false, readFile: async () => '' };
const fakeEngine = (id: string) => ({ id, projector: null as any, llm: null as any });
const look = (engine: any) => ({
  adapter: engine.llm?.constructor.name ?? null,
  model: engine.llm?.modelName ?? null,
  temperature: engine.llm?.config?.temperature ?? null,
  role: /You are a \*\*sub engine\*\*/.test(engine.projector?.systemPrompt ?? '') ? 'sub' : 'root',
  thinking: /<define_tag name="thinking">/.test(engine.projector?.systemPrompt ?? ''),
});

function setup(llm: Record<string, unknown>) {
  (globalThis as any).localStorage = {
    getItem: (k: string) => (k === 'itera_llm_secrets' ? JSON.stringify({ anthropic: 'AK', openai: 'OK' }) : null),
    setItem: () => {},
    removeItem: () => {},
  };
  const os = fakeOsConfig(llm);
  const root = fakeEngine('root');
  const manager = new CognitiveManager(os as any, root as any, null as any, fakeVfs as any);
  const status: string[] = [];
  manager.setStatusCallback((s) => status.push(s));
  return { os, root, manager, status };
}

afterEach(() => {
  delete (globalThis as any).localStorage;
});

describe('CognitiveManager.equip — エンジンごとの装備', () => {
  it('ルートは OS の設定と役割 root、ほかのエンジンは自分の設定と役割から差される', async () => {
    const { os, root, manager, status } = setup({ model: 'anthropic/big', temperature: 0.2 });
    await manager.refreshEngineConfig();
    const sub = fakeEngine('e1');
    await manager.equip(
      sub as any,
      overlayEngineConfig(os, { llm: { model: 'openai/small', thinkingTag: true } }),
      'sub',
    );

    expect(look(root)).toEqual({
      adapter: 'AnthropicAdapter',
      model: 'big',
      temperature: 0.2,
      role: 'root',
      thinking: false,
    });
    expect(look(sub)).toEqual({
      adapter: 'OpenAIAdapter',
      model: 'small',
      temperature: 0.2,
      role: 'sub',
      thinking: true,
    });
    // 画面に出すのはルートのモデルだけ
    expect(status).toEqual(['anthropic/big']);
  });

  it('上書きの無いエンジンは、OS の設定のモデルで動く', async () => {
    const { os, manager } = setup({ model: 'anthropic/big' });
    const sub = fakeEngine('e1');
    await manager.equip(sub as any, overlayEngineConfig(os, {}), 'sub');
    expect(look(sub)).toMatchObject({ adapter: 'AnthropicAdapter', model: 'big', role: 'sub' });
  });

  it('OS の llm が変わると全部を差し直す: 上書きした鍵は動かず、していない鍵は追随する', async () => {
    const { os, root, manager, status } = setup({ model: 'anthropic/big', temperature: 0.2 });
    manager.start();
    await manager.refreshEngineConfig();
    const pinned = fakeEngine('e1');
    const following = fakeEngine('e2');
    await manager.equip(pinned as any, overlayEngineConfig(os, { llm: { model: 'openai/small' } }), 'sub');
    await manager.equip(following as any, overlayEngineConfig(os, {}), 'sub');
    const before = { root: root.llm, pinned: pinned.llm, following: following.llm };

    os.store.llm = { model: 'openai/other', temperature: 0.9 };
    await os.fire(['llm']);

    expect(look(root)).toMatchObject({ adapter: 'OpenAIAdapter', model: 'other', temperature: 0.9 });
    expect(look(pinned)).toMatchObject({ adapter: 'OpenAIAdapter', model: 'small', temperature: 0.9, role: 'sub' });
    expect(look(following)).toMatchObject({ adapter: 'OpenAIAdapter', model: 'other', temperature: 0.9, role: 'sub' });
    // 3 つとも作り直されている
    expect(root.llm).not.toBe(before.root);
    expect(pinned.llm).not.toBe(before.pinned);
    expect(following.llm).not.toBe(before.following);
    expect(status).toEqual(['anthropic/big', 'openai/other']);
  });

  it('外したエンジンには、もう差さない', async () => {
    const { os, root, manager } = setup({ model: 'anthropic/big' });
    manager.start();
    await manager.refreshEngineConfig();
    const sub = fakeEngine('e1');
    const unequip = await manager.equip(sub as any, overlayEngineConfig(os, {}), 'sub');
    const kept = sub.llm;
    unequip();
    unequip(); // 2 度呼んでも害は無い

    os.store.llm = { model: 'openai/other' };
    await os.fire(['llm']);

    expect(look(root)).toMatchObject({ model: 'other' });
    expect(sub.llm).toBe(kept);
  });

  it('ほかのエンジンの装備が失敗しても、ルートと残りは差し直される', async () => {
    const { os, root, manager } = setup({ model: 'anthropic/big' });
    await manager.refreshEngineConfig();
    const broken = fakeEngine('e1');
    const fine = fakeEngine('e2');
    const brokenConfig = { get: (c: string) => (c === 'llm' ? { model: 'anthropic/big' } : undefined) };
    await manager.equip(broken as any, brokenConfig as any, 'sub');
    await manager.equip(fine as any, overlayEngineConfig(os, {}), 'sub');
    // 以後、このエンジンの設定は読めない
    brokenConfig.get = () => {
      throw new Error('boom');
    };

    os.store.llm = { model: 'openai/other' };
    await manager.refreshEngineConfig();

    expect(look(root)).toMatchObject({ model: 'other' });
    expect(look(fine)).toMatchObject({ model: 'other' });
    expect(look(broken)).toMatchObject({ model: 'big' });
  });

  it('contextLimit は、渡された設定のモデルで引く（省けば OS の設定）', async () => {
    const { os, manager } = setup({ model: 'anthropic/big' });
    const files: Record<string, string> = {
      'system/registry/llm_profiles.json': JSON.stringify({
        providers: [
          { id: 'anthropic', models: [{ id: 'big', contextTokens: 1000 }] },
          { id: 'openai', models: [{ id: 'small', contextTokens: 50 }] },
        ],
      }),
    };
    const m2 = new CognitiveManager(
      os as any,
      fakeEngine('root') as any,
      null as any,
      {
        exists: (_p: unknown, path: string) => path in files,
        readFile: async (_p: unknown, path: string) => files[path],
      } as any,
    );
    expect(await m2.contextLimit()).toBe(1000);
    expect(await m2.contextLimit(overlayEngineConfig(os, { llm: { model: 'openai/small' } }))).toBe(50);
    void manager;
  });
});
