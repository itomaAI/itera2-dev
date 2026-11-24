/**
 * src/core/sys/PrivilegeTable.ts
 * 配信物の特権の表（T-0904）: system の主体で動いてよいファイルの一覧。
 *
 * 置き場は `system/services/privileged.json`（デーモン本体の隣・readonly の領域）:
 *
 *   { "systemPrivilege": ["system/services/<name>.html"] }
 *
 * 特権は「何のファイルか」で決まる。そのプロセスのファイルが、この表に載っていること ——
 * 表も、載っているファイルも、配信物（`core/vfs/distribution.ts`）であること。
 * 登録簿（`system/registry/`・利用者の層）に書かれた `systemPrivilege` は読まない。
 * 登録簿は利用者・AI・アプリが書く場所で、信頼の宣言を置く場所ではない。
 */
import { isDistributionFile, type DistributionVfs } from '../vfs/distribution';
import { SYSTEM_PRINCIPAL, type Principal } from '../vfs/types';

export const PRIVILEGE_TABLE_PATH = 'system/services/privileged.json';

export interface PrivilegeTableVfs extends DistributionVfs {
  readFile(principal: Principal, path: string): Promise<string>;
}

/** 表の変更を知る口（VfsEventBus が満たす） */
export interface PrivilegeTableEvents {
  subscribe(callback: (mutations: Array<{ path: string }>) => void): unknown;
}

export class PrivilegeTable {
  private vfs: PrivilegeTableVfs;
  private paths: ReadonlySet<string> = new Set();

  constructor(vfs: PrivilegeTableVfs, events?: PrivilegeTableEvents | null) {
    this.vfs = vfs;
    events?.subscribe((mutations) => {
      if (mutations.some((m) => m.path === PRIVILEGE_TABLE_PATH)) void this.load();
    });
  }

  /** 表を読む。無い・壊れているときは、誰にも特権を与えない（表が配信物であることは grants が毎回見る） */
  async load(): Promise<void> {
    const next = new Set<string>();
    try {
      if (this.vfs.exists(SYSTEM_PRINCIPAL, PRIVILEGE_TABLE_PATH)) {
        const parsed = JSON.parse(await this.vfs.readFile(SYSTEM_PRINCIPAL, PRIVILEGE_TABLE_PATH));
        const list =
          parsed && typeof parsed === 'object' ? (parsed as { systemPrivilege?: unknown }).systemPrivilege : null;
        if (Array.isArray(list)) {
          for (const entry of list) {
            if (typeof entry === 'string' && entry.trim()) next.add(entry.trim().replace(/^\/+|\/+$/g, ''));
          }
        }
      }
    } catch (e) {
      console.warn(`[PrivilegeTable] Failed to read ${PRIVILEGE_TABLE_PATH}. No process gets the system privilege.`, e);
    }
    this.paths = next;
  }

  /**
   * このファイルで動くプロセスに system の主体を与えるか。
   * 表に載っていて、表とそのファイルの両方がいま配信物であること（ACL は毎回見る）。
   */
  grants(path: string): boolean {
    const clean = String(path ?? '').replace(/^\/+|\/+$/g, '');
    if (!clean || !this.paths.has(clean)) return false;
    return isDistributionFile(this.vfs, PRIVILEGE_TABLE_PATH) && isDistributionFile(this.vfs, clean);
  }
}
