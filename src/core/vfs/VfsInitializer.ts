/**
 * src/core/vfs/VfsInitializer.ts
 * Itera OS VFS v2: Boot Initialization and System Reconciliation
 */

import { DEFAULT_FILES } from '../../config/default_files';
import { writeLayerOf } from '../../config/config_layers';
import type { VfsService } from './VfsService';
import type { NodeStore } from './NodeStore';
import type { PathResolver } from './PathResolver';
import { SYSTEM_PRINCIPAL } from './types';
import {
  EMPTY_GUEST_PATHS,
  GUEST_PATHS_FILE,
  configLayersOf,
  normalizeGuestPaths,
  registryLayersOf,
  type GuestPaths,
} from '../sys/GuestPaths';
import { BUILTIN_SYSTEM_AREAS, applyAreaAcls, parseAreaAcl, resolveAreaAcl, type AreaAclEntry } from './areaAcl';

/** `acl.json` の置き場。OS が規定する側なので直書きしてよい。 */
export const AREA_ACL_FILE = 'system/config/acl.json';

/**
 * 配布物の形を決めるファイル（`paths.json` / `acl.json`）をどこから読めたか。
 *   vfs      … VFS のファイル（利用者が書き換えていればそれ）
 *   defaults … 配信物（DEFAULT_FILES）。まだ VFS に無い＝初回起動や更新直後
 *   none     … どちらにも無い。コードの既定（何も知らない形）で動く
 */
export type DistributionFileSource = 'vfs' | 'defaults' | 'none';

export class VfsInitializer {
  private vfs: VfsService;
  private nodeStore: NodeStore;
  private pathResolver: PathResolver;

  constructor(vfs: VfsService, nodeStore: NodeStore, pathResolver: PathResolver) {
    this.vfs = vfs;
    this.nodeStore = nodeStore;
    this.pathResolver = pathResolver;
  }

  /**
   * 直前の initialize() で書けなかった配信ファイル。起動は続けるが、後から見られるように残す（T-0381）。
   * 1 件の OPFS 書き込み失敗（別タブとの競合・サイトデータの消去）で OS が起動しないのをやめた。
   */
  public failures: Array<{ path: string; error: unknown }> = [];

  /**
   * ゲスト空間の場所（`system/config/paths.json`。T-0614）。initialize() が読み、起動の残りはこれを引く。
   * 無ければ `EMPTY_GUEST_PATHS`（何も知らない形）。層の場所はここで固定される。
   */
  public guestPaths: GuestPaths = EMPTY_GUEST_PATHS;
  public guestPathsSource: DistributionFileSource = 'none';
  public areaAclSource: DistributionFileSource = 'none';
  /** `paths.json` / `acl.json` で捨てた値と、その理由。空なら健全 */
  public distributionProblems: string[] = [];

  /**
   * 配布物の形を決める JSON を読む。VFS のファイル → 配信物 → 無し、の順。
   * 「読めない」と「無い」を分ける: 壊れた VFS のファイルは配信物に落とし、理由を problems に残す。
   */
  private async _readDistributionJson(
    path: string,
    problems: string[],
  ): Promise<{ value: unknown; source: DistributionFileSource }> {
    if (this.vfs.exists(SYSTEM_PRINCIPAL, path)) {
      try {
        return { value: JSON.parse(await this.vfs.readFile(SYSTEM_PRINCIPAL, path)), source: 'vfs' };
      } catch (e) {
        problems.push(
          `${path}: unreadable in VFS (${(e as { message?: string } | null)?.message || String(e)}); falling back to the distribution copy`,
        );
      }
    }
    const shipped = (DEFAULT_FILES as Record<string, string>)[path];
    if (typeof shipped === 'string') {
      try {
        return { value: JSON.parse(shipped), source: 'defaults' };
      } catch (e) {
        problems.push(
          `${path}: the distribution copy is not valid JSON (${(e as { message?: string } | null)?.message || String(e)})`,
        );
      }
    }
    return { value: undefined, source: 'none' };
  }

  /** `paths.json` を読んで整える。 */
  private async _readGuestPaths(problems: string[]): Promise<{ paths: GuestPaths; source: DistributionFileSource }> {
    const { value, source } = await this._readDistributionJson(GUEST_PATHS_FILE, problems);
    if (source === 'none') return { paths: EMPTY_GUEST_PATHS, source };
    const normalized = normalizeGuestPaths(value);
    problems.push(...normalized.problems.map((p) => `${GUEST_PATHS_FILE}: ${p}`));
    return { paths: normalized.paths, source };
  }

