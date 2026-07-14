/**
 * src/core/vfs/VfsInitializer.ts
 * Itera OS VFS v2: Boot Initialization and System Reconciliation
 */

import { DEFAULT_FILES } from '../../config/default_files';
import type { VfsService } from './VfsService';
import type { NodeStore } from './NodeStore';
import type { PathResolver } from './PathResolver';
import { SYSTEM_PRINCIPAL } from './types';

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
      const id = this.pathResolver.getIdByPath(cleanPath);

      // 領域の判定
      const isSystemArea = cleanPath.startsWith('system/');
      const isConfigArea = cleanPath.startsWith('system/config/') || cleanPath.startsWith('system/registry/');

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
        rules: [{ principal: { type: 'any', id: '*' }, permissions: ['read'] }],
      });
    }

    // 2. ただし以下の領域は Read/Write を許可して上塗りする
    const readWriteAcl: import('./types').AccessControlList = {
      owner: SYSTEM_PRINCIPAL,
      rules: [
        {
          principal: { type: 'any', id: '*' },
          permissions: ['read', 'write'],
        },
      ],
    };

    const rwPaths = ['system/config', 'system/themes', 'system/registry'];

    for (const rwPath of rwPaths) {
      if (this.vfs.exists(SYSTEM_PRINCIPAL, rwPath)) {
        await this.vfs.setAclRecursive(SYSTEM_PRINCIPAL, rwPath, readWriteAcl);
      }
    }

    // 3. memory 領域の権限設定 (AIのみ読み書き可能、User/GuestはRead-Only)
    if (this.vfs.exists(SYSTEM_PRINCIPAL, 'memory')) {
      const memoryAcl: import('./types').AccessControlList = {
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
