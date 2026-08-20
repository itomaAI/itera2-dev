/**
 * src/core/vfs/backupExclusion.ts
 * Itera OS v2: 全体バックアップ（ZIP エクスポート）の除外判定
 *
 * なぜ要るか:
 *   スタブ（同期プロバイダ管理下の未実体化ファイル）を含めたままバックアップすると、
 *   VfsService.readBlob() が既定で実体化を試みるため、
 *     (1) 取得できた分だけ VFS の容量を食う（ここは元々の懸念）
 *     (2) 取得できなかった分は「エラー文を本文に持つ本物のファイル」として ZIP に入る
 *   (2) のほうが厄介で、復元すると実データがあるべき場所に偽の本文が実在することになる。
 *   そこへ同期プロバイダが再接続すると、実機側へ押し返す経路が生まれる。
 *
 * 方針（2026-08-20 決定）:
 *   - ルート以外のマウント配下は、実体の有無によらず含めない（プロバイダに委ねる）
 *   - マウント表に出てこないスタブも含めない
 *   - 除外した内容は ZIP 直下のマニフェストに記録し、復元した人が理由を追えるようにする
 *
 * 2 番目の条件は飾りではない。マウント表は「いま登録されているか」で揺れる:
 * 接続の切れたブリッジのルートは表に載らない一方、その配下のスタブは VFS に残る。
 * 実際 2026-08-20 時点で、不通の実機のスタブ 2,376 件（62.5GB）が
 * マウント表に載らないまま存在していた。1 番目だけでは、これを取りに行ってしまう。
 */

export const BACKUP_MANIFEST_FILENAME = '__itera_backup__.json';
export const BACKUP_MANIFEST_FORMAT = 'itera-backup-manifest/1';

/** 除外の内訳を集計するときの粒度（パスの先頭から何階層でまとめるか） */
const STUB_PREFIX_DEPTH = 3;
/** マニフェストに載せる内訳の最大件数（大きさが際限なく増えないように） */
const STUB_PREFIX_LIMIT = 50;

export type BackupExclusionReason = 'trash' | 'mount' | 'stub';

export interface BackupCandidate {
  path: string;
  syncState?: string;
}

export interface BackupExclusionVerdict {
  excluded: boolean;
  reason: BackupExclusionReason | null;
  mountPath?: string;
}

export interface MountLike {
  mountPath: string;
  pid?: string;
}

/**
 * マウント表から「除外に使うマウントパス」を取り出す。
 *
 * ルートマウント('')は必ず落とす。落とすと決めているのは、
 * ルートに載るプロバイダ（Drive 同期など）を除外すると VFS 全体が消え、
 * バックアップが空になるからである。
 *
 * 長いものを先に見るために降順で返す（最長一致）。
 */
export function normalizeMountPaths(mounts: MountLike[] | null | undefined): string[] {
  if (!mounts) return [];
  const set = new Set<string>();
  for (const m of mounts) {
    const raw = m && typeof m.mountPath === 'string' ? m.mountPath : '';
    const p = raw.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!p) continue;
    set.add(p);
  }
  return Array.from(set).sort((a, b) => b.length - a.length);
}

/**
 * path がどのマウント配下かを返す（マウント地点そのものを含む）。
 * 前方一致の紛れ（'local/ws' が 'local/ws_evil' を巻き込む）を避けるため、
 * 一致は「完全一致」か「マウントパス + '/'」に限る。
 */
export function findExcludingMount(path: string, mountPaths: string[]): string | null {
  for (const mountPath of mountPaths) {
    if (path === mountPath || path.startsWith(mountPath + '/')) return mountPath;
  }
  return null;
}

/** 1 ファイルをバックアップに含めるかどうかを決める。判定はこの関数だけが持つ。 */
export function classifyForBackup(candidate: BackupCandidate, mountPaths: string[]): BackupExclusionVerdict {
  const path = (candidate.path || '').replace(/^\/+/, '');

  // 従来からの挙動。ごみ箱はバックアップに含めない。
  if (path.startsWith('trash/')) return { excluded: true, reason: 'trash' };

  const mountPath = findExcludingMount(path, mountPaths);
  if (mountPath !== null) return { excluded: true, reason: 'mount', mountPath };

  if (candidate.syncState === 'stub') return { excluded: true, reason: 'stub' };

  return { excluded: false, reason: null };
}

