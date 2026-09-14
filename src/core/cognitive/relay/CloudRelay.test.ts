/**
 * src/core/cognitive/rela./CloudRelay.test.ts
 *
 * 守りたいこと:
 *   1. 接続先は cloud.json の functionsBase から組み立てる。無ければ**作らない**（itera2-dev には中継が無い）
 *   2. 別名は id / 表示名 / 別名のどれでも引けるが、**知らないものは推測しない**
 *   3. 形式（anthropic / openai / google）が不明なものは採用しない。
 *      当てずっぽうで話すと上流は 400 か解釈不能な応答を返し、利用者からは
 *      「AI が壊れた」ようにしか見えない
 */

import { describe, it, expect } from 'vitest';
import {
  buildRelayBaseUrl,
  fetchRelayCatalog,
  normalizeRelayCatalog,
  RELAY_CATALOG_RETRY_MS,
  RELAY_CATALOG_TTL_MS,
  RelayCatalogCache,
  resolveRelayModel,
  UnavailableRelayAdapter,
} from './CloudRelay';

const MODELS = [
  { id: 'smart', name: '賢い', aliases: ['賢い', 'smart'], upstream: 'anthropic' },
  { id: 'standard', name: '普通', aliases: ['普通', 'standard'], upstream: 'google' },
];

describe('中継の接続先', () => {
  it('cloud.json の functionsBase に関数名を足して組み立てる', () => {
    expect(buildRelayBaseUrl('https://asia-northeast1-itera2.cloudfunctions.net')).toBe(
      'https://asia-northeast1-itera2.cloudfunctions.net/llmProxy',
    );
  });

  it('前後の空白と末尾のスラッシュは落とす', () => {
    expect(buildRelayBaseUrl('  https://asia-northeast1-itera2.cloudfunctions.net/  ')).toBe(
      'https://asia-northeast1-itera2.cloudfunctions.net/llmProxy',
    );
  });

  it('繋ぎ先が無ければ URL を作らない（itera2-dev はこれ）', () => {
    expect(buildRelayBaseUrl(null)).toBeNull();
    expect(buildRelayBaseUrl(undefined)).toBeNull();
    expect(buildRelayBaseUrl('')).toBeNull();
    expect(buildRelayBaseUrl('   ')).toBeNull();
  });
});

describe('別名の解決', () => {
  it('id で引ける', () => {
    expect(resolveRelayModel(MODELS, 'smart')?.id).toBe('smart');
  });

  it('表示名（日本語）で引ける', () => {
    expect(resolveRelayModel(MODELS, '賢い')?.id).toBe('smart');
  });

  it('別名で引ける', () => {
    expect(resolveRelayModel(MODELS, '普通')?.id).toBe('standard');
  });

  it('前後の空白があっても引ける', () => {
    expect(resolveRelayModel(MODELS, ' smart ')?.id).toBe('smart');
  });

  it('知らない選択肢は null（似たものを当てない）', () => {
    expect(resolveRelayModel(MODELS, 'sma')).toBeNull();
    expect(resolveRelayModel(MODELS, '最強')).toBeNull();
    expect(resolveRelayModel(MODELS, '')).toBeNull();
  });

  it('形式が不明な選択肢は採用しない', () => {
    const models = [{ id: 'mystery', upstream: 'bedrock' }];
    expect(resolveRelayModel(models, 'mystery')).toBeNull();
  });

  it('形式が欠けている選択肢は採用しない', () => {
    const models = [{ id: 'mystery' }];
    expect(resolveRelayModel(models, 'mystery')).toBeNull();
  });

  it('一覧が配列でなければ null', () => {
    expect(resolveRelayModel(undefined, 'smart')).toBeNull();
    expect(resolveRelayModel({}, 'smart')).toBeNull();
  });
});

describe('繋げないときのアダプタ', () => {
  it('生成しようとした時点で理由を出して失敗する', async () => {
    const adapter = new UnavailableRelayAdapter('no Itera Cloud relay configured');
    await expect(adapter.generateStream()).rejects.toThrow('no Itera Cloud relay configured');
  });
});

