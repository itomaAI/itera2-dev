/**
 * src/core/vfs/ContentStore.ts
 * Itera OS VFS v2: Content Storage Manager (OPFS Wrapper)
 *
 * 中身は不変・名前が動く（T-0791）。
 * 1 つの鍵（OPFS のファイル名）には 1 度しか書かない。ノードを書き直すときは新しい鍵
 * （{@link contentKey}: `<nodeId>@<version>`）へ書き、ノードの `contentRef` を差し替えたあとで古い鍵を捨てる。
 * 同じ名前に上書きしないのは、OPFS の `getFile()` で得た File（ゲストへ渡した handle）が
 * その名前への上書き・削除・差し替えのどれでも読めなくなるから（Chromium NotReadableError／Firefox AbortError。
 * 実測 2026-11-10）。生き残るのは「別の鍵に書いて古い実体を残す」だけ。
 *
 * 渡した handle は 1 つずつ数える: {@link ContentStore.readBlob} に `holder` を付けるたび、その保持者の
 * その鍵の数が 1 増え、{@link ContentStore.delete} は保持中の鍵を消さずに孤児として覚える。
 * 保持が減るのは 2 通り —— 保持者が handle を 1 つ手放した（{@link ContentStore.releaseOne}。ゲストが object URL を
 * revoke した。T-0798）か、保持者の寿命が尽きた（{@link ContentStore.release}。プロセスの kill）。
 * 保持者が居なくなった孤児は、そこで物理的に消す。クラッシュ等で漏れた孤児は起動時の fsck（VfsFsck）が片付ける。
 *
 * ホスト自身の読みも同じ規則に乗る（T-0795）: 展開する読み（{@link ContentStore.withBlob}・`readText`・`readBinary`）は
 * 読み終わるまで一時の保持者として鍵を持つ。書き手が途中で古い鍵を delete しても、読みは古い版を最後まで読める。
 */

import type { ContentRef } from './types';

/** 鍵の中で nodeId と版を分ける印。nodeId（`generateId`）には含まれない */
const KEY_VERSION_SEPARATOR = '@';

/** ノードの中身の鍵。版ごとに別の鍵なので、同じ名前への上書きは起きない */
export function contentKey(nodeId: string, version: number): string {
  return `${nodeId}${KEY_VERSION_SEPARATOR}${version}`;
}

/**
 * 鍵を nodeId と版に分ける。版の無い鍵（T-0791 より前の形。鍵 ＝ nodeId）は `version: null`。
 * fsck が「この鍵はどのノードの、何版か」を知るための口。
 */
export function parseContentKey(key: string): { nodeId: string; version: number | null } {
  const at = key.lastIndexOf(KEY_VERSION_SEPARATOR);
  if (at < 0) return { nodeId: key, version: null };
  const version = Number(key.slice(at + 1));
  if (!Number.isInteger(version)) return { nodeId: key, version: null };
  return { nodeId: key.slice(0, at), version };
}

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
 *
 * T-0791 で同じ鍵への上書きは無くなったが、この再試行は残す。別のタブは同じノードの同じ版を
 * 見ているので同じ鍵へ同時に書きうるし、サイトデータの消去でルートが消える件は鍵の形と無関係である。
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

export interface ReadBlobOptions {
  /**
   * 返した Blob（OPFS の File handle）を持ち続ける者。プロセスの pid。
   * 付けると、その鍵はこの保持者が手放す（{@link ContentStore.releaseOne}／{@link ContentStore.release}）まで
   * 物理的に消されない。呼ぶたびに 1 つ数える。
   * 読んですぐ展開する（`arrayBuffer()`／`text()`）だけなら付けない。
   */
  holder?: string;
}

