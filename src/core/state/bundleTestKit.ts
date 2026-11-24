/**
 * src/core/state/bundleTestKit.ts
 * 会話の出し入れの試験で使う、小さな VFS の偽物（T-0908）。試験だけが読む。
 *
 * 中身は文字列で持つ。誰の主体で読み書き・削除したかを残す（置き場は OS、保存先は頼んだ者、を見るため）。
 * ディレクトリは「その下にファイルが在ること」で在る。
 */

import { SYSTEM_PRINCIPAL, type Principal } from '../vfs/types';

/* eslint-disable @typescript-eslint/no-explicit-any */
export class FakeVfs {
  files = new Map<string, string>();
  writes: Array<{ by: string; path: string; system: boolean }> = [];
  reads: Array<{ by: string; path: string }> = [];
  deletes: Array<{ by: string; path: string; permanent: boolean }> = [];
  failOn = new Set<string>();
  private isDir(path: string) {
    return [...this.files.keys()].some((k) => k.startsWith(`${path}/`));
  }
  exists(_p: Principal, path: string) {
    return this.files.has(path) || this.isDir(path);
  }
  stat(_p: Principal, path: string): any {
    if (this.files.has(path)) {
      return { kind: 'file', name: path.slice(path.lastIndexOf('/') + 1), path, hash: `h:${this.files.get(path)}` };
    }
    if (this.isDir(path)) return { kind: 'directory', name: path.slice(path.lastIndexOf('/') + 1), path };
    throw new Error(`File not found: ${path}`);
  }
  listFiles(_p: Principal, options: { path: string }): any[] {
    const prefix = `${options.path}/`;
    const names = new Set<string>();
    for (const k of this.files.keys()) if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split('/')[0]);
    return [...names].sort().map((n) => this.stat(SYSTEM_PRINCIPAL, `${prefix}${n}`));
  }
  async readFile(p: Principal, path: string) {
    this.reads.push({ by: `${p.type}:${p.id}`, path });
    if (!this.files.has(path)) throw new Error(`File not found: ${path}`);
    return this.files.get(path)!;
  }
  async readBlob(p: Principal, path: string) {
    if (this.failOn.has(path)) throw new Error('unreadable');
    return new Blob([await this.readFile(p, path)]);
  }
  async writeFile(p: Principal, path: string, content: string | Blob, options: { system?: boolean }) {
    this.writes.push({ by: `${p.type}:${p.id}`, path, system: options.system === true });
    this.files.set(path, typeof content === 'string' ? content : await content.text());
  }
  async deleteFile(p: Principal, path: string, options: { permanent?: boolean } = {}) {
    this.deletes.push({ by: `${p.type}:${p.id}`, path, permanent: options.permanent === true });
    for (const k of [...this.files.keys()]) if (k === path || k.startsWith(`${path}/`)) this.files.delete(k);
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