describe('台帳の写し替え', () => {
  const CATALOG = {
    models: [
      { id: 'smart', name: '賢い', aliases: ['賢い', 'smart'], provider: 'anthropic', order: 10 },
      { id: 'standard', name: '普通', aliases: ['普通'], provider: 'google', contextTokens: 1048576 },
    ],
  };

  it('中継の provider を upstream として読み、別名を保つ', () => {
    const entries = normalizeRelayCatalog(CATALOG)!;
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ id: 'smart', upstream: 'anthropic', aliases: ['賢い', 'smart'] });
    expect(entries[1]).toMatchObject({ id: 'standard', upstream: 'google', contextTokens: 1048576 });
  });

  it('生の配列でも { models: [...] } でも受ける', () => {
    expect(normalizeRelayCatalog(CATALOG.models)).toHaveLength(2);
    expect(normalizeRelayCatalog(CATALOG)).toHaveLength(2);
  });

  it('上流の種別が分からない項目は捨てる（推測しない）', () => {
    const entries = normalizeRelayCatalog([
      { id: 'a', provider: 'anthropic' },
      { id: 'b', provider: 'cohere' },
      { id: 'c' },
      { id: 'd', provider: 42 },
    ])!;
    expect(entries.map((e) => e.id)).toEqual(['a']);
  });

  it('id が無い項目は捨てる', () => {
    const entries = normalizeRelayCatalog([
      { provider: 'google' },
      { id: '   ', provider: 'google' },
      { id: 'ok', provider: 'google' },
    ])!;
    expect(entries.map((e) => e.id)).toEqual(['ok']);
  });

  it('別名は文字列だけを残す', () => {
    const entries = normalizeRelayCatalog([{ id: 'a', provider: 'google', aliases: ['良い', 3, null, ''] }])!;
    expect(entries[0].aliases).toEqual(['良い']);
    const noAliases = normalizeRelayCatalog([{ id: 'a', provider: 'google', aliases: 'ダメ' }])!;
    expect(noAliases[0].aliases).toEqual([]);
  });

  it('空や形の違うものは「取れなかった」として null にする', () => {
    expect(normalizeRelayCatalog({ models: [] })).toBeNull();
    expect(normalizeRelayCatalog([])).toBeNull();
    expect(normalizeRelayCatalog(null)).toBeNull();
    expect(normalizeRelayCatalog({ models: 'x' })).toBeNull();
    // 中身が全部捨てられた場合も null（空一覧を配ると選択肢が消える）
    expect(normalizeRelayCatalog([{ id: 'a', provider: 'cohere' }])).toBeNull();
  });

  it('写した別名は、そのまま解決に使える', () => {
    const entries = normalizeRelayCatalog(CATALOG)!;
    expect(resolveRelayModel(entries, '賢い')?.id).toBe('smart');
  });

  it('表示名と違う別名でも引ける（別名を落としていないこと）', () => {
    // `resolveRelayModel` は表示名でも引けるため、名と同じ語では別名の欠落を検出できない。
    // 名に無い語で確かめる。
    const entries = normalizeRelayCatalog([
      { id: 'smart', name: '賢い', aliases: ['sonnet', 'かしこい'], provider: 'anthropic' },
    ])!;
    expect(resolveRelayModel(entries, 'sonnet')?.id).toBe('smart');
    expect(resolveRelayModel(entries, 'かしこい')?.id).toBe('smart');
  });
});

describe('台帳の取得', () => {
  const BASE = 'https://asia-northeast1-p.cloudfunctions.net/llm_proxy';
  const headers = async () => ({ Authorization: 'Bearer T' });

  it('/models を GET し、認証ヘッダを渡す', async () => {
    const calls: any[] = [];
    const fetchImpl = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return { ok: true, json: async () => ({ models: [{ id: 'a', provider: 'google' }] }) };
    }) as any;

    const entries = await fetchRelayCatalog(BASE, headers, { fetchImpl });
    expect(entries?.map((e) => e.id)).toEqual(['a']);
    expect(calls[0].url).toBe(`${BASE}/models`);
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.headers).toEqual({ Authorization: 'Bearer T' });
  });

  it('認証ヘッダが取れなければ、取りに行かない', async () => {
    // 例外を投げさせても catch に飲まれて null になるため、証拠にならない。
    // 「呼ばれた回数」で確かめる。
    let called = 0;
    const fetchImpl = (async () => {
      called += 1;
      return { ok: true, json: async () => ({ models: [{ id: 'a', provider: 'google' }] }) };
    }) as any;

    expect(await fetchRelayCatalog(BASE, async () => null, { fetchImpl })).toBeNull();
    expect(called).toBe(0);
  });

  it('中継が失敗を返したら null（例外にしない）', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 503 })) as any;
    expect(await fetchRelayCatalog(BASE, headers, { fetchImpl })).toBeNull();
  });

  it('通信が失敗しても投げない', async () => {
    const fetchImpl = (async () => {
      throw new Error('offline');
    }) as any;
    await expect(fetchRelayCatalog(BASE, headers, { fetchImpl })).resolves.toBeNull();
  });
});