/** 鍵を保持する者。プロセスの pid（文字列）か、1 回の読み（{@link ContentStore.withBlob} が作る symbol） */
type Holder = string | symbol;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ContentStore {
  private useOpfs: boolean = false;
  private rootHandlePromise: Promise<FileSystemDirectoryHandle> | null = null;
  private memoryStore: Map<string, Blob> = new Map();
  private readonly retryDelaysMs: readonly number[];

  /**
   * 鍵 → 保持者ごとの、渡した handle の数。{@link readBlob} の `holder` で 1 増え、
   * {@link releaseOne} で 1 減り、{@link release} でその保持者のぶんが全部消える
   */
  private readonly holders = new Map<string, Map<Holder, number>>();
  /** どのノードからも参照されなくなったが、保持者が居るので消していない鍵（`delete` が後回しにしたもの） */
  private readonly orphans = new Map<string, ContentRef>();

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

  /**
   * 鍵に書く。鍵は呼ぶ側が {@link contentKey} で作る（ノードの id と版）。
   * 1 つの鍵には 1 度しか書かない前提 —— 既に在る鍵へ書くと、その handle を持つゲストの資産が読めなくなる。
   */
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
    return this.withBlob(ref, (blob) => blob.text());
  }

  async readBinary(ref: ContentRef): Promise<Uint8Array> {
    return this.withBlob(ref, async (blob) => new Uint8Array(await blob.arrayBuffer()));
  }

  /**
   * 中身を読んで使う（展開する）間、鍵を保持する。`use` が終わるまで（成功でも失敗でも）、
   * この鍵は {@link delete} されても物理的には消えない。終わったら手放し、孤児になっていればそこで消す。
   *
   * 呼び出しから保持までに await は無い。呼ぶ側がノードから `contentRef` を取ったのと同じ同期区間で呼べば、
   * 書き手の「新しい鍵へ書く → ノードを差し替える → 古い鍵を delete」がどこに割り込んでも、読みは古い版を読み切る。
   * Blob を `use` の外へ持ち出さないこと（持ち続けるなら {@link readBlob} に `holder` を付ける）。
   */
  async withBlob<T>(ref: ContentRef, use: (blob: Blob) => Promise<T>): Promise<T> {
    const reader = Symbol('reader');
    this.retain(ref.key, reader);
    try {
      return await use(await this.open(ref));
    } finally {
      await this.unretain(ref.key, reader);
    }
  }

  /**
   * 実体を Blob（OPFS では File handle）のまま返す。中身は読まない。
   * `opts.holder` を付けると、返す前にその鍵を保持者に結び付ける（返したあとに付けると、その間に delete が通りうる）。
   * 渡せなかった（読めなかった）ときは、この呼び出しで数えた 1 つを戻す —— 保持の数は「渡した handle」の数と同じ。
   */
  async readBlob(ref: ContentRef, opts: ReadBlobOptions = {}): Promise<Blob> {
    const holder = opts.holder;
    if (holder !== undefined) this.retain(ref.key, holder);
    try {
      return await this.open(ref);
    } catch (e) {
      // 戻すのはこの呼び出しのぶんだけ。前に渡した handle のぶんは残る
      if (holder !== undefined) await this.unretain(ref.key, holder);
      throw e;
    }
  }

  /** 鍵の実体を開く。保持は見ない */
  private async open(ref: ContentRef): Promise<Blob> {
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

  /** 保持者がこの鍵の handle を 1 つ持った。保持者が居る鍵は {@link delete} されても物理的には消えない */
  retain(key: string, holder: Holder): void {
    let counts = this.holders.get(key);
    if (!counts) {
      counts = new Map();
      this.holders.set(key, counts);
    }
    counts.set(holder, (counts.get(holder) ?? 0) + 1);
  }

  /**
   * 保持者のこの鍵の数を 1 減らす（`all` なら全部。同期）。その鍵に保持者が居なくなり、孤児として残してあったなら、
   * 物理的に消すべきものとして返す（孤児の台帳からは外してある）。持っていなければ何もしない。
   */
  private drop(key: string, holder: Holder, all = false): ContentRef | null {
    const counts = this.holders.get(key);
    const held = counts?.get(holder);
    if (!counts || !held) return null;
    if (all || held <= 1) counts.delete(holder);
    else counts.set(holder, held - 1);
    if (counts.size > 0) return null;
    this.holders.delete(key);
    const orphan = this.orphans.get(key);
    if (!orphan) return null;
    this.orphans.delete(key);
    return orphan;
  }

  /** 保持者の居なくなった孤児を物理的に消す。消せなくても次の fsck が拾うので、孤児には戻さない */
  private async removeFreed(refs: ContentRef[]): Promise<void> {
    for (const ref of refs) {
      try {
        await this.remove(ref);
      } catch (e) {
        console.warn(`[ContentStore] Failed to remove released content: ${ref.key}`, e);
      }
    }
  }

  /** 保持者のこの鍵の数を 1 減らし、保持者の居ない孤児になっていれば消す */
  private async unretain(key: string, holder: Holder): Promise<void> {
    const freed = this.drop(key, holder);
    if (freed) await this.removeFreed([freed]);
  }

  /**
   * 保持者が handle を 1 つ手放した（ゲストがその object URL を revoke した。T-0798）。
   * その保持者のその鍵の数を 1 減らす。同じ鍵の handle を他にも持っていれば（起動時の資産など）、鍵は保持されたまま。
   * 持っていない鍵を言われても何もしない（他の保持者のぶんには触れない）。
   */
  async releaseOne(holder: string, key: string): Promise<void> {
    await this.unretain(key, holder);
  }

  /** 保持者が持っている鍵（試験・診断用） */
  heldKeys(holder: string): string[] {
    const keys: string[] = [];
    for (const [key, counts] of this.holders) if (counts.has(holder)) keys.push(key);
    return keys;
  }

  /** ノードから参照されなくなったのに、保持者が居るので残している鍵（試験・診断用） */
  orphanKeys(): string[] {
    return Array.from(this.orphans.keys());
  }

  /**
   * 保持者の寿命が尽きた（プロセスの kill）。その保持者を全部の鍵から外し、
   * 保持者が居なくなった孤児を物理的に消す。消せなかった鍵は孤児のまま残し、次の fsck に任せる。
   */
  async release(holder: string): Promise<void> {
    const freed: ContentRef[] = [];
    for (const key of Array.from(this.holders.keys())) {
      const orphan = this.drop(key, holder, true);
      if (orphan) freed.push(orphan);
    }
    await this.removeFreed(freed);
  }

  /**
   * この鍵はどのノードからも参照されなくなった。
   * 誰も handle を持っていなければ即消す。持っていれば孤児として覚え、最後の保持者の {@link release} で消す。
   */
  async delete(ref: ContentRef): Promise<void> {
    const set = this.holders.get(ref.key);
    if (set && set.size > 0) {
      this.orphans.set(ref.key, ref);
      return;
    }
    this.orphans.delete(ref.key);
    await this.remove(ref);
  }

  /** 物理的に消す。保持者を見ない */
  private async remove(ref: ContentRef): Promise<void> {
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
   * OPFS (または Memory) に存在するすべてのファイルキーを取得する
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
    this.holders.clear();
    this.orphans.clear();
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
