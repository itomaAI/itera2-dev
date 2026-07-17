/**
 * src/core/vfs/VfsEventBus.ts
 * Itera OS VFS v2: Mutation Batching and Pub/Sub System
 */

import type { VfsMutation } from './types';

export type VfsEventSubscriber = (mutations: VfsMutation[]) => void;

export class VfsEventBus {
  private subscribers: Set<VfsEventSubscriber> = new Set();
  private mutationQueue: VfsMutation[] = [];
  private batchTimerId: ReturnType<typeof setTimeout> | null = null;
  private readonly BATCH_INTERVAL_MS = 16;

  subscribe(callback: VfsEventSubscriber): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  publish(mutation: VfsMutation): void {
    this.mutationQueue.push(mutation);

    if (this.batchTimerId === null) {
      this.batchTimerId = setTimeout(() => {
        this._flush();
      }, this.BATCH_INTERVAL_MS);
    }
  }

  private _flush(): void {
    this.batchTimerId = null;

    if (this.mutationQueue.length === 0) return;

    const mutationsToDispatch = this.mutationQueue;
    this.mutationQueue = [];

    for (const subscriber of this.subscribers) {
      try {
        subscriber(mutationsToDispatch);
      } catch (e) {
        console.error('[VfsEventBus] Error in subscriber callback:', e);
      }
    }
  }

  flushNow(): void {
    if (this.batchTimerId !== null) {
      clearTimeout(this.batchTimerId);
    }
    this._flush();
  }

  clear(): void {
    if (this.batchTimerId !== null) {
      clearTimeout(this.batchTimerId);
      this.batchTimerId = null;
    }
    this.mutationQueue = [];
  }
}
