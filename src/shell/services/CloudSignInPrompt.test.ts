import { describe, it, expect, vi } from 'vitest';
import {
  promptEnabled,
  shouldPromptCloudSignIn,
  waitForAdaptersSettled,
  promptCloudSignInAtBoot,
  type AdapterStatusSource,
} from './CloudSignInPrompt';
import type { LoadedAdapter, SyncAdapterState, SyncAdapterStatus } from './SyncAdapterHost';

/** SyncAdapterHost の代わり: 状態を手で動かせる */
class FakeHost implements AdapterStatusSource {
  private adapters: LoadedAdapter[];
  private listeners: ((summary: SyncAdapterStatus, all: LoadedAdapter[]) => void)[] = [];
  constructor(states: SyncAdapterState[]) {
    this.adapters = states.map((state, i) => ({
      manifest: { id: `a${i}`, name: `A${i}`, path: `system/adapters/a${i}.js` },
      status: { state },
      blobUrl: '',
    }));
  }
  getAdapters(): LoadedAdapter[] {
    return this.adapters;
  }
  onStatusChange(listener: (summary: SyncAdapterStatus, all: LoadedAdapter[]) => void): void {
    this.listeners.push(listener);
  }
  set(i: number, state: SyncAdapterState): void {
    this.adapters[i].status = { state };
    for (const l of this.listeners) l({ state }, this.adapters);
  }
}

describe('promptEnabled', () => {
  it('true だけが真。未設定・文字列・1 は偽', () => {
    expect(promptEnabled(true)).toBe(true);
    expect(promptEnabled(undefined)).toBe(false);
    expect(promptEnabled('true')).toBe(false);
    expect(promptEnabled(1)).toBe(false);
    expect(promptEnabled(false)).toBe(false);
  });
});

describe('shouldPromptCloudSignIn', () => {
  it('切ってあれば出さない', () => {
    expect(shouldPromptCloudSignIn(false, ['disconnected'])).toBe(false);
  });
  it('アダプタが無ければ出さない（開いても何もできない）', () => {
    expect(shouldPromptCloudSignIn(true, [])).toBe(false);
  });
  it('1 つでも connected なら出さない', () => {
    expect(shouldPromptCloudSignIn(true, ['disconnected', 'connected'])).toBe(false);
  });
  it('disconnected / error / connecting（上限に達した）は出す', () => {
    expect(shouldPromptCloudSignIn(true, ['disconnected'])).toBe(true);
    expect(shouldPromptCloudSignIn(true, ['error'])).toBe(true);
    expect(shouldPromptCloudSignIn(true, ['connecting'])).toBe(true);
  });
});

describe('waitForAdaptersSettled', () => {
  it('connecting が無ければ即座に返す', async () => {
    const host = new FakeHost(['disconnected', 'connected']);
    const all = await waitForAdaptersSettled(host, 1000);
    expect(all.map((a) => a.status.state)).toEqual(['disconnected', 'connected']);
  });

  it('connecting が抜けた瞬間に返す', async () => {
    vi.useFakeTimers();
    try {
      const host = new FakeHost(['connecting']);
      const p = waitForAdaptersSettled(host, 5000);
      let resolved = false;
      void p.then(() => (resolved = true));
      await vi.advanceTimersByTimeAsync(300);
      expect(resolved).toBe(false);
      host.set(0, 'connected');
      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(true);
      expect((await p)[0].status.state).toBe('connected');
    } finally {
      vi.useRealTimers();
    }
  });

  it('上限に達したらそのときの一覧（connecting のまま）を返す', async () => {
    vi.useFakeTimers();
    try {
      const host = new FakeHost(['connecting']);
      const p = waitForAdaptersSettled(host, 5000);
      await vi.advanceTimersByTimeAsync(5000);
      expect((await p)[0].status.state).toBe('connecting');
      // 遅れて来た変化で二度目の解決や例外が起きない
      host.set(0, 'connected');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('promptCloudSignInAtBoot', () => {
  it('設定が無ければ待たずに終わる（アダプタの状態を見ない）', async () => {
    const host = new FakeHost(['disconnected']);
    const open = vi.fn();
    expect(await promptCloudSignInAtBoot(host, { readPref: () => undefined, open })).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it('true で未接続なら開く。onPrompt にそのときの状態が渡る', async () => {
    const host = new FakeHost(['disconnected']);
    const open = vi.fn();
    const onPrompt = vi.fn();
    expect(await promptCloudSignInAtBoot(host, { readPref: () => true, open, onPrompt })).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(onPrompt).toHaveBeenCalledWith(['disconnected']);
  });

  it('復元中（connecting）は待ち、connected になれば開かない', async () => {
    vi.useFakeTimers();
    try {
      const host = new FakeHost(['connecting']);
      const open = vi.fn();
      const p = promptCloudSignInAtBoot(host, { readPref: () => true, open, timeoutMs: 5000 });
      await vi.advanceTimersByTimeAsync(800);
      host.set(0, 'connected');
      expect(await p).toBe(false);
      expect(open).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('復元中（connecting）のまま上限に達したら開く（connecting は connected ではない）', async () => {
    vi.useFakeTimers();
    try {
      const host = new FakeHost(['connecting']);
      const open = vi.fn();
      const p = promptCloudSignInAtBoot(host, { readPref: () => true, open, timeoutMs: 5000 });
      await vi.advanceTimersByTimeAsync(5000);
      expect(await p).toBe(true);
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('アダプタが 1 つも無ければ開かない', async () => {
    const host = new FakeHost([]);
    const open = vi.fn();
    expect(await promptCloudSignInAtBoot(host, { readPref: () => true, open })).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});
