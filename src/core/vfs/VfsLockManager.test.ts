import { describe, it, expect, vi } from 'vitest';
import { VfsLockManager } from './VfsLockManager';

describe('VfsLockManager', () => {
  it('releases map entry after sequential acquire calls', async () => {
    const lock = new VfsLockManager();
    for (let i = 0; i < 5; i++) {
      await lock.acquire('data/x.txt', async () => {});
    }
    // @ts-expect-error accessing private locks for assertion
    expect(lock.locks.size).toBe(0);
  });

  it('handles acquireMultiple with ancestor and descendant without deadlocking', async () => {
    const lock = new VfsLockManager();
    const task = vi.fn().mockResolvedValue('ok');

    const resultPromise = lock.acquireMultiple(['data', 'data/backup'], task);

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout: deadlock detected')), 1000),
    );

    await expect(Promise.race([resultPromise, timeoutPromise])).resolves.toBe('ok');
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent acquire calls on the same path', async () => {
    const lock = new VfsLockManager();
    const executionOrder: number[] = [];

    const task = (id: number, delayMs: number) => async () => {
      executionOrder.push(id * 10);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      executionOrder.push(id * 10 + 1);
    };

    await Promise.all([
      lock.acquire('data/test.txt', task(1, 50)),
      lock.acquire('data/test.txt', task(2, 10)),
      lock.acquire('data/test.txt', task(3, 10)),
    ]);

    expect(executionOrder).toEqual([10, 11, 20, 21, 30, 31]);
  });

  it('blocks descendant acquire when ancestor is locked', async () => {
    const lock = new VfsLockManager();
    const order: string[] = [];

    let releaseAncestor!: () => void;
    const ancestorHeld = new Promise<void>((resolve) => {
      releaseAncestor = resolve;
    });

    const p1 = lock.acquire('data', async () => {
      order.push('ancestor-start');
      await ancestorHeld;
      order.push('ancestor-end');
    });

    await new Promise((r) => setTimeout(r, 10));

    const p2 = lock.acquire('data/child/file.txt', async () => {
      order.push('descendant-start');
      order.push('descendant-end');
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['ancestor-start']);

    releaseAncestor();
    await Promise.all([p1, p2]);

    expect(order).toEqual(['ancestor-start', 'ancestor-end', 'descendant-start', 'descendant-end']);
  });

  it('releases lock even when task throws an error', async () => {
    const lock = new VfsLockManager();

    await expect(
      lock.acquire('data/file.txt', async () => {
        throw new Error('Task error');
      }),
    ).rejects.toThrow('Task error');

    const nextTask = vi.fn().mockResolvedValue('success');
    await expect(lock.acquire('data/file.txt', nextTask)).resolves.toBe('success');
    expect(nextTask).toHaveBeenCalled();
  });

  it('normalizes path variations correctly', async () => {
    const lock = new VfsLockManager();
    // @ts-expect-error accessing private method for assertion
    const normalize = lock._normalize.bind(lock);

    expect(normalize('data/file.txt/')).toBe('data/file.txt');
    expect(normalize('data//sub///file.txt')).toBe('data/sub/file.txt');
    expect(normalize('data\\sub\\file.txt')).toBe('data/sub/file.txt');
    expect(normalize('')).toBe('');
    expect(normalize('  data/file.txt  ')).toBe('data/file.txt');
  });
});