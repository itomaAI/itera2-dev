/**
 * src/core/sys/FileAssociationResolver.ts
 * Itera OS v2: File to App Association Resolver
 */

import type { AppRegistry } from './AppRegistry';
import type { VfsStat } from '../vfs/types';
import type { VfsService } from '../vfs/VfsService';
import type { VfsEventBus } from '../vfs/VfsEventBus';
import { SYSTEM_PRINCIPAL } from '../vfs/types';

export interface ResolvedApp {
  /** 起動すべきアプリのID。Host内蔵機能を使用する場合は特殊なIDを返す */
  appId: string | 'HostEditor' | 'HostMediaViewer' | 'HostRunner' | 'HostExplorer';
  /** Guestアプリの場合、そのエントリーポイントとなるHTMLパス */
  appPath?: string;
  /** アプリの表示名（UIメニュー用） */
  appName: string;
}

export class FileAssociationResolver {
  private vfs: VfsService;
  private appRegistry: AppRegistry;
  private associations: any = { extensions: {}, mimeTypes: {} };

  constructor(vfs: VfsService, appRegistry: AppRegistry, eventBus: VfsEventBus) {
    this.vfs = vfs;
    this.appRegistry = appRegistry;

    eventBus.subscribe((events) => {
      const isUpdated = events.some((e) => e.path === 'system/registry/associations.json');
      if (isUpdated) {
        this.loadAssociations();
      }
    });
  }

  async loadAssociations(): Promise<void> {
    try {
      if (this.vfs.exists(SYSTEM_PRINCIPAL, 'system/registry/associations.json')) {
        const content = await this.vfs.readFile(SYSTEM_PRINCIPAL, 'system/registry/associations.json');
        this.associations = JSON.parse(content);
      }
    } catch (e) {
      console.warn('[FileAssociationResolver] Failed to load associations.json', e);
      this.associations = { extensions: {}, mimeTypes: {} };
    }
  }

  /**
   * ファイル情報から、起動すべきデフォルトのアプリを解決する。
   */
  resolveDefault(stat: VfsStat): ResolvedApp {
    // ディレクトリは名前で関連付けを引かない。ホストのエクスプローラパネルが受け皿
    // （PDF などの Media Viewer と同じ位置づけの、ホスト側フォールバック）。
    if (stat.kind === 'directory') {
      return { appId: 'HostExplorer', appName: 'Explorer (Host)' };
    }
    const extension = this._getExtension(stat.name);
    const mimeType = stat.mimeType || this._guessMimeType(stat.name);

    // 1. ユーザーの明示的な設定 (associations.json) をチェック
    const userPreferredAppId = this.associations?.extensions?.[extension] || this.associations?.mimeTypes?.[mimeType];

    if (userPreferredAppId) {
      const app = this.appRegistry.getApp(userPreferredAppId);
      if (app) {
        return { appId: app.id, appPath: app.path, appName: app.name };
      }
    }

    // 2. アプリが宣言している fileHandlers を検索
    const allApps = this.appRegistry.getAllApps();
    for (const app of allApps) {
      if (app.fileHandlers) {
        for (const handler of app.fileHandlers) {
          if (handler.extensions?.includes(extension) || handler.mimeTypes?.includes(mimeType)) {
            return { appId: app.id, appPath: app.path, appName: app.name };
          }
        }
      }
    }

    // 3. どのGuestアプリも対応していない場合は、HostのフォールバックUIへ
    if (extension === 'html') {
      return { appId: 'HostRunner', appName: 'Executable (Run)' };
    } else if (this._isBinary(stat.name, mimeType)) {
      return { appId: 'HostMediaViewer', appName: 'Media Viewer (Host)' };
    } else {
      return { appId: 'HostEditor', appName: 'Code Editor (Host)' };
    }
  }

  /**
   * 「このプログラムで開く...」のメニュー用に、対応可能なすべてのアプリのリストを返す。
   */
  resolveAllAvailable(stat: VfsStat): ResolvedApp[] {
    if (stat.kind === 'directory') {
      return [{ appId: 'HostExplorer', appName: 'Explorer (Host)' }];
    }
    const extension = this._getExtension(stat.name);
    const mimeType = stat.mimeType || this._guessMimeType(stat.name);
    const available: ResolvedApp[] = [];

    // 対応しているGuestアプリを収集
    const allApps = this.appRegistry.getAllApps();
    for (const app of allApps) {
      if (app.fileHandlers) {
        const canHandle = app.fileHandlers.some(
          (h) => h.extensions?.includes(extension) || h.mimeTypes?.includes(mimeType),
        );
        if (canHandle) {
          available.push({
            appId: app.id,
            appPath: app.path,
            appName: app.name,
          });
        }
      }
    }

    // Hostフォールバックは常に末尾に提供する
    if (extension === 'html') {
      available.push({ appId: 'HostRunner', appName: 'Executable (Run)' });
    }
    if (this._isBinary(stat.name, mimeType)) {
      available.push({
        appId: 'HostMediaViewer',
        appName: 'Media Viewer (Host)',
      });
    } else {
      available.push({ appId: 'HostEditor', appName: 'Code Editor (Host)' });
    }

    return available;
  }

  // --- Helpers ---

  private _getExtension(filename: string): string {
    const parts = filename.split('.');
    return parts.length > 1 ? parts.pop()!.toLowerCase() : '';
  }

  private _guessMimeType(filename: string): string {
    const ext = this._getExtension(filename);
    const map: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      svg: 'image/svg+xml',
      pdf: 'application/pdf',
      zip: 'application/zip',
      json: 'application/json',
      md: 'text/markdown',
      txt: 'text/plain',
      html: 'text/html',
      css: 'text/css',
      js: 'application/javascript',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
      xls: 'application/vnd.ms-excel',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      doc: 'application/msword',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ppt: 'application/vnd.ms-powerpoint',
    };
    return map[ext] || 'application/octet-stream';
  }

  /**
   * 名前と MIME からバイナリと分かるもの（メニューと既定の解決。中身は読まない）。
   * ここに無いものはエディタ側で先頭のバイト列を見て決める（`textDetect.ts`・T-0389）ので、一覧は目安でよい。
   */
  private _isBinary(filename: string, mimeType: string): boolean {
    if (
      mimeType.startsWith('image/') ||
      mimeType.startsWith('audio/') ||
      mimeType.startsWith('video/') ||
      mimeType.startsWith('font/') ||
      mimeType === 'application/pdf' ||
      mimeType === 'application/zip' ||
      // Office の MIME は前方一致で（`application/vnd.` 全体は取らない —— Windows は csv に vnd.ms-excel を付けることがある）
      mimeType.startsWith('application/vnd.openxmlformats-officedocument.') ||
      mimeType.startsWith('application/vnd.ms-excel.sheet') ||
      mimeType === 'application/msword'
    )
      return true;
    const ext = this._getExtension(filename);
    return [
      'png',
      'jpg',
      'jpeg',
      'gif',
      'webp',
      'svg',
      'ico',
      'bmp',
      'pdf',
      'zip',
      '7z',
      'rar',
      'gz',
      'tgz',
      'bz2',
      'xz',
      'jar',
      'xlsx',
      'xlsm',
      'xls',
      'docx',
      'doc',
      'pptx',
      'ppt',
      'mp3',
      'mp4',
      'wav',
      'ogg',
      'm4a',
      'webm',
      'mov',
      'avi',
      'woff',
      'woff2',
      'ttf',
      'otf',
      'exe',
      'dll',
      'wasm',
      'sqlite',
      'db',
      'bin',
    ].includes(ext);
  }
}
