/**
 * src/core/vfs/VfsLockManager.ts
 * Itera OS v2: VFS Hierarchical Asynchronous Mutex
 */

export class VfsLockManager {
  private locks: Map<string, Promise<void>> = new Map();

  /**
   * 単一のパスに対して「階層的な」排他ロックを取得し、タスクを実行する。
   * 自分自身だけでなく、祖先（親ディレクトリ）や子孫（配下のファイル）のロックも待機する。
   */
  async acquire<T>(path: string, task: () => Promise<T>): Promise<T> {
    const normPath = this._normalize(path);

    // 関連するすべてのロック（自身、祖先、子孫）を収集する
    const relatedLocks: Promise<void>[] = [];
    for (const [lockedPath, lockPromise] of this.locks.entries()) {
      if (
        lockedPath === normPath || 
        normPath.startsWith(lockedPath + '/') || // 祖先がロックされている場合（例: 親フォルダの削除中）
        lockedPath.startsWith(normPath + '/')    // 子孫がロックされている場合（例: 中のファイルの書き込み中）
      ) {
        relatedLocks.push(lockPromise.catch(() => {}));
      }
    }

    // すべての関連タスクが終わるのを待つ Promise
    const waitPromise = relatedLocks.length > 0 ? Promise.all(relatedLocks) : Promise.resolve();

    let releaseLock!: () => void;
    const nextLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    // 自分のロックを登録
    this.locks.set(normPath, waitPromise.then(() => nextLock));

    try {
      await waitPromise;
      return await task();
    } finally {
      releaseLock();
      // もし自分がキューの最後尾だった場合のみMapから消す
      if (this.locks.get(normPath) === nextLock) {
        this.locks.delete(normPath);
      }
    }
  }

  /**
   * 複数のパスに対して同時に階層ロックを取得し、タスクを実行する。
   */
  async acquireMultiple<T>(paths: string[], task: () => Promise<T>): Promise<T> {
    const uniquePaths = Array.from(new Set(paths.map((p) => this._normalize(p)))).sort();

    const acquireRecursive = async (index: number): Promise<T> => {
      if (index >= uniquePaths.length) {
        return await task();
      }
      return this.acquire(uniquePaths[index], () => acquireRecursive(index + 1));
    };

    return acquireRecursive(0);
  }

  private _normalize(path: string): string {
    if (!path) return '';
    return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').trim();
  }
}