describe('台帳の使い回し', () => {
  const good = [{ id: 'a', name: 'a', aliases: [], upstream: 'google' as const }];

  it('期限内は取り直さない', async () => {
    const cache = new RelayCatalogCache();
    let count = 0;
    const load = async () => {
      count += 1;
      return good;
    };

    expect(await cache.get(load, 1000)).toEqual(good);
    expect(await cache.get(load, 1000 + RELAY_CATALOG_TTL_MS - 1)).toEqual(good);
    expect(count).toBe(1);
  });

  it('期限が切れたら取り直す', async () => {
    const cache = new RelayCatalogCache();
    let count = 0;
    const load = async () => {
      count += 1;
      return good;
    };

    await cache.get(load, 1000);
    await cache.get(load, 1000 + RELAY_CATALOG_TTL_MS);
    expect(count).toBe(2);
  });

  it('取れなかったときに、直前の内容を捨てない', async () => {
    const cache = new RelayCatalogCache();
    await cache.get(async () => good, 1000);

    const kept = await cache.get(async () => null, 1000 + RELAY_CATALOG_TTL_MS);
    expect(kept).toEqual(good);
  });

  it('失敗した直後は短い間隔で取り直す', async () => {
    const cache = new RelayCatalogCache();
    let count = 0;
    const load = async () => {
      count += 1;
      return null;
    };

    await cache.get(load, 1000);
    await cache.get(load, 1000 + RELAY_CATALOG_RETRY_MS - 1); // まだ試さない
    expect(count).toBe(1);
    await cache.get(load, 1000 + RELAY_CATALOG_RETRY_MS);
    expect(count).toBe(2);
  });

  it('取れた台帳を store に残し、次の起動では取りに行く前からそれを返す', async () => {
    const box: { value: string | null } = { value: null };
    const store = { get: () => box.value, set: (v: string) => void (box.value = v) };

    const first = new RelayCatalogCache(store);
    expect(first.peek()).toBeNull();
    await first.get(async () => good, 1000);
    expect(box.value).not.toBeNull();

    const second = new RelayCatalogCache(store);
    expect(second.peek()).toEqual(good);
    // 取りに行って失敗しても、控えのまま
    expect(await second.get(async () => null, 2000)).toEqual(good);
  });

  it('壊れた控えは捨てる（投げない）', () => {
    const broken = new RelayCatalogCache({ get: () => '{not json', set: () => {} });
    expect(broken.peek()).toBeNull();
    const wrongShape = new RelayCatalogCache({ get: () => JSON.stringify([{ id: 'x' }]), set: () => {} });
    expect(wrongShape.peek()).toBeNull(); // upstream が無い項目は捨てる → 空 → null
  });

  it('store が読めない・書けなくても台帳は使える', async () => {
    const store = {
      get: () => {
        throw new Error('denied');
      },
      set: () => {
        throw new Error('denied');
      },
    };
    const cache = new RelayCatalogCache(store);
    expect(await cache.get(async () => good, 1000)).toEqual(good);
  });

  it('同時に呼ばれても取得は1回にまとめる', async () => {
    const cache = new RelayCatalogCache();
    let count = 0;
    const load = async () => {
      count += 1;
      await new Promise((r) => setTimeout(r, 5));
      return good;
    };

    const [a, b] = await Promise.all([cache.get(load, 1000), cache.get(load, 1000)]);
    expect(a).toEqual(good);
    expect(b).toEqual(good);
    expect(count).toBe(1);
  });
});
