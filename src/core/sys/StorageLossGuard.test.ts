// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StorageLossGuard } from './StorageLossGuard';

/**
 * src/core/sys/StorageLossGuard.test.ts
 * 動作中のストレージ消失 — T-0382
 *
 * 押さえるのは 3 点。
 *  1. trip は 1 度しか動かない（DB が 2 つあり、close と versionchange の両方から届く）
 *  2. 順序: 停止（登録した handler）→ 画面を覆う → 読み込み直す。handler が落ちても続ける
 *  3. 通知は起動後に 1 度だけ取り出せる
 */

describe('StorageLossGuard', () => {
  beforeEach(() => {
    localStorage.clear();
    StorageLossGuard._resetForTest();
  });
  afterEach(() => {
    StorageLossGuard._resetForTest();
    localStorage.clear();
  });

  it('1 度だけ: 停止 → 覆う → 読み込み直す。2 回目は何もしない', async () => {
    const order: string[] = [];
    const reload = vi.fn(() => order.push('reload'));
    StorageLossGuard.reload = reload;
    StorageLossGuard.reloadDelayMs = 0;
    StorageLossGuard.onTrip(() => {
      order.push('halt1');
    });
    StorageLossGuard.onTrip(async () => {
      order.push('halt2');
    });

    await StorageLossGuard.trip('vfs close');
    await StorageLossGuard.trip('history close');
    await new Promise((r) => setTimeout(r, 5));

    expect(StorageLossGuard.isTripped()).toBe(true);
    expect(order).toEqual(['halt1', 'halt2', 'reload']);
    expect(document.getElementById('storage-loss-overlay')).not.toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('停止の handler が落ちても読み込み直しまで進む', async () => {
    const reload = vi.fn();
    StorageLossGuard.reload = reload;
    StorageLossGuard.reloadDelayMs = 0;
    StorageLossGuard.onTrip(() => {
      throw new Error('kill failed');
    });

    await StorageLossGuard.trip('vfs versionchange');
    await new Promise((r) => setTimeout(r, 5));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('通知は 1 度だけ取り出せる', async () => {
    StorageLossGuard.reload = vi.fn();
    StorageLossGuard.reloadDelayMs = 0;
    expect(StorageLossGuard.consumeNotice()).toBeNull();
    await StorageLossGuard.trip('vfs close');
    expect(StorageLossGuard.consumeNotice()).toBe('vfs close');
    expect(StorageLossGuard.consumeNotice()).toBeNull();
  });
});
