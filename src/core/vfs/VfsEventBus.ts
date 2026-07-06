/**
 * src/core/vfs/VfsEventBus.ts
 * Itera OS VFS v2: Event Batching and Pub/Sub System
 */

import type { VfsEvent } from "./types";

export type VfsEventSubscriber = (events: VfsEvent[]) => void;

export class VfsEventBus {
  private subscribers: Set<VfsEventSubscriber> = new Set();
  private eventQueue: VfsEvent[] = [];
  private batchTimerId: ReturnType<typeof setTimeout> | null = null;
  private readonly BATCH_INTERVAL_MS = 16;

  subscribe(callback: VfsEventSubscriber): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  publish(event: VfsEvent): void {
    this.eventQueue.push(event);

    if (this.batchTimerId === null) {
      this.batchTimerId = setTimeout(() => {
        this._flush();
      }, this.BATCH_INTERVAL_MS);
    }
  }

  private _flush(): void {
    this.batchTimerId = null;

    if (this.eventQueue.length === 0) return;

    const eventsToDispatch = this.eventQueue;
    this.eventQueue = [];

    for (const subscriber of this.subscribers) {
      try {
        subscriber(eventsToDispatch);
      } catch (e) {
        console.error("[VfsEventBus] Error in subscriber callback:", e);
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
    this.eventQueue = [];
  }
}
