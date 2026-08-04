/**
 * src/core/vfs/VfsLockManager.test.ts
 * Itera OS v2: VfsLockManager Test Suite
 *
 * NOTE: These tests were written before the fixes in this PR (Task 1 & 2).
 * The first two tests are expected to FAIL against the pre-fix implementation
 * (red), and PASS once the corresponding fixes are applied (green).
 */

import { describe, it, expect } from 'vitest';
import { VfsLockManager } from './VfsLockManager';

describe('VfsLockManager', () => {
  it('releases internal lock map entries after sequential acquire() calls complete', async () => {
    const manager = new VfsLockManager();

    for (let i = 0; i < 5; i++) {
      await manager.acquire('data/x.txt', async () => i);
    }

    // Regression test for Task 1: the `finally` cleanup compared the stored
    // map entry against `nextLock` instead of the chained promise that was
    // actually stored, so it always evaluated to false and the entry was
    // never removed. After 5 sequential (non-overlapping) acquisitions of
    // the SAME path, the internal map must be empty.
    expect((manager as any).locks.size).toBe(0);
  });

  it('acquireMultiple() with ancestor/descendant paths completes without deadlocking', async () => {
    const manager = new VfsLockManager();

    const task = manager.acquireMultiple(['data', 'data/backup'], async () => 'done');

    const timeout = new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error('Timed out: possible self-deadlock')), 1000),
    );

    // Regression test for Task 2: acquireMultiple() used to acquire nested
    // locks for an ancestor and its own descendant, causing the inner
    // acquire() to wait on a lock that the outer acquire() (itself) was
    // holding -> permanent self-deadlock.
    const result = await Promise.race([task, timeout]);
    expect(result).toBe('done');
  });

  it('serializes concurrent acquire() calls to the same path', async () => {
    const manager = new VfsLockManager();
    const order: number[] = [];

    const makeTask = (id: number, delay: number) =>
      manager.acquire('data/shared.txt', async () => {
        order.push(id);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return id;
      });

    await Promise.all([makeTask(1, 30), makeTask(2, 10), makeTask(3, 0)]);

    // Regardless of each task's internal delay, entry into the critical
    // section must follow strict call order because acquire() is a mutex.
    expect(order).toEqual([1, 2, 3]);
  });

  it('blocks acquire() on a descendant path while an ancestor path is locked', async () => {
    const manager = new VfsLockManager();
    const events: string[] = [];

    let releaseParent!: () => void;
    const parentGate = new Promise<void>((resolve) => {
      releaseParent = resolve;
    });

    const parentTask = manager.acquire('data', async () => {
      events.push('parent:enter');
      await parentGate;
      events.push('parent:exit');
    });

    // Let the parent task actually enter its critical section first.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const childTask = manager.acquire('data/child.txt', async () => {
      events.push('child:enter');
    });

    // The child must still be waiting, since the ancestor lock is held.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(['parent:enter']);

    releaseParent();
    await Promise.all([parentTask, childTask]);

    expect(events).toEqual(['parent:enter', 'parent:exit', 'child:enter']);
  });

  it('releases the lock even if the task throws, allowing subsequent acquire() to proceed', async () => {
    const manager = new VfsLockManager();

    await expect(
      manager.acquire('data/y.txt', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // A subsequent acquire() on the same path must not hang because of the
    // failed previous task.
    const result = await Promise.race([
      manager.acquire('data/y.txt', async () => 'recovered'),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('Timed out: lock was not released after throw')), 1000),
      ),
    ]);

    expect(result).toBe('recovered');
  });

  it('normalizes paths consistently across trailing slashes, duplicate slashes, backslashes, and empty strings', () => {
    const manager = new VfsLockManager();
    const normalize = (p: string) => (manager as any)._normalize(p);

    expect(normalize('')).toBe('');
    expect(normalize('data/')).toBe('data');
    expect(normalize('data//x.txt')).toBe('data/x.txt');
    expect(normalize('data\\x.txt')).toBe('data/x.txt');
    expect(normalize('/data/x.txt/')).toBe('/data/x.txt');
  });

  // TODO: `_normalize('')` (the VFS root) does not "absorb" other paths as an
  // ancestor, because `''.startsWith(other + '/')` is never true for a
  // non-empty `other`, and `path.startsWith('' + '/')` is also never true.
  // This means acquire('') does NOT block/get-blocked-by unrelated paths via
  // the ancestor/descendant prefix check the way a normal directory would.
  // This is pre-existing behavior and intentionally left unchanged by this
  // task; recorded here for future reference.
});