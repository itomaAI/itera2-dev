/**
 * src/core/vfs/ContentStore.ts
 * Itera OS VFS v2: Content Storage Manager (OPFS Wrapper)
 */

import type { ContentRef } from './types';

/**
 * 一過性とみなして再試行する OPFS の例外（T-0380）。
 *
 * - InvalidStateError: `createWritable()` は `<key>.crswap` に書いて `close()` で本体と入れ替える。
 *   その間に本体や swap が別の書き手（同じオリジンの別タブ、サイトデータの消去で消えたルート）に
 *   触られると、Chromium はこの名前で失敗する。定型文は
 *   「An operation that depends on state cached in an interface object was made but the state had
 *   changed since it was read from disk.」（実例: 2026-09-07 WB 中村さんの起動エラー）
 * - NoModificationAllowedError: 同じ実体に排他の書き手がいる（別タブ）。
 *
 * どちらも次の瞬間には解けている相手なので、ハンドルを取り直して数回だけやり直す。
 * それ以外（QuotaExceededError・TypeError 等）はやり直しても変わらないので即座に投げる。
 */
export function isTransientOpfsError(e: unknown): boolean {
  const name = (e as { name?: unknown } | null | undefined)?.name;
  return name === 'InvalidStateError' || name === 'NoModificationAllowedError';
}

/** 再試行の間隔（ms）。長さが再試行の回数。合計でも 250ms なので起動を目に見えて遅くしない。 */
export const OPFS_WRITE_RETRY_DELAYS_MS: readonly number[] = [50, 200];

export interface ContentStoreOptions {
  /** 試験用。再試行の間隔を差し替える（`[]` で再試行なし）。 */
  retryDelaysMs?: readonly number[];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ContentStore {
  private useOpfs: boolean = false;
  private rootHandlePromise: Promise<FileSystemDirectoryHandle> | null = null;
  private memoryStore: Map<string, Blob> = new Map();
  private readonly retryDelaysMs: readonly number[];

  constructor(options: ContentStoreOptions = {}) {
    this.retryDelaysMs = options.retryDelaysMs ?? OPFS_WRITE_RETRY_DELAYS_MS;
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.getDirectory) {
      this.useOpfs = true;
      this.rootHandlePromise = navigator.storage.getDirectory();
    } else {
      console.warn(
        '[ContentStore] OPFS is not supported in this environment. Falling back to volatile in-memory storage.',
      );
    }
  }