  /** `acl.json` を読んで並びにする。無い／壊れているときは組み込み（`system/` の守りだけ）。 */
  private async _readAreaAcl(
    problems: string[],
  ): Promise<{ entries: readonly AreaAclEntry[]; source: DistributionFileSource }> {
    const { value, source } = await this._readDistributionJson(AREA_ACL_FILE, problems);
    if (source === 'none') return { entries: BUILTIN_SYSTEM_AREAS, source };
    const parsed = parseAreaAcl(value);
    problems.push(...parsed.problems.map((p) => `${AREA_ACL_FILE}: ${p}`));
    if (parsed.entries.length === 0) {
      problems.push(`${AREA_ACL_FILE}: no usable areas; applying the built-in system areas instead`);
      return { entries: BUILTIN_SYSTEM_AREAS, source };
    }
    return { entries: parsed.entries, source };
  }

  async initialize(): Promise<void> {
    let deployedCount = 0;
    let updatedCount = 0;
    const failures: Array<{ path: string; error: unknown }> = [];
    const problems: string[] = [];
    // ファイルの実体（OPFS）が 1 つでも書けたか。ディレクトリは IndexedDB だけなので数えない。
    let writtenFiles = 0;

    // OSの初回起動判定：'system' ディレクトリが存在するか
    const isFirstBoot = !this.vfs.exists(SYSTEM_PRINCIPAL, 'system');

    // 1. 必須ディレクトリの自己修復（存在しなければシステム権限で再作成）
    // system 領域のみを保護対象とする。ユーザー空間は自由化。
    const requiredDirs = [
      'system',
      'system/apps',
      'system/config',
      'system/core',
      'system/lib',
      'system/vendor',
      'system/registry',
      'system/services',
      'system/themes',
      'system/temp',
      'system/logs',
      'system/upstream', // ★ 追加: 常に最新の公式OSファイルを保持するディレクトリ
      'system/credentials', // ★ 追加: 認証情報の一元管理領域（クラウド同期の対象外）
    ];

    for (const dir of requiredDirs) {
      if (!this.vfs.exists(SYSTEM_PRINCIPAL, dir)) {
        try {
          await this.vfs.mkdir(SYSTEM_PRINCIPAL, dir);
          console.log(`[VfsInitializer] Restored missing directory: ${dir}`);
        } catch (e) {
          // 並行処理などですでに作成されていた場合のエラーは無視
        }
      }
    }

    // 2. ゲスト空間の場所（paths.json）を読む。ConfigManager より前に走るので自前で読む。
    // 配信の前に読むのは「どの層が利用者の書き先か」（配信で上書きしない場所）を知るため。
    // 配信のあとで読み直す（配信で新しくなった値を ACL と起動の残りに使う）。
    const before = await this._readGuestPaths(problems);
    const configLayers = configLayersOf(before.paths);
    /** 利用者が書く層。ここは配信で上書きしない。 */
    const writeLayers = [writeLayerOf(configLayers), writeLayerOf(registryLayersOf(before.paths))];

    // ユーザーの自動アップデート設定を読み取る。層の並びは ConfigManager と同じ（後の層が勝つ）。
    // 配信の層だけ見ると、利用者が自分の層で切った `autoUpdateSystemFiles: false` が効かない。
    let autoUpdate = true;
    for (const dir of configLayers) {
      const path = `${dir}/preferences.json`;
      try {
        if (!this.vfs.exists(SYSTEM_PRINCIPAL, path)) continue;
        const pref = JSON.parse(await this.vfs.readFile(SYSTEM_PRINCIPAL, path));
        if (typeof pref?.autoUpdateSystemFiles === 'boolean') autoUpdate = pref.autoUpdateSystemFiles;
      } catch (e) {
        // 読めない層は飛ばす（安全側＝それまでの値のまま進める）
      }
    }

    for (const [key, content] of Object.entries(DEFAULT_FILES)) {
      const isDir = key.endsWith('/');
      const cleanPath = isDir ? key.slice(0, -1) : key;

      // 1 件ごとに区切る。upstream/ の写しや既定ファイルが 1 つ書けないだけで起動全体を止めない（T-0381）。
      // 失敗は failures に残して次へ進む。致命かどうかはループの後で決める。
      try {
        // ★ 追加: system/upstream/ 配下に「常に最新の公式リリースファイル」を強制展開する
        // これにより、ユーザーやAIがアプリを改造して壊してしまっても、常に最新の公式コード（APIの使い方）を参照できる
        const upstreamPath = `system/upstream/${cleanPath}`;
        if (isDir) {
          if (!this.vfs.exists(SYSTEM_PRINCIPAL, upstreamPath)) {
            await this.vfs.mkdir(SYSTEM_PRINCIPAL, upstreamPath);
          }
        } else {
          let shouldWrite = true;
          if (this.vfs.exists(SYSTEM_PRINCIPAL, upstreamPath)) {
            try {
              // パフォーマンス最適化: 既存ファイルと内容が完全に一致する場合は上書き(イベント発火)をスキップ
              const currentContent = await this.vfs.readFile(SYSTEM_PRINCIPAL, upstreamPath, { bypassFetch: true });
              if (currentContent === content) {
                shouldWrite = false;
              }
            } catch (e) {
              // 読み込みに失敗した場合は安全のため上書きする
            }
          }

          if (shouldWrite) {
            await this.vfs.writeFile(SYSTEM_PRINCIPAL, upstreamPath, content, {
              overwrite: true,
              system: true,
            });
          }
        }

        // 領域の判定
        const isSystemArea = cleanPath.startsWith('system/');
        // 書き先の層（設定・登録簿それぞれの最後の層）だけを強制更新から外す。
        // 利用者が書く場所を配信で上書きすると設定が消えるため。
        // 逆に、書き先でない層は**配信が正**なので毎回上書きする
        // （そうしないと、新しく足した項目が既存の環境へ永久に届かない）。
        // 層が 1 つの配布物では書き先＝system/config・system/registry なので、
        // これまでと同じ「config と registry は上書きしない」になる。
        const isWriteLayer = writeLayers.some((dir) => cleanPath.startsWith(`${dir}/`));

        // 初回起動ではなく、かつシステム領域外のファイル・ディレクトリは展開をスキップ（ユーザーの自由な削除を尊重）
        if (!isFirstBoot && !isSystemArea) {
          continue;
        }

        const id = this.pathResolver.getIdByPath(cleanPath);

        if (id === undefined) {
          // パスが存在しない場合は新規作成
          if (isDir) {
            await this.vfs.mkdir(SYSTEM_PRINCIPAL, cleanPath);
          } else {
            await this.vfs.writeFile(SYSTEM_PRINCIPAL, cleanPath, content, {
              system: isSystemArea,
            });
          }
          deployedCount++;
          if (!isDir) writtenFiles++;
        } else if (id !== null && !isDir) {
          const node = this.nodeStore.getNode(id);

          // system 配下であっても、利用者が書く層は強制上書きから除外する
          const isForceUpdateArea = isSystemArea && !isWriteLayer;

          // autoUpdate が有効、かつ強制アップデート対象のファイル（システムライブラリ等）の場合のみ上書きする
          if (node && node.kind === 'file' && isForceUpdateArea && autoUpdate) {
            await this.vfs.writeFile(SYSTEM_PRINCIPAL, cleanPath, content, {
              overwrite: true,
              system: true,
            });
            updatedCount++;
            writtenFiles++;
          }
        }
      } catch (e) {
        failures.push({ path: cleanPath, error: e });
        console.warn(`[VfsInitializer] Could not reconcile '${cleanPath}'. Continuing with the rest.`, e);
      }
    }

    this.failures = failures;

    if (failures.length > 0) {
      console.warn(
        `[VfsInitializer] ${failures.length} entries could not be written (deployed: ${deployedCount}, updated: ${updatedCount}).`,
        failures.map((f) => f.path),
      );
      // 初回起動でファイルが 1 件も書けていないなら、この先で system/ を読む処理が全部落ちる。
      // ここで止めた方が原因（最初の失敗）が画面に出る。
      if (isFirstBoot && writtenFiles === 0) {
        const first = failures[0];
        const reason = (first.error as { message?: string } | null)?.message || String(first.error);
        throw new Error(`VFS initialization failed: nothing could be written (first: ${first.path}: ${reason})`);
      }
    }

    // 3. 配信のあとで paths.json を読み直す（いま置いた／更新した値で、ACL と起動の残りを決める）
    const after = await this._readGuestPaths(problems);
    this.guestPaths = after.paths;
    this.guestPathsSource = after.source;

    // 4. 領域の ACL（権限）の再帰的適用 —— 並びは acl.json（無ければ組み込みの system/ の守りだけ。T-0614）。
    // 広い領域を先に閉じ、中の開ける場所を後から上塗りする。順序は宣言のとおり。
    const acl = await this._readAreaAcl(problems);
    this.areaAclSource = acl.source;
    const resolved = resolveAreaAcl(acl.entries, this.guestPaths);
    problems.push(...resolved.problems.map((p) => `${AREA_ACL_FILE}: ${p}`));
    await applyAreaAcls(this.vfs, resolved.areas);

    this.distributionProblems = problems;
    if (problems.length > 0) {
      console.warn('[VfsInitializer] Distribution files (paths.json / acl.json) had problems:', problems);
    }
    if (after.source === 'none') {
      console.warn(
        `[VfsInitializer] ${GUEST_PATHS_FILE} is neither in the VFS nor in the distribution. Running with no guest layout (1 config layer, no agent area).`,
      );
    }

    if (deployedCount > 0 || updatedCount > 0) {
      console.log(
        `[VfsInitializer] System reconciliation complete. Deployed: ${deployedCount}, Updated: ${updatedCount}`,
      );
    } else {
      console.log('[VfsInitializer] System is up to date.');
    }
  }
}
