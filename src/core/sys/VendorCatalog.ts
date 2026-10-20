/**
 * src/core/sys/VendorCatalog.ts
 * Itera OS v2: Vendor Catalog — ホストが同梱する vendor ライブラリ（pdf.js・MathJax・Monaco）の目録（T-0685）
 *
 * なぜ要るか:
 *   大きなライブラリは vfs_root に置けない（default_files.ts に畳まれて初期ロードと VFS の容量を食う）ので
 *   public/vendor/ に置く。ゲストはホストの配置（Pages の /itera2-dev/ の下か、/agent/ の下か）を知らないし
 *   知ってはいけない（window.top.location を覗くのは配線の漏れ）。だからホストが目録を持ち、名前で引かせる。
 *
 * 目録 public/vendor/manifest.json は scripts/copy_vendor.js が書く。ここでは読んで URL に解くだけ。
 * 無い名前は「この配信物には入っていない」と断る（null や空に潰さない）。
 */

export interface VendorEntry {
  /** ライブラリの版（node_modules の package.json から） */
  version: string;
  /** vendor/ からの相対ディレクトリ。末尾に / */
  base: string;
  /** 入口のファイル名（base からの相対）。無いライブラリもある */
  entry?: string;
  /** Web Worker のファイル名（base からの相対）。pdf.js など */
  worker?: string;
  /** 付属のディレクトリ（cmaps/ など。base からの相対） */
  dirs?: string[];
}

export type VendorManifest = Record<string, VendorEntry>;

/** ゲストに返す形。URL はすべて絶対 */
export interface VendorResolution {
  name: string;
  version: string;
  /** ライブラリのディレクトリ（末尾に /）。付属のファイルはこれに相対名を足す */
  url: string;
  entry?: string;
  worker?: string;
  dirs?: string[];
}

function ensureTrailingSlash(s: string): string {
  return s.endsWith('/') ? s : s + '/';
}

/** manifest.json の中身を検査する。形が違えば投げる（壊れた目録を「無い」と読まないため） */
export function parseVendorManifest(raw: unknown): VendorManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Vendor manifest must be an object keyed by library name.');
  }
  const out: VendorManifest = {};
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      throw new Error(`Vendor manifest entry "${name}" must be an object.`);
    }
    const e = v as Record<string, unknown>;
    if (typeof e.version !== 'string' || !e.version) {
      throw new Error(`Vendor manifest entry "${name}" lacks "version".`);
    }
    if (typeof e.base !== 'string' || !e.base || e.base.startsWith('/') || e.base.includes('..')) {
      throw new Error(`Vendor manifest entry "${name}" has an invalid "base" (relative directory under vendor/).`);
    }
    const entry: VendorEntry = { version: e.version, base: ensureTrailingSlash(e.base) };
    if (e.entry !== undefined) {
      if (typeof e.entry !== 'string' || !e.entry)
        throw new Error(`Vendor manifest entry "${name}" has an invalid "entry".`);
      entry.entry = e.entry;
    }
    if (e.worker !== undefined) {
      if (typeof e.worker !== 'string' || !e.worker)
        throw new Error(`Vendor manifest entry "${name}" has an invalid "worker".`);
      entry.worker = e.worker;
    }
    if (e.dirs !== undefined) {
      if (!Array.isArray(e.dirs) || !e.dirs.every((d) => typeof d === 'string' && d))
        throw new Error(`Vendor manifest entry "${name}" has an invalid "dirs".`);
      entry.dirs = e.dirs.map(ensureTrailingSlash);
    }
    out[name] = entry;
  }
  return out;
}

/**
 * 目録の 1 件を絶対 URL に解く。vendorHref は vendor/ ディレクトリの絶対 URL（末尾に /）。
 * 無い名前は、入っている名前を添えて断る。
 */
export function resolveVendor(manifest: VendorManifest, name: string, vendorHref: string): VendorResolution {
  const e = manifest[name];
  if (!e) {
    const available = Object.keys(manifest).sort();
    throw new Error(
      `Vendor library "${name}" is not included in this build. Available: ${available.length ? available.join(', ') : '(none)'}`,
    );
  }
  const url = new URL(e.base, ensureTrailingSlash(vendorHref)).href;
  const r: VendorResolution = { name, version: e.version, url };
  if (e.entry) r.entry = new URL(e.entry, url).href;
  if (e.worker) r.worker = new URL(e.worker, url).href;
  if (e.dirs) r.dirs = e.dirs.map((d) => new URL(d, url).href);
  return r;
}

/** vite の BASE_URL（'./' や '/itera2-dev/'）と文書の baseURI から vendor/ の絶対 URL を作る */
export function vendorHrefOf(baseUrl: string, documentBaseURI: string): string {
  return new URL(ensureTrailingSlash(baseUrl || './') + 'vendor/', documentBaseURI).href;
}

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * 目録を 1 度だけ取って持つ。取れなかったときは次の呼び出しでもう一度取りに行く
 * （失敗を「空の目録」として覚えると、配信直後の一瞬の 404 が恒久的な「無い」に化ける）。
 */
export class VendorCatalog {
  private readonly vendorHref: string;
  private readonly fetchImpl: FetchLike;
  private manifestPromise: Promise<VendorManifest> | null = null;

  constructor(vendorHref: string, fetchImpl?: FetchLike) {
    this.vendorHref = ensureTrailingSlash(vendorHref);
    this.fetchImpl = fetchImpl ?? ((url: string) => fetch(url));
  }

  async manifest(): Promise<VendorManifest> {
    if (!this.manifestPromise) {
      const url = this.vendorHref + 'manifest.json';
      this.manifestPromise = (async () => {
        const res = await this.fetchImpl(url);
        if (!res.ok) throw new Error(`Vendor manifest could not be loaded (${res.status}): ${url}`);
        return parseVendorManifest(await res.json());
      })();
      this.manifestPromise.catch(() => {
        this.manifestPromise = null;
      });
    }
    return this.manifestPromise;
  }

  async resolve(name: string): Promise<VendorResolution> {
    if (typeof name !== 'string' || !name) throw new Error('Vendor library name is required.');
    return resolveVendor(await this.manifest(), name, this.vendorHref);
  }

  async list(): Promise<string[]> {
    return Object.keys(await this.manifest()).sort();
  }
}
