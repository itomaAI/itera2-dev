/**
 * scripts/build_defaults.js
 * Itera OS v2: Default Files Builder
 * 
 * vfs_root/ ディレクトリをスキャンし、src/config/default_files.ts を自動生成します。
 * 空フォルダはキーの末尾を '/' とすることで表現します。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SOURCE_DIR = path.join(__dirname, '../vfs_root');
const OUTPUT_FILE = path.join(__dirname, '../src/config/default_files.ts');

const IGNORE_DIRS = ['.git', '__pycache__', '.trash', '.sample'];
const IGNORE_FILES = ['.DS_Store'];

function escapeTemplateLiteral(text) {
  // バッククォートやエスケープシーケンス、テンプレートリテラルを安全にエスケープする
  return text
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

function buildDefaultFiles() {
  if (!fs.existsSync(SOURCE_DIR)) {
    console.log(`\n[Build Defaults] Notice: '${SOURCE_DIR}' not found.`);
    console.log(`Please create it and organize your folders (apps/, config/, data/, docs/, system/).\n`);
    // フォルダがない場合は作っておく
    fs.mkdirSync(SOURCE_DIR, { recursive: true });
  }

  const entries = [];
  let fileCount = 0;
  let emptyDirCount = 0;

  function walk(dir, relPath = '') {
    let items = fs.readdirSync(dir);
    items = items.filter(item => !IGNORE_DIRS.includes(item) && !IGNORE_FILES.includes(item));

    // 空ディレクトリの場合はキー末尾に '/' を付けて値は空文字にする
    if (items.length === 0) {
      if (relPath) {
        entries.push(`  "${relPath}/": ""`);
        emptyDirCount++;
      }
      return;
    }

    for (const item of items) {
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);
      const entryRelPath = relPath ? `${relPath}/${item}` : item;

      if (stat.isDirectory()) {
        walk(fullPath, entryRelPath);
      } else {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          // JSONはフォーマットして出力、それ以外はテンプレートリテラルで出力
          if (item.endsWith('.json')) {
            const jsonObj = JSON.parse(content);
            const jsonStr = JSON.stringify(jsonObj, null, 2);
            entries.push(`  "${entryRelPath}": JSON.stringify(${jsonStr}, null, 2)`);
          } else {
            const escaped = escapeTemplateLiteral(content);
            entries.push(`  "${entryRelPath}": \`\n${escaped}\`.trim()`);
          }
          fileCount++;
        } catch (e) {
          console.warn(`[Build Defaults] Skipping non-text/invalid file: ${fullPath}`);
        }
      }
    }
  }

  walk(SOURCE_DIR);

  const now = new Date().toISOString();
  const buildTime = Date.now();
  const entriesStr = entries.join(',\n\n');

  const tsCode = `/**
 * AUTO-GENERATED FILE - DO NOT EDIT MANUALLY
 * Generated on: ${now}
 */

export const DEFAULT_FILES: Record<string, string> = {
${entriesStr}
};

export const BUILD_TIME = ${buildTime};
`;

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, tsCode, 'utf-8');

  console.log(`[Build Defaults] ✅ Generated default_files.ts (${fileCount} files, ${emptyDirCount} empty dirs).`);
}

buildDefaultFiles();