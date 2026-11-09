/**
 * scripts/vendor_extra.js
 * 配布物が vendor の目録に足す資源（T-0773）。
 *
 * public/vendor/manifest.json はホストが起動時に読む目録（VendorCatalog）で、ゲストは
 * MetaOS.vendor.resolve(name) で「名前 → 絶対 URL」を引く。copy_vendor.js は同梱の 4 つ（mathjax・monaco・
 * pdfjs・pdflib）を node_modules から写して目録を書くが、配布物（itera2-demo・ミャク楽…）が自分の資源
 * （デモ用のモデルなど。vfs_root に置くと利用者全員の VFS に入る大きさのもの）を同じ目録に足す口が無く、
 * アプリは親の origin を覗いて場所を組み立てていた。それをやめるための口。
 *
 * 配布物はリポジトリの根に vendor.extra.json をコミットする（itera2-dev には置かない）:
 *   { "<名前>": { "version": "1", "src": "<根からの相対ディレクトリ>", "entry"?: "file", "worker"?: "file", "dirs"?: ["sub/"] } }
 * copy_vendor.js がこれを読み、src のディレクトリを public/vendor/<名前>/ に写し、base "<名前>/" で目録に足す。
 * 同梱の名前と重なれば止まる（黙って上書きしない）。src が無ければ止まる（無いものを「在る」と書かない）。
 */

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * vendor.extra.json の中身を検める。形が違えば投げる。
 * @returns {Record<string, {version:string, src:string, entry?:string, worker?:string, dirs?:string[]}>}
 */
export function parseVendorExtra(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('vendor.extra.json must be an object keyed by name.');
  }
  const out = {};
  for (const [name, v] of Object.entries(raw)) {
    if (!NAME_RE.test(name)) throw new Error(`vendor.extra.json: invalid name "${name}" (letters, digits, _ . -).`);
    if (!v || typeof v !== 'object' || Array.isArray(v))
      throw new Error(`vendor.extra.json: "${name}" must be an object.`);
    if (typeof v.version !== 'string' || !v.version) throw new Error(`vendor.extra.json: "${name}" lacks "version".`);
    if (typeof v.src !== 'string' || !v.src || v.src.startsWith('/') || v.src.split(/[\\/]/).includes('..')) {
      throw new Error(`vendor.extra.json: "${name}" has an invalid "src" (relative directory inside the repository).`);
    }
    const e = { version: v.version, src: v.src.replace(/\/+$/, '') };
    for (const k of ['entry', 'worker']) {
      if (v[k] === undefined) continue;
      if (typeof v[k] !== 'string' || !v[k] || v[k].startsWith('/') || v[k].includes('..')) {
        throw new Error(`vendor.extra.json: "${name}" has an invalid "${k}".`);
      }
      e[k] = v[k];
    }
    if (v.dirs !== undefined) {
      if (
        !Array.isArray(v.dirs) ||
        !v.dirs.every((d) => typeof d === 'string' && d && !d.startsWith('/') && !d.includes('..'))
      ) {
        throw new Error(`vendor.extra.json: "${name}" has an invalid "dirs".`);
      }
      e.dirs = v.dirs.map((d) => (d.endsWith('/') ? d : d + '/'));
    }
    out[name] = e;
  }
  return out;
}

/**
 * 配布物の資源を写して目録に足す。
 * @param manifest 同梱分を書き終えた目録（ここに足す）
 * @param extra parseVendorExtra の結果
 * @param io { exists(path):boolean, isDir(path):boolean, copyDir(src,dest):void, join(...parts):string, rootDir, vendorDir }
 * @returns 足した名前の一覧
 */
export function applyVendorExtra(manifest, extra, io) {
  const added = [];
  for (const [name, e] of Object.entries(extra)) {
    if (manifest[name]) {
      throw new Error(`vendor.extra.json: "${name}" is already shipped with the host; pick another name.`);
    }
    const src = io.join(io.rootDir, e.src);
    if (!io.exists(src) || !io.isDir(src)) {
      throw new Error(`vendor.extra.json: "${name}": source directory not found: ${e.src}`);
    }
    for (const f of [e.entry, e.worker].filter(Boolean)) {
      if (!io.exists(io.join(src, f))) throw new Error(`vendor.extra.json: "${name}": file not found in src: ${f}`);
    }
    for (const d of e.dirs || []) {
      if (!io.exists(io.join(src, d)))
        throw new Error(`vendor.extra.json: "${name}": directory not found in src: ${d}`);
    }
    io.copyDir(src, io.join(io.vendorDir, name));
    const entry = { version: e.version, base: name + '/' };
    if (e.entry) entry.entry = e.entry;
    if (e.worker) entry.worker = e.worker;
    if (e.dirs) entry.dirs = e.dirs;
    manifest[name] = entry;
    added.push(name);
  }
  return added;
}