interface Bucket {
  files: number;
  bytes: number;
}

export interface BackupManifest {
  format: string;
  createdAt: string;
  policy: string;
  excludedMounts: Array<{ mountPath: string; pid: string | null; files: number; bytes: number }>;
  excludedStubsOutsideMounts: {
    files: number;
    bytes: number;
    byPrefix: Array<{ prefix: string; files: number; bytes: number }>;
  };
  totals: { includedFiles: number; includedBytes: number; excludedFiles: number; excludedBytes: number };
}

/**
 * 除外の内訳を数え、マニフェストに整える。
 *
 * ごみ箱は数えない。これは今回の方針で新たに外すものではなく、
 * 元からバックアップの対象外だったためである（数えると理由が混ざって読めなくなる）。
 */
export class BackupExclusionRecorder {
  private mountPids = new Map<string, string | null>();
  private mountBuckets = new Map<string, Bucket>();
  private stubByPrefix = new Map<string, Bucket>();
  private stubTotal: Bucket = { files: 0, bytes: 0 };
  private included: Bucket = { files: 0, bytes: 0 };

  constructor(mounts: MountLike[] | null | undefined) {
    for (const mountPath of normalizeMountPaths(mounts)) {
      const found = (mounts || []).find((m) => normalizeMountPaths([m])[0] === mountPath);
      this.mountPids.set(mountPath, found && found.pid ? found.pid : null);
      this.mountBuckets.set(mountPath, { files: 0, bytes: 0 });
    }
  }

  recordIncluded(bytes: number): void {
    this.included.files += 1;
    this.included.bytes += bytes || 0;
  }

  recordExcluded(path: string, bytes: number, verdict: BackupExclusionVerdict): void {
    if (verdict.reason === 'mount' && verdict.mountPath) {
      const bucket = this.mountBuckets.get(verdict.mountPath) || { files: 0, bytes: 0 };
      bucket.files += 1;
      bucket.bytes += bytes || 0;
      this.mountBuckets.set(verdict.mountPath, bucket);
      return;
    }
    if (verdict.reason === 'stub') {
      this.stubTotal.files += 1;
      this.stubTotal.bytes += bytes || 0;
      const prefix = (path || '').replace(/^\/+/, '').split('/').slice(0, STUB_PREFIX_DEPTH).join('/');
      const bucket = this.stubByPrefix.get(prefix) || { files: 0, bytes: 0 };
      bucket.files += 1;
      bucket.bytes += bytes || 0;
      this.stubByPrefix.set(prefix, bucket);
    }
    // 'trash' は数えない（元から対象外のため）
  }

  toManifest(now: Date = new Date()): BackupManifest {
    const excludedMounts = Array.from(this.mountBuckets.entries())
      .map(([mountPath, bucket]) => ({
        mountPath,
        pid: this.mountPids.get(mountPath) ?? null,
        files: bucket.files,
        bytes: bucket.bytes,
      }))
      .sort((a, b) => a.mountPath.localeCompare(b.mountPath));

    const byPrefix = Array.from(this.stubByPrefix.entries())
      .map(([prefix, bucket]) => ({ prefix, files: bucket.files, bytes: bucket.bytes }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, STUB_PREFIX_LIMIT);

    const excludedFiles = excludedMounts.reduce((n, m) => n + m.files, 0) + this.stubTotal.files;
    const excludedBytes = excludedMounts.reduce((n, m) => n + m.bytes, 0) + this.stubTotal.bytes;

    return {
      format: BACKUP_MANIFEST_FORMAT,
      createdAt: now.toISOString(),
      policy:
        '同期プロバイダが管理する領域（ルートマウントを除く）と、マウント表に載らないスタブは、' +
        'このバックアップに含めていない。実体は各プロバイダの同期元にあり、再接続すれば復元される。',
      excludedMounts,
      excludedStubsOutsideMounts: { files: this.stubTotal.files, bytes: this.stubTotal.bytes, byPrefix },
      totals: {
        includedFiles: this.included.files,
        includedBytes: this.included.bytes,
        excludedFiles,
        excludedBytes,
      },
    };
  }
}
