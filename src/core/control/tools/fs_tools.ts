/**
 * src/core/control/tools/fs_tools.ts
 * Itera OS v2: File System Tools
 */

import type { ToolRegistry } from '../ToolRegistry';
import type { VfsService } from '../../vfs/VfsService';
import { AGENT_PRINCIPAL } from '../../vfs/types';

export function registerFSTools(registry: ToolRegistry): void {
  const setId = 'system:fs';
  const setName = 'System: File Operations';

  registry.registerSystemTool(setId, setName, {
    name: 'read_file',
    description: 'Reads file content.',
    impl: async (params: any, context: { vfs: VfsService }) => {
      const vfs = context.vfs;
      if (!vfs.exists(AGENT_PRINCIPAL, params.path)) throw new Error(`File not found.`);

      const stat = vfs.stat(AGENT_PRINCIPAL, params.path);

      const BINARY_EXTS =
        /\.(png|jpg|jpeg|gif|webp|svg|ico|bmp|pdf|zip|tar|gz|7z|rar|mp3|wav|mp4|webm|ogg|wasm|bin|exe|dll|so|dylib|class|jar)$/i;
      let isBinary = !!params.path.match(BINARY_EXTS);

      let content = '';
      if (!isBinary) {
        content = await vfs.readFile(AGENT_PRINCIPAL, params.path);
        // テキストとして読み込んだ結果、Nullバイトが含まれていればバイナリとみなす
        if (content.indexOf('\0') !== -1) {
          isBinary = true;
        }
      }

      if (isBinary) {
        let mimeType = stat.mimeType || 'application/octet-stream';
        const ext = params.path.split('.').pop()?.toLowerCase();

        if (ext === 'pdf') mimeType = 'application/pdf';
        else if (ext === 'png') mimeType = 'image/png';
        else if (ext === 'jpg' || ext === 'jpeg') mimeType = 'image/jpeg';
        else if (ext === 'gif') mimeType = 'image/gif';
        else if (ext === 'webp') mimeType = 'image/webp';
        else if (ext === 'svg') mimeType = 'image/svg+xml';
        else if (ext === 'mp3') mimeType = 'audio/mpeg';
        else if (ext === 'wav') mimeType = 'audio/wav';
        else if (ext === 'mp4') mimeType = 'video/mp4';
        else if (ext === 'webm') mimeType = 'video/webm';
        else if (ext === 'ogg') mimeType = 'audio/ogg';
        else if (ext === 'zip') mimeType = 'application/zip';
        else if (ext === 'wasm') mimeType = 'application/wasm';

        return {
          log: `Read binary file: ${mimeType}`,
          ui: `📦 Read Binary ${params.path}`,
          media: {
            path: params.path,
            mimeType: mimeType,
            metadata: {},
          },
        };
      }

      const lines = content.split(/\r?\n/);

      const s = parseInt(params.start, 10);
      const e = parseInt(params.end, 10);

      const hasStart = !isNaN(s);
      const hasEnd = !isNaN(e);

      let startIdx = 0;
      let endIdx = lines.length;

      if (hasStart) {
        if (s < 0) {
          startIdx = Math.max(0, lines.length + s);
        } else if (s > 0) {
          startIdx = Math.max(0, s - 1);
        } else {
          startIdx = 0;
        }
      }

      if (hasEnd) {
        if (e < 0) {
          endIdx = Math.max(0, Math.min(lines.length, lines.length + e + 1));
        } else if (e > 0) {
          endIdx = Math.min(lines.length, e);
        } else {
          endIdx = 0;
        }
      } else if (!hasStart) {
        // デフォルト: 開始/終了の指定が両方ない場合は、コンテキスト溢れ防止のため先頭800行に制限
        endIdx = Math.min(lines.length, 800);
      }

      const sliced = lines.slice(startIdx, endIdx);
      const showNum = params.line_numbers === 'true';

      // startIdx を基準にすることで、負のインデックス指定時でも元のファイル内の正しい行番号を算出
      const contentStr = showNum ? sliced.map((l, i) => `${startIdx + i + 1} | ${l}`).join('\n') : sliced.join('\n');

      let logMsg = `Lines ${startIdx + 1}-${endIdx} of ${lines.length}:\n${contentStr}`;

      if (endIdx < lines.length) {
        logMsg += `\n\n... (File truncated. ${lines.length - endIdx} more lines. Use start=${endIdx + 1} to read more)`;
      }

      return { log: logMsg, ui: `📖 Read ${params.path}` };
    },
  });

  registry.registerSystemTool(setId, setName, {
    name: 'create_file',
    description: 'Creates a new file.',
    impl: async (params: any, context: { vfs: VfsService }) => {
      const isOverwrite = params.overwrite === 'true';
      if (!isOverwrite && context.vfs.exists(AGENT_PRINCIPAL, params.path)) {
        throw new Error(
          `File already exists at ${params.path}. Set overwrite="true" if you intend to completely overwrite it, or use <edit_file> to modify it.`,
        );
      }

      let content = params.content || '';
      content = content.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
      const msg = await context.vfs.writeFile(AGENT_PRINCIPAL, params.path, content, { overwrite: isOverwrite });

      return {
        log: msg,
        ui: `📝 ${isOverwrite ? 'Overwrote' : 'Created'} ${params.path}`,
      };
    },
  });

  registry.registerSystemTool(setId, setName, {
    name: 'edit_file',
    description: 'Edits a file via search replace or line mode.',
    impl: async (params: any, context: { vfs: VfsService }) => {
      const vfs = context.vfs;
      const content = params.content || '';

      // 行ベースの編集モード
      if (params.mode) {
        if (!vfs.exists(AGENT_PRINCIPAL, params.path)) throw new Error(`File not found: ${params.path}`);
        const fileContent = await vfs.readFile(AGENT_PRINCIPAL, params.path);
        let lines = fileContent.split(/\r?\n/);

        let insertLines: string[] = [];
        if (content) {
          let clean = content;
          if (clean.startsWith('\n')) clean = clean.substring(1);
          if (clean.endsWith('\n')) clean = clean.substring(0, clean.length - 1);
          insertLines = clean.split(/\r?\n/);
        }

        const sLine = parseInt(params.start, 10);
        const sIdx = Math.max(0, sLine - 1);
        const eLine = parseInt(params.end, 10);
        let log = '';

        if (params.mode === 'replace') {
          if (isNaN(eLine)) throw new Error('End line required for replace.');
          const count = Math.max(0, eLine - sLine + 1);
          while (lines.length < sIdx) lines.push('');
          lines.splice(sIdx, count, ...insertLines);
          log = `Replaced lines ${sLine}-${eLine}`;
        } else if (params.mode === 'insert') {
          while (lines.length < sIdx) lines.push('');
          lines.splice(sIdx, 0, ...insertLines);
          log = `Inserted at line ${sLine}`;
        } else if (params.mode === 'delete') {
          if (isNaN(eLine)) throw new Error('End line required for delete.');
          const count = Math.max(0, eLine - sLine + 1);
          lines.splice(sIdx, count);
          log = `Deleted lines ${sLine}-${eLine}`;
        } else if (params.mode === 'append') {
          lines.push(...insertLines);
          log = `Appended to end of file`;
        } else {
          throw new Error(`Unknown mode: ${params.mode}`);
        }

        await vfs.writeFile(AGENT_PRINCIPAL, params.path, lines.join('\n'), {
          overwrite: true,
        });
        return { log, ui: `✏️ Edited ${params.path} (${params.mode})` };
      }

      // SEARCH ブロック編集モード
      if (/<{4,}SEARCH/.test(content)) {
        const blocks: { patternStr: string; replaceStr: string }[] = [];
        const startRegex = /^(<{4,})SEARCH[^\r\n]*$/gm;
        let startMatch;

        while ((startMatch = startRegex.exec(content)) !== null) {
          const len = startMatch[1].length;
          const headerEnd = startMatch.index + startMatch[0].length;
          let contentStart = headerEnd;
          if (content[contentStart] === '\r') contentStart++;
          if (content[contentStart] === '\n') contentStart++;

          const midRegex = new RegExp(`^={${len}}$`, 'gm');
          midRegex.lastIndex = contentStart;
          const midMatch = midRegex.exec(content);
          if (!midMatch) continue;

          const patternStr = content.substring(contentStart, midMatch.index).replace(/(?:\r?\n)$/, '');
          const midEnd = midMatch.index + midMatch[0].length;

          let replaceStart = midEnd;
          if (content[replaceStart] === '\r') replaceStart++;
          if (content[replaceStart] === '\n') replaceStart++;

          const endRegex = new RegExp(`^>{${len}}$`, 'gm');
          endRegex.lastIndex = replaceStart;
          const endMatch = endRegex.exec(content);
          if (!endMatch) continue;

          const replaceStr = content.substring(replaceStart, endMatch.index).replace(/(?:\r?\n)$/, '');
          blocks.push({ patternStr, replaceStr });
          startRegex.lastIndex = endMatch.index + endMatch[0].length;
        }

        if (blocks.length === 0) {
          throw new Error('Invalid edit block format. Ensure you use SEARCH, ====, and >>>> markers correctly.');
        }

        const isRegex = params.regex === 'true';
        let currentFileContent = await vfs.readFile(AGENT_PRINCIPAL, params.path);
        let replaceCount = 0;

        for (let i = 0; i < blocks.length; i++) {
          let patternStr = blocks[i].patternStr;
          let replaceStr = blocks[i].replaceStr;

          if (!isRegex) {
            patternStr = patternStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          }

          let regex;
          try {
            regex = new RegExp(patternStr, 'm');
          } catch (e: any) {
            throw new Error(`Invalid RegExp in block ${i + 1}: ${e.message}`);
          }

          if (!regex.test(currentFileContent)) {
            throw new Error(`Search pattern not found for block ${i + 1}. No changes were made to the file.`);
          }

          const safeReplaceStr = replaceStr.replace(/\$/g, '$$$$');
          const newContent = currentFileContent.replace(regex, safeReplaceStr);

          if (newContent === currentFileContent) {
            throw new Error(`Replacement resulted in no change for block ${i + 1}. No changes were made to the file.`);
          }

          currentFileContent = newContent;
          replaceCount++;
        }

        await vfs.writeFile(AGENT_PRINCIPAL, params.path, currentFileContent, {
          overwrite: true,
        });
        const blockMsg = replaceCount > 1 ? `${replaceCount} blocks updated` : 'Content replaced';
        return { log: blockMsg, ui: `✏️ Replaced content in ${params.path}` };
      }

      throw new Error("Invalid <edit_file> content. Use SEARCH markers or specify 'mode' attribute.");
    },
  });

  registry.registerSystemTool(setId, setName, {
    name: 'file_info',
    description: 'Get detailed metadata of a file or directory.',
    impl: async (params: any, context: { vfs: VfsService }) => {
      if (!params.path) throw new Error("Attribute 'path' is required.");
      const stat = context.vfs.stat(AGENT_PRINCIPAL, params.path);

      let acl;
      try {
        acl = context.vfs.getAcl(AGENT_PRINCIPAL, params.path);
      } catch (e) {
        // 読み取り権限がない場合は無視
      }

      let log = `[File Info]\n`;
      log += `Path: /${stat.path || stat.name}\n`;
      log += `Type: ${stat.kind}\n`;
      if (stat.mimeType) log += `MIME: ${stat.mimeType}\n`;
      log += `Size: ${stat.size} bytes\n`;
      log += `Created: ${new Date(stat.createdAt).toISOString()}\n`;
      log += `Updated: ${new Date(stat.updatedAt).toISOString()}\n`;

      if (stat.version !== undefined) log += `Version: ${stat.version}\n`;
      if (stat.hash) log += `Hash: ${stat.hash}\n`;

      if (stat.flags) {
        log += `Flags: isSystem=${stat.flags.isSystem}, isTrashed=${stat.flags.isTrashed}\n`;
      }

      if (acl) {
        log += `\n[Access Control List]\n`;
        log += `Owner: ${acl.owner.type}:${acl.owner.id}\n`;
        acl.rules.forEach((rule: any) => {
          log += `- ${rule.principal.type}:${rule.principal.id} => [${rule.permissions.join(', ')}]\n`;
        });
      }

      return { log, ui: `ℹ️ Info: ${stat.name}` };
    },
  });

  registry.registerSystemTool(setId, setName, {
    name: 'list_files',
    description: 'Lists files in the VFS.',
    impl: async (params: any, context: { vfs: VfsService }) => {
      const root = params.path || '';
      const recursive = params.recursive === 'true';
      const detail = params.detail === 'true';

      const files = context.vfs.listFiles(AGENT_PRINCIPAL, {
        path: root,
        recursive,
        detail,
      });
      const limit = 100;
      let displayFiles = files;
      let suffix = '';

      if (files.length > limit) {
        displayFiles = files.slice(0, limit);
        suffix = `\n... (${files.length - limit} more files)`;
      }

      const formatOutput = (fileList: any[]) => {
        if (!detail) return fileList.join('\n');
        return fileList
          .map((f) => {
            const typeMark = f.kind === 'directory' ? '[DIR] ' : '      ';
            const sizeStr = f.size < 1024 ? `${f.size} B` : `${(f.size / 1024).toFixed(1)} KB`;
            const dateStr = new Date(f.updatedAt).toISOString().slice(0, 19).replace('T', ' ');
            return `${typeMark} ${(f.path || f.name).padEnd(40)} | ${sizeStr.padStart(10)} | ${dateStr}`;
          })
          .join('\n');
      };

      const resultStr = formatOutput(displayFiles) + suffix;
      return { log: resultStr, ui: `📂 Listed ${files.length} files` };
    },
  });

  registry.registerSystemTool(setId, setName, {
    name: 'delete_file',
    description: 'Deletes a file.',
    impl: async (params: any, context: { vfs: VfsService }) => {
      const msg = await context.vfs.deleteFile(AGENT_PRINCIPAL, params.path);
      return { log: msg, ui: `🗑️ Deleted ${params.path}` };
    },
  });

  registry.registerSystemTool(setId, setName, {
    name: 'move_file',
    description: 'Renames or moves a file.',
    impl: async (params: any, context: { vfs: VfsService }) => {
      if (params.overwrite === 'true' && context.vfs.exists(AGENT_PRINCIPAL, params.new_path)) {
        await context.vfs.deleteFile(AGENT_PRINCIPAL, params.new_path, { permanent: true });
      }
      const msg = await context.vfs.rename(AGENT_PRINCIPAL, params.path, params.new_path);
      return { log: msg, ui: `🚚 Moved ${params.path}` };
    },
  });

  registry.registerSystemTool(setId, setName, {
    name: 'copy_file',
    description: 'Copies a file.',
    impl: async (params: any, context: { vfs: VfsService }) => {
      if (params.overwrite === 'true' && context.vfs.exists(AGENT_PRINCIPAL, params.new_path)) {
        await context.vfs.deleteFile(AGENT_PRINCIPAL, params.new_path, { permanent: true });
      }
      const msg = await context.vfs.copyFile(AGENT_PRINCIPAL, params.path, params.new_path);
      return { log: msg, ui: `📄 Copied ${params.path}` };
    },
  });
}