  async write(key: string, content: string | Uint8Array | Blob): Promise<ContentRef> {
    const backend = this.useOpfs ? 'opfs' : 'memory';

    if (!this.useOpfs) {
      let blob: Blob;
      if (content instanceof Blob) {
        blob = content;
      } else if (content instanceof Uint8Array) {
        blob = new Blob([content as any]);
      } else {
        blob = new Blob([content], { type: 'text/plain' });
      }
      this.memoryStore.set(key, blob);
      return { backend, key };
    }

    let lastError: any;
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
      let writable: FileSystemWritableFileStream | null = null;
      try {
        if (attempt > 0) {
          await sleep(this.retryDelaysMs[attempt - 1]);
          // ルートのハンドルも取り直す。サイトデータの消去でルートごと消えていると、
          // 古いハンドルはどれだけ待っても使えない。
          this.rootHandlePromise = navigator.storage.getDirectory();
        }
        const root = await this.rootHandlePromise!;
        const fileHandle = await root.getFileHandle(key, { create: true });
        writable = await fileHandle.createWritable();

        await writable.write(content as any);
        await writable.close();

        return { backend, key };
      } catch (e: any) {
        lastError = e;
        // 開いたまま捨てると swap ファイルが残る。失敗しても構わない。
        if (writable) {
          try {
            await writable.abort();
          } catch {
            /* noop */
          }
        }
        if (!isTransientOpfsError(e) || attempt === this.retryDelaysMs.length) break;
        console.warn(
          `[ContentStore] Transient OPFS error on ${key} (attempt ${attempt + 1}/${this.retryDelaysMs.length + 1}). Retrying.`,
          e,
        );
      }
    }
    console.error(`[ContentStore] Failed to write file to OPFS: ${key}`, lastError);
    throw new Error(`OPFS Write Error: ${lastError?.message || String(lastError)}`);
  }

  async readText(ref: ContentRef): Promise<string> {
    if (ref.backend === 'memory') {
      const blob = this.memoryStore.get(ref.key);
      if (!blob) throw new Error(`Content not found in memory: ${ref.key}`);
      return await blob.text();
    }

    try {
      const root = await this.rootHandlePromise!;
      const fileHandle = await root.getFileHandle(ref.key);
      const file = await fileHandle.getFile();
      return await file.text();
    } catch (e: any) {
      if (e.name === 'NotFoundError') throw new Error(`Content not found in OPFS: ${ref.key}`);
      throw new Error(`OPFS Read Error: ${e.message || String(e)}`);
    }
  }

  async readBinary(ref: ContentRef): Promise<Uint8Array> {
    const blob = await this.readBlob(ref);
    const arrayBuffer = await blob.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  }

  async readBlob(ref: ContentRef): Promise<Blob> {
    if (ref.backend === 'memory') {
      const blob = this.memoryStore.get(ref.key);
      if (!blob) throw new Error(`Content not found in memory: ${ref.key}`);
      return blob;
    }

    try {
      const root = await this.rootHandlePromise!;
      const fileHandle = await root.getFileHandle(ref.key);
      return await fileHandle.getFile();
    } catch (e: any) {
      if (e.name === 'NotFoundError') throw new Error(`Content not found in OPFS: ${ref.key}`);
      throw new Error(`OPFS Read Error: ${e.message || String(e)}`);
    }
  }

  async delete(ref: ContentRef): Promise<void> {
    if (ref.backend === 'memory') {
      this.memoryStore.delete(ref.key);
      return;
    }

    try {
      const root = await this.rootHandlePromise!;
      await root.removeEntry(ref.key);
    } catch (e: any) {
      if (e.name !== 'NotFoundError') {
        console.warn(`[ContentStore] Failed to delete file in OPFS: ${ref.key}`, e);
        throw new Error(`OPFS Delete Error: ${e.message || String(e)}`);
      }
    }
  }

  async exists(ref: ContentRef): Promise<boolean> {
    if (ref.backend === 'memory') {
      return this.memoryStore.has(ref.key);
    }

    try {
      const root = await this.rootHandlePromise!;
      await root.getFileHandle(ref.key);
      return true;
    } catch (e: any) {
      if (e.name === 'NotFoundError') return false;
      throw e;
    }
  }

  /**
   * OPFS (または Memory) に存在するすべてのファイルキー(UUID)を取得する
   * fsck時の実体突合用
   */
  async getAllKeys(): Promise<string[]> {
    if (!this.useOpfs) {
      return Array.from(this.memoryStore.keys());
    }

    try {
      const root = await this.rootHandlePromise!;
      const keys: string[] = [];

      // @ts-ignore - TSの環境によっては AsyncIterable の定義が不足しているため保護
      for await (const key of (root as any).keys()) {
        keys.push(key);
      }
      return keys;
    } catch (e: any) {
      console.error(`[ContentStore] Failed to list keys in OPFS:`, e);
      throw new Error(`OPFS List Keys Error: ${e.message || String(e)}`);
    }
  }

  /**
   * OPFS (または Memory) に存在するすべてのファイル実体を削除する
   * Factory Reset などの完全初期化用
   */
  async clearAll(): Promise<void> {
    if (!this.useOpfs) {
      this.memoryStore.clear();
      return;
    }

    try {
      const root = await this.rootHandlePromise!;
      // @ts-ignore - TSの環境によっては AsyncIterable の定義が不足しているため保護
      for await (const key of (root as any).keys()) {
        await root.removeEntry(key, { recursive: true });
      }
      console.log(`[ContentStore] All OPFS contents have been successfully cleared.`);
    } catch (e: any) {
      console.error(`[ContentStore] Failed to clear OPFS contents:`, e);
      throw new Error(`OPFS Clear Error: ${e.message || String(e)}`);
    }
  }
}
