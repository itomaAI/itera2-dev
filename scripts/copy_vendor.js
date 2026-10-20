/**
 * scripts/copy_vendor.js
 * Itera OS v2: Vendor Asset Copier
 *
 * Copies static assets (MathJax, Monaco Editor, pdf.js, pdf-lib) from node_modules into public/vendor/
 * and writes public/vendor/manifest.json — the catalog the host serves to guests via
 * MetaOS.vendor.resolve(name) (T-0685). Guests must not guess the host URL; they ask the catalog.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT_DIR = path.join(__dirname, '..');
const PUBLIC_VENDOR_DIR = path.join(ROOT_DIR, 'public/vendor');

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) {
    console.warn(`[Copy Vendor] Warning: Source directory '${src}' does not exist.`);
    return;
  }
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function readVersion(pkg) {
  const file = path.join(ROOT_DIR, 'node_modules', pkg, 'package.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')).version;
}

function copyVendorAssets() {
  console.log('[Copy Vendor] Copying vendor assets to public/vendor/...');

  // 1. MathJax es5
  const mathjaxSrc = path.join(ROOT_DIR, 'node_modules/mathjax/es5');
  const mathjaxDest = path.join(PUBLIC_VENDOR_DIR, 'mathjax');
  copyDirRecursive(mathjaxSrc, mathjaxDest);

  // 2. Monaco Editor min/vs
  const monacoSrc = path.join(ROOT_DIR, 'node_modules/monaco-editor/min/vs');
  const monacoDest = path.join(PUBLIC_VENDOR_DIR, 'monaco/vs');
  copyDirRecursive(monacoSrc, monacoDest);

  // 3. pdf.js（ゲストの PDF の道具が MetaOS.vendor.resolve('pdfjs') で引く。T-0685）
  //    vfs_root には置かない（default_files.ts に畳まれて初期ロードと VFS の容量を食う）。
  //    .mjs は .js に改名する: ミャク楽（firebase.json の規則が拡張子で見る）と同じ名前にして、ゲストの道具を同じ形で配れるようにする。
  const pdfjsSrc = path.join(ROOT_DIR, 'node_modules/pdfjs-dist');
  const pdfjsDest = path.join(PUBLIC_VENDOR_DIR, 'pdfjs');
  if (fs.existsSync(pdfjsSrc)) {
    fs.mkdirSync(pdfjsDest, { recursive: true });
    for (const f of ['build/pdf.min.mjs', 'build/pdf.worker.min.mjs']) {
      fs.copyFileSync(path.join(pdfjsSrc, f), path.join(pdfjsDest, path.basename(f).replace(/\.mjs$/, '.js')));
    }
    copyDirRecursive(path.join(pdfjsSrc, 'cmaps'), path.join(pdfjsDest, 'cmaps'));
    copyDirRecursive(path.join(pdfjsSrc, 'standard_fonts'), path.join(pdfjsDest, 'standard_fonts'));
  } else {
    console.warn(`[Copy Vendor] Warning: Source directory '${pdfjsSrc}' does not exist.`);
  }

  // 4. pdf-lib（保守版 @cantoo/pdf-lib）: ゲストの PDF の道具が「ページを別の PDF に切り出す」ときに引く（T-0687）。
  //    pdf.js は読む・描く専用で PDF を書けないので、書くほうはこれ。ESM 1 本。使うまで降りてこない
  const pdflibSrc = path.join(ROOT_DIR, 'node_modules/@cantoo/pdf-lib/dist/pdf-lib.esm.min.js');
  const pdflibDest = path.join(PUBLIC_VENDOR_DIR, 'pdflib');
  if (fs.existsSync(pdflibSrc)) {
    fs.mkdirSync(pdflibDest, { recursive: true });
    fs.copyFileSync(pdflibSrc, path.join(pdflibDest, 'pdf-lib.esm.min.js'));
  } else {
    console.warn(`[Copy Vendor] Warning: Source file '${pdflibSrc}' does not exist.`);
  }

  // 5. 目録（ホストの VendorCatalog が読む）。入っているものだけ書く — 無いものを書くと「在る」と嘘をつく
  const manifest = {};
  const put = (name, pkg, entry) => {
    const version = readVersion(pkg);
    if (version && fs.existsSync(path.join(PUBLIC_VENDOR_DIR, entry.base))) manifest[name] = { version, ...entry };
  };
  put('mathjax', 'mathjax', { base: 'mathjax/', entry: 'tex-mml-chtml.js' });
  put('monaco', 'monaco-editor', { base: 'monaco/vs/', entry: 'loader.js' });
  put('pdfjs', 'pdfjs-dist', {
    base: 'pdfjs/',
    entry: 'pdf.min.js',
    worker: 'pdf.worker.min.js',
    dirs: ['cmaps/', 'standard_fonts/'],
  });
  put('pdflib', '@cantoo/pdf-lib', { base: 'pdflib/', entry: 'pdf-lib.esm.min.js' });
  fs.writeFileSync(path.join(PUBLIC_VENDOR_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  console.log(`[Copy Vendor] ✅ Vendor assets copied successfully (${Object.keys(manifest).join(', ')}).`);
}

copyVendorAssets();
