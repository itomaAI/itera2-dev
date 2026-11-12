/**
 * src/shell/windowing/guestCompilerTestKit.ts
 * GuestCompiler の試験が共有する小さな道具（最小の VFS・出力の読み方）。試験からだけ import する。
 */
import type { GuestAsset } from './GuestCompiler';
import type { VfsService } from '../../core/vfs/VfsService';

export type Entry = { kind: 'file' | 'directory'; text?: string; mimeType?: string };

/** 最小の VFS。文字列か text を持つものがファイル。readBlob は型の無い Blob を返す（OPFS の File と同じ） */
export function vfsOf(entries: Record<string, Entry | string>): VfsService {
  const norm = (e: Entry | string): Entry => (typeof e === 'string' ? { kind: 'file', text: e } : e);
  const get = (path: string) => (Object.prototype.hasOwnProperty.call(entries, path) ? norm(entries[path]) : undefined);
  return {
    exists: (_p: unknown, path: string) => get(path) !== undefined,
    stat: (_p: unknown, path: string) => ({ kind: get(path)!.kind, updatedAt: 1, mimeType: get(path)!.mimeType }),
    readFile: async (_p: unknown, path: string) => get(path)!.text ?? '',
    readBlob: async (_p: unknown, path: string) => new Blob([get(path)!.text ?? '']),
  } as unknown as VfsService;
}

export const page = (body: string, head = '') => `<html><head>${head}</head><body>${body}</body></html>`;

/** 資源の目印そのもの（`#hash` を含まない） */
export const MARKER = /__ITERA_ASSET_[a-z0-9]+_\d+__/g;

export const textOf = (a: GuestAsset) => (a.kind === 'text' ? a.text : '');

/** パスで資源を引く（同じパスが 2 つ在るときは kind で選ぶ）。無ければ試験を落とす */
export function assetOf(assets: GuestAsset[], path: string, kind?: GuestAsset['kind']): GuestAsset {
  const found = assets.filter((a) => a.path === path && (!kind || a.kind === kind));
  if (found.length !== 1) {
    throw new Error(`expected exactly one asset for ${path}${kind ? ` (${kind})` : ''}, got ${found.length}`);
  }
  return found[0];
}

export const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

export interface ImportMapJson {
  imports: Record<string, string>;
  [key: string]: unknown;
}

/** 文書の import map（`<script type="importmap">`）。無ければ null。2 枚以上なら試験を落とす */
export function importMapOf(html: string): ImportMapJson | null {
  const els = Array.from(parse(html).querySelectorAll('script[type="importmap"]'));
  if (els.length === 0) return null;
  if (els.length > 1) throw new Error(`expected at most one import map, got ${els.length}`);
  return JSON.parse(els[0].textContent || '') as ImportMapJson;
}

/** text の資源が含む目印は、すべて自分より前に並ぶ資源のもの（ゲストは前から順に URL を作る） */
export function markersPrecede(assets: GuestAsset[]): boolean {
  const seen = new Set<string>();
  for (const a of assets) {
    for (const m of textOf(a).match(MARKER) ?? []) if (!seen.has(m)) return false;
    seen.add(a.id);
  }
  return true;
}
