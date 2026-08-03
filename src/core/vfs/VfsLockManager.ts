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
        lockedPath.startsWith(normPath + '/') // 子孫がロックされている場合（例: 中のファイルの書き込み中）
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
    // NOTE: Map に格納する Promise の参照(chained)を保持し、finally 内ではその参照と比較する。
    // nextLock 自体と比較すると、Map に格納されているのは waitPromise.then(() => nextLock) という
    // 別の Promise インスタンスであるため、常に不一致となりエントリが永久に削除されない。
    const chained = waitPromise.then(() => nextLock);
    this.locks.set(normPath, chained);

    try {
      await waitPromise;
      return await task();
    } finally {
      releaseLock();
      // もし自分がキューの最後尾だった場合のみMapから消す
      if (this.locks.get(normPath) === chained) {
        this.locks.delete(normPath);
      }
    }
  }

  /**
   * 複数のパスに対して同時に階層ロックを取得し、タスクを実行する。
   */
  async acquireMultiple<T>(paths: string[], task: () => Promise<T>): Promise<T> {
    const uniquePaths = Array.from(new Set(paths.map((p) => this._normalize(p)))).sort();

    // 祖先が同じリストに含まれるパスを除外する。
    // acquire() は階層ロックのため、祖先を取得すれば子孫も自動的に保護される。
    // これを行わないと、内側の acquire() が「祖先が別のロックを保持中」と誤認し、
    // 自分自身が保持しているロックの解放を永久に待ってしまう自己デッドロックになる。
    // TODO: _normalize('') (VFSルート) は他のどのパスも吸収しない
    // (''.startsWith('/') が false になるため)。将来的にルートパスを含む
    // acquireMultiple 呼び出しがあった場合の挙動は要検証。
    const rootPaths = uniquePaths.filter(
      (p) => !uniquePaths.some((other) => other !== p && p.startsWith(other + '/')),
    );

    const acquireRecursive = async (index: number): Promise<T> => {
      if (index >= rootPaths.length) {
        return await task();
      }
      return this.acquire(rootPaths[index], () => acquireRecursive(index + 1));
    };

    return acquireRecursive(0);
  }

  private _normalize(path: string): string {
    if (!path) return '';
    return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').trim();
  }
}
