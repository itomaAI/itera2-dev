/**
 * src/core/vfs/NodeStore.ts
 * Itera OS VFS v2: Metadata Storage Manager (IndexedDB + In-Memory Cache)
 */

import type { VfsNode } from "./types";

export class NodeStore {
  private dbName = "itera_vfs_v2";
  private storeName = "nodes";

  private memoryMap: Map<string, VfsNode> = new Map();
  private dbPromise: Promise<IDBDatabase>;

  constructor() {
    this.dbPromise = this._initDB();
  }

  private _initDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);

      request.onerror = (e) => {
        console.error(
          "[NodeStore] IndexedDB Open Error:",
          (e.target as any).error,
        );
        reject((e.target as any).error);
      };

      request.onupgradeneeded = (e) => {
        const db = (e.target as any).result as IDBDatabase;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: "id" });
        }
      };

      request.onsuccess = (e) => {
        resolve((e.target as any).result as IDBDatabase);
      };
    });
  }

  private async _tx(
    mode: IDBTransactionMode,
    callback: (store: IDBObjectStore) => IDBRequest,
  ): Promise<any> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([this.storeName], mode);
      const store = transaction.objectStore(this.storeName);

      let request: IDBRequest;
      try {
        request = callback(store);
      } catch (err) {
        return reject(err);
      }

      request.onsuccess = (e) => resolve((e.target as any).result);
      request.onerror = (e) => reject((e.target as any).error);
    });
  }

  async loadAll(): Promise<void> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([this.storeName], "readonly");
      const store = transaction.objectStore(this.storeName);
      const request = store.getAll();

      request.onsuccess = (e) => {
        const nodes = (e.target as any).result as VfsNode[];
        this.memoryMap.clear();
        for (const node of nodes) {
          this.memoryMap.set(node.id, node);
        }
        console.log(
          `[NodeStore] Boot complete. Loaded ${this.memoryMap.size} metadata nodes into memory.`,
        );
        resolve();
      };

      request.onerror = (e) => {
        console.error(
          "[NodeStore] Failed to load metadata:",
          (e.target as any).error,
        );
        reject((e.target as any).error);
      };
    });
  }

  getNode(id: string): VfsNode | undefined {
    return this.memoryMap.get(id);
  }

  getAllNodes(): IterableIterator<VfsNode> {
    return this.memoryMap.values();
  }

  async putNode(node: VfsNode): Promise<void> {
    this.memoryMap.set(node.id, node);

    try {
      await this._tx("readwrite", (store) => store.put(node));
    } catch (e) {
      console.error(
        `[NodeStore] Failed to persist node ${node.id} to IndexedDB. Memory state might be out of sync.`,
        e,
      );
      throw e;
    }
  }

  async deleteNode(id: string): Promise<void> {
    this.memoryMap.delete(id);

    try {
      await this._tx("readwrite", (store) => store.delete(id));
    } catch (e) {
      console.error(
        `[NodeStore] Failed to delete node ${id} from IndexedDB. Memory state might be out of sync.`,
        e,
      );
      throw e;
    }
  }

  async clearAll(): Promise<void> {
    this.memoryMap.clear();
    await this._tx("readwrite", (store) => store.clear());
    console.log("[NodeStore] All metadata cleared.");
  }

  /**
   * 現在のインデックス（メタデータ）をJSON文字列としてエクスポートする
   */
  exportIndex(): string {
    const nodes = Array.from(this.memoryMap.values());
    return JSON.stringify(nodes); // 容量が小さいためインデントなしで圧縮
  }

  /**
   * JSON文字列からインデックス（メタデータ）をインポートし、DBを上書きする
   */
  async importIndex(jsonStr: string): Promise<void> {
    try {
      const nodes: VfsNode[] = JSON.parse(jsonStr);
      if (!Array.isArray(nodes)) {
        throw new Error("Invalid index format: expected an array of nodes.");
      }

      // 既存のデータを全クリア
      await this.clearAll();

      // トランザクションを使って安全かつ一気に挿入する
      const db = await this.dbPromise;
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction([this.storeName], "readwrite");
        const store = transaction.objectStore(this.storeName);

        transaction.oncomplete = () => {
          // データベースへの挿入が成功したら、メモリ上のマップも更新する
          for (const node of nodes) {
            this.memoryMap.set(node.id, node);
          }
          console.log(
            `[NodeStore] Successfully imported ${nodes.length} nodes from backup.`,
          );
          resolve();
        };

        transaction.onerror = (e) => reject((e.target as any).error);

        // すべてのノードをputする（一括コミットされる）
        for (const node of nodes) {
          store.put(node);
        }
      });
    } catch (e) {
      console.error(`[NodeStore] Failed to import index:`, e);
      throw e;
    }
  }
}
