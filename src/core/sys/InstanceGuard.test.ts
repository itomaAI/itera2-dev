// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InstanceGuard, type LockManagerLike, type ChannelLike } from './InstanceGuard';

/**
 * src/core/sys/InstanceGuard.test.ts
 * 単一インスタンス — T-0384
 *
 * 押さえるのは 4 点。
 *  1. 最初のタブが鍵を取り、2 つ目は 'held'（起動しない）。Web Locks が無ければ 'unsupported'
 *  2. 引き継ぎ: 待機中のタブが頼むと、持ち主は halt → 覆い → 鍵を返し、待機中のタブが鍵を受け取る
 *  3. 持ち主が返事をしなければ、待機中のタブは奪う。奪われた側は request の AbortError で自分を止める
 *  4. 引き継ぎは 2 度動かない
 *
 * 「タブ」は InstanceGuard の別インスタンス。鍵と通路は偽物を共有する。
 */

class AbortErr extends Error {
  name = 'AbortError';
}

/** Web Locks の偽物: 持ち主 1 つ・待ち行列・ifAvailable・steal・signal */
class FakeLocks implements LockManagerLike {
  private holder: { reject: (e: unknown) => void } | null = null;
  private queue: Array<{ grant: () => void; reject: (e: unknown) => void }> = [];
  granted = 0;

  request(name: string, options: any, callback: (lock: unknown) => unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const grant = () => {
        const holder = { reject };
        this.holder = holder;
        this.granted++;
        Promise.resolve(callback({ name })).then(
          (v) => {
            if (this.holder === holder) {
              this.holder = null;
              this.next();
            }
            resolve(v);
          },
          (e) => reject(e),
        );
      };
      if (!this.holder) return grant();
      if (options?.ifAvailable) return Promise.resolve(callback(null)).then(resolve, reject);
      if (options?.steal) {
        const old = this.holder;
        this.holder = null;
        old.reject(new AbortErr('stolen'));
        return grant();
      }
      const entry = { grant, reject };
      this.queue.push(entry);
      options?.signal?.addEventListener('abort', () => {
        this.queue = this.queue.filter((x) => x !== entry);
        reject(new AbortErr('aborted'));
      });
    });
  }

  private next() {
    const e = this.queue.shift();
    if (e) e.grant();
  }
}

/** BroadcastChannel の偽物: 同じバスに繋がった相手全員へ（自分以外） */
class FakeBus {
  subs = new Set<FakeChannel>();
  open = () => new FakeChannel(this);
}
class FakeChannel implements ChannelLike {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  private readonly bus: FakeBus;
  constructor(bus: FakeBus) {
    this.bus = bus;
    bus.subs.add(this);
  }
  postMessage(message: unknown): void {
    for (const s of this.bus.subs) {
      if (s !== this && s.onmessage) queueMicrotask(() => s.onmessage && s.onmessage({ data: message }));
    }
  }
  close(): void {
    this.bus.subs.delete(this);
  }
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe('InstanceGuard', () => {
  let locks: FakeLocks;
  let bus: FakeBus;
  let reloaded: string[];
  const tab = (name: string, openChannel?: () => ChannelLike | null) =>
    new InstanceGuard({
      locks,
      openChannel: openChannel ?? bus.open,
      reload: () => reloaded.push(name),
      reloadDelayMs: 0,
    });

  beforeEach(() => {
    locks = new FakeLocks();
    bus = new FakeBus();
    reloaded = [];
  });
  afterEach(() => {
    document.querySelectorAll('.instance-handover-overlay').forEach((el) => el.remove());
  });

  it('最初のタブが取り、2 つ目は held。Web Locks が無ければ unsupported', async () => {
    const a = tab('A');
    const b = tab('B');
    expect(await a.claim()).toBe('acquired');
    expect(a.isHolding()).toBe(true);
    expect(await b.claim()).toBe('held');
    expect(b.isHolding()).toBe(false);

    const c = new InstanceGuard({ locks: null });
    expect(await c.claim()).toBe('unsupported');
  });

  it('引き継ぎ: 持ち主は halt → 覆い → 鍵を返し、待機中のタブが受け取る', async () => {
    const order: string[] = [];
    const a = tab('A');
    const b = tab('B');
    expect(await a.claim()).toBe('acquired');
    a.onHandover(() => {
      order.push('A:halt');
    });
    expect(await b.claim()).toBe('held');

    const result = await b.takeOver(1000);
    order.push(`B:${result}`);

    expect(order).toEqual(['A:halt', 'B:handed']);
    expect(a.isHolding()).toBe(false);
    expect(b.isHolding()).toBe(true);
    expect(document.querySelector('.instance-handover-overlay')).not.toBeNull();
    expect(locks.granted).toBe(2);
    await tick();
    // 手放した側だけ読み込み直す（受け取った側はその場で起動する）
    expect(reloaded).toEqual(['A']);
  });

  it('持ち主が返事をしなければ奪う。奪われた側は AbortError で自分を止める', async () => {
    const halted: string[] = [];
    const a = tab('A', () => null); // 通路を張らない持ち主（固まったタブ）
    const b = tab('B');
    expect(await a.claim()).toBe('acquired');
    a.onHandover(() => {
      halted.push('A');
    });

    const result = await b.takeOver(20);
    await tick();

    expect(result).toBe('stolen');
    expect(b.isHolding()).toBe(true);
    expect(a.isHolding()).toBe(false);
    expect(halted).toEqual(['A']);
    expect(locks.granted).toBe(2);
    await tick();
    expect(reloaded).toEqual(['A']);
  });

  it('引き継ぎは 2 度動かない', async () => {
    let n = 0;
    const a = tab('A');
    expect(await a.claim()).toBe('acquired');
    a.onHandover(() => {
      n++;
    });
    await a.handOver('handover');
    await a.handOver('handover');
    expect(n).toBe(1);
    expect(a.isHolding()).toBe(false);
  });
});
