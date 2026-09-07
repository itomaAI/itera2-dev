import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ContentStore, isTransientOpfsError } from './ContentStore';

/**
 * src/core/vfs/ContentStoreRetry.test.ts
 * OPFS 書き込みの再試行 — T-0380（1 回の一過性の失敗で OS が起動しない状態をやめる）
 *
 * 押さえるのは 3 点。
 *  1. InvalidStateError は「ハンドルを取り直して」やり直し、解ければ成功として返す
 *  2. 回数を使い切ったら従来どおり `OPFS Write Error: …` で投げる（黙って飲み込まない）
 *  3. 一過性でない例外（TypeError 等）は 1 回で投げる（やり直しても変わらない）
 */

class NamedError extends Error {
  constructor(name: string, message = name) {
    super(message);
    this.name = name;
  }
}

function makeOpfs(failures: Array<Error | null>) {
  // failures[i] が null なら i 回目の createWritable は成功する
  const counters = { getDirectory: 0, createWritable: 0, close: 0, abort: 0 };
  const writes: unknown[] = [];
  const handle = {
    createWritable: async () => {
      const i = counters.createWritable++;
      const err = failures[i] ?? null;
      return {
        write: async (c: unknown) => {
          writes.push(c);
        },
        close: async () => {
          counters.close++;
          if (err) throw err;
        },
        abort: async () => {
          counters.abort++;
        },
      };
    },
  };
  const root = { getFileHandle: async () => handle };
  const storage = {
    getDirectory: async () => {
      counters.getDirectory++;
      return root;
    },
  };
  return { storage, counters, writes };
}

describe('ContentStore.write の再試行', () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'storage');

  beforeEach(() => {
    /* 各テストで storage を差し替える */
  });

  afterEach(() => {
    if (original) Object.defineProperty(navigator, 'storage', original);
    else delete (navigator as any).storage;
  });

  function install(storage: unknown) {
    Object.defineProperty(navigator, 'storage', { value: storage, configurable: true });
  }

  it('InvalidStateError が 2 回続いても、3 回目で通れば成功として返す（ルートも取り直す）', async () => {
    const invalid = new NamedError('InvalidStateError');
    const opfs = makeOpfs([invalid, invalid, null]);
    install(opfs.storage);

    const store = new ContentStore({ retryDelaysMs: [0, 0] });
    const ref = await store.write('k1', 'hello');

    expect(ref).toEqual({ backend: 'opfs', key: 'k1' });
    expect(opfs.counters.createWritable).toBe(3);
    // 1 回目は constructor、2・3 回目は再試行で取り直している
    expect(opfs.counters.getDirectory).toBe(3);
    // 失敗した 2 回は abort で swap を片づけている
    expect(opfs.counters.abort).toBe(2);
  });

  it('回数を使い切ったら OPFS Write Error で投げる', async () => {
    const invalid = new NamedError('InvalidStateError', 'state changed');
    const opfs = makeOpfs([invalid, invalid, invalid, invalid]);
    install(opfs.storage);

    const store = new ContentStore({ retryDelaysMs: [0, 0] });
    await expect(store.write('k2', 'x')).rejects.toThrow(/OPFS Write Error: state changed/);
    expect(opfs.counters.createWritable).toBe(3);
  });

  it('一過性でない例外は 1 回で投げる', async () => {
    const opfs = makeOpfs([new TypeError('boom')]);
    install(opfs.storage);

    const store = new ContentStore({ retryDelaysMs: [0, 0] });
    await expect(store.write('k3', 'x')).rejects.toThrow(/OPFS Write Error: boom/);
    expect(opfs.counters.createWritable).toBe(1);
    expect(opfs.counters.getDirectory).toBe(1);
  });

  it('isTransientOpfsError は名前だけを見る', () => {
    expect(isTransientOpfsError(new NamedError('InvalidStateError'))).toBe(true);
    expect(isTransientOpfsError(new NamedError('NoModificationAllowedError'))).toBe(true);
    expect(isTransientOpfsError(new NamedError('QuotaExceededError'))).toBe(false);
    expect(isTransientOpfsError(new TypeError('x'))).toBe(false);
    expect(isTransientOpfsError(null)).toBe(false);
    expect(isTransientOpfsError('InvalidStateError')).toBe(false);
  });
});
