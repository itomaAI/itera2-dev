/**
 * src/core/vfs/VfsInitializer.ts
 * Itera OS VFS v2: Boot Initialization and System Reconciliation
 */

import { DEFAULT_FILES } from '../../config/default_files';
import type { VfsService } from './VfsService';
import type { NodeStore } from './NodeStore';
import type { PathResolver } from './PathResolver';
import { SYSTEM_PRINCIPAL, type AccessControlList } from './types';

export class VfsInitializer {
  private vfs: VfsService;
  private nodeStore: NodeStore;
  private pathResolver: PathResolver;

  constructor(vfs: VfsService, nodeStore: NodeStore, pathResolver: PathResolver) {
    this.vfs = vfs;
    this.nodeStore = nodeStore;
    this.pathResolver = pathResolver;
  }

  async initialize(): Promise<void> {
    let deployedCount = 0;
    let updatedCount = 0;

    // OSの初回起動判定：'system' ディレクトリが存在するか
    const isFirstBoot = !this.vfs.exists(SYSTEM_PRINCIPAL, 'system');

    // 1. 必須ディレクトリの自己修復（存在しなければシステム権限で再作成）
    // system 領域のみを保護対象とする。ユーザー空間は自由化。
    const requiredDirs = [
      'system',
      'system/apps',
      'system/config',
      'system/core',
      'system/registry',
      'system/services',
      'system/themes',
      'system/temp',
      'system/logs',
      'system/upstream', // ★ 追加: 常に最新の公式OSファイルを保持するディレクトリ
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

    // ユーザーの自動アップデート設定を読み取る
    let autoUpdate = true;
    try {
      if (this.vfs.exists(SYSTEM_PRINCIPAL, 'system/config/preferences.json')) {
        const prefContent = await this.vfs.readFile(SYSTEM_PRINCIPAL, 'system/config/preferences.json');
        const pref = JSON.parse(prefContent);
        if (pref.autoUpdateSystemFiles === false) {
          autoUpdate = false;
        }
      }
    } catch (e) {
      // 読み込みに失敗した場合は安全のためデフォルト(true)のまま進める
    }

    for (const [key, content] of Object.entries(DEFAULT_FILES)) {
      const isDir = key.endsWith('/');
      const cleanPath = isDir ? key.slice(0, -1) : key;

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
      const isConfigArea = cleanPath.startsWith('system/config/') || cleanPath.startsWith('system/registry/');

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
      } else if (id !== null && !isDir) {
        const node = this.nodeStore.getNode(id);

        // system配下であっても、configやregistryはユーザーデータ/動的データなので強制上書きから除外する
        const isForceUpdateArea = isSystemArea && !isConfigArea;

        // autoUpdate が有効、かつ強制アップデート対象のファイル（システムライブラリ等）の場合のみ上書きする
        if (node && node.kind === 'file' && isForceUpdateArea && autoUpdate) {
          await this.vfs.writeFile(SYSTEM_PRINCIPAL, cleanPath, content, {
            overwrite: true,
            system: true,
          });
          updatedCount++;
        }
      }
    }

    // --- 厳密な ACL（権限）の再帰的適用 ---
    // 1. system/ 領域は原則 Read-Only (AIやGuestアプリからの破壊を防止)
    if (this.vfs.exists(SYSTEM_PRINCIPAL, 'system')) {
      await this.vfs.setAclRecursive(SYSTEM_PRINCIPAL, 'system', {
        owner: SYSTEM_PRINCIPAL,
        rules: [
          { principal: { type: 'user', id: 'local_user' }, permissions: ['read'] },
          { principal: { type: 'agent', id: 'Itera_AI' }, permissions: ['read'] },
          { principal: { type: 'any', id: '*' }, permissions: ['read'] },
        ],
      });
    }

    // 2. ただし以下の領域は Read/Write を許可して上塗りする
    const readWriteAcl: AccessControlList = {
      owner: SYSTEM_PRINCIPAL,
      rules: [
        { principal: { type: 'user', id: 'local_user' }, permissions: ['read', 'write', 'manage'] },
        { principal: { type: 'agent', id: 'Itera_AI' }, permissions: ['read', 'write'] },
        { principal: { type: 'any', id: '*' }, permissions: ['read', 'write'] },
      ],
    };

    const rwPaths = [
      'system/config',
      'system/themes',
      'system/registry',
      'system/temp',
      'system/upstream', // ★ 追加: 再起動で元に戻るため、一時的な書き換えや実験を許可する
    ];

    for (const rwPath of rwPaths) {
      if (this.vfs.exists(SYSTEM_PRINCIPAL, rwPath)) {
        await this.vfs.setAclRecursive(SYSTEM_PRINCIPAL, rwPath, readWriteAcl);
      }
    }

    // 3. memory 領域の権限設定 (AIのみ読み書き可能、User/GuestはRead-Only)
    if (this.vfs.exists(SYSTEM_PRINCIPAL, 'memory')) {
      const memoryAcl: AccessControlList = {
        owner: { type: 'agent', id: 'Itera_AI' },
        rules: [
          {
            principal: { type: 'agent', id: 'Itera_AI' },
            permissions: ['read', 'write', 'manage'],
          },
          {
            principal: { type: 'any', id: '*' },
            permissions: ['read'],
          },
        ],
      };
      await this.vfs.setAclRecursive(SYSTEM_PRINCIPAL, 'memory', memoryAcl);
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
