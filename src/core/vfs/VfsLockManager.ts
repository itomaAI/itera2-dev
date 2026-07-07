/**
 * src/core/vfs/VfsLockManager.ts
 * Itera OS v2: VFS Path-based Asynchronous Mutex
 */

export class VfsLockManager {
  // パスごとの現在実行中（または待機中）のキューの末尾を保持する
  private locks: Map<string, Promise<void>> = new Map();

  /**
   * 単一のパスに対して排他ロックを取得し、タスクを実行する。
   * 同じパスに対して複数のタスクが投げられた場合、順番に実行される（キューイングされる）。
   *
   * @param path 対象のファイルまたはディレクトリのパス
   * @param task ロック取得後に実行する非同期処理
   * @returns タスクの実行結果
   */
  async acquire<T>(path: string, task: () => Promise<T>): Promise<T> {
    const normPath = this._normalize(path);

    // そのパスの現在のキューの最後尾（Promise）を取得。誰も使っていなければ即解決するPromise
    const currentLock = this.locks.get(normPath) || Promise.resolve();

    // 次のタスクのための新しいロック（完了通知用）を作成
    let releaseLock!: () => void;
    const nextLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    // 自分自身のロックをキューの最後尾として登録する
    // (catchを挟むのは、前のタスクがエラーでコケてもキュー自体は進ませるため)
    this.locks.set(
      normPath,
      currentLock.catch(() => {}).then(() => nextLock),
    );

    try {
      // 前のタスクが終わるまで待機
      await currentLock;
      // 自分のタスクを実行
      return await task();
    } finally {
      // 自分のタスクが正常終了でもエラーでも、必ずロックを解放して次の人に順番を回す
      releaseLock();

      // もし自分がキューの最後尾だった場合、メモリリークを防ぐためにMapからエントリを消す
      if (this.locks.get(normPath) === nextLock) {
        this.locks.delete(normPath);
      }
    }
  }

  /**
   * 複数のパスに対して同時に排他ロックを取得し、タスクを実行する。
   * (コピーや移動操作など、2つ以上のパスに跨る変更用)
   *
   * @param paths 対象となるパスの配列
   * @param task ロック取得後に実行する非同期処理
   * @returns タスクの実行結果
   */
  async acquireMultiple<T>(
    paths: string[],
    task: () => Promise<T>,
  ): Promise<T> {
    // デッドロック回避の最重要ロジック:
    // A→B の移動と、B→A の移動が同時に起きた時にお互いが永遠に待ち合うのを防ぐため、
    // 重複を排除した上で、必ず「アルファベット順にパスをソート」してから順番にロックを取得する。
    const uniquePaths = Array.from(
      new Set(paths.map((p) => this._normalize(p))),
    ).sort();

    // ソートされたパスを再帰的に順番にロックしていく
    const acquireRecursive = async (index: number): Promise<T> => {
      // 全てのパスのロックを取得できたら、本来のタスクを実行する
      if (index >= uniquePaths.length) {
        return await task();
      }
      return this.acquire(uniquePaths[index], () =>
        acquireRecursive(index + 1),
      );
    };

    return acquireRecursive(0);
  }

  /**
   * パスの正規化（ロック判定の揺れを防ぐため）
   */
  private _normalize(path: string): string {
    if (!path) return "";
    return path.replace(/\\/g, "/").replace(/\/+/g, "/").trim();
  }
}
