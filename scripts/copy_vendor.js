/**
 * scripts/copy_vendor.js
 * Itera OS v2: Vendor Asset Copier
 *
 * Copies static assets (MathJax, Monaco Editor) from node_modules into public/vendor/
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

  console.log('[Copy Vendor] ✅ Vendor assets copied successfully.');
}

copyVendorAssets();