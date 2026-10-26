/**
 * src/core/control/tools/fs_tools.ts
 * Itera OS v2: File System Tools
 */

import type { ToolRegistry } from '../ToolRegistry';
import type { VfsService } from '../../vfs/VfsService';
import { AGENT_PRINCIPAL } from '../../vfs/types';
import { parseEditBlocks, applyEditBlocks } from './editBlocks';
import { ToolError } from '../ToolError';
import { isVfsError } from '../../vfs/VfsError';
import { mimeOfPath } from '../../chat/attachmentGate';
import type { ToolResult } from '../../types/tools';

export function registerFSTools(registry: ToolRegistry): void {
  const setId = 'system:fs';
  const setName = 'System: File Operations';

  // ------------------------------------------------------------------
  // 中身の三つ組 {read, edit, write} と、物としての attach_file（T-0683）
  //
  //   読む（read）   … テキストを行の範囲で文脈へ。履歴にはテキストが入る
  //   添付（attach_file） … ファイルを丸ごと、メディア参照として履歴へ。線形化はプロバイダ任せ。範囲は無い
  //
  // 以前の read_file はこの 2 つを 1 つの名前に畳んでいて、PDF に start/end を渡しても黙って
  // 全ページを送っていた（ミャク楽で「40 ページ全部入った」が繰り返し起きた）。
  // 形式ごとの処理（PDF のページ → PNG など）はホストに置かず、ゲストの道具（pdf_tool）に任せる。
  // 旧名（read_file / create_file / edit_file）は別名として残す（挙動は旧のまま。しばらくして外す）。
  // ------------------------------------------------------------------

  // svg は XML（文字）なのでここに入れない（read で読める・attach_file は text 文書として送る。T-0690）
  const BINARY_EXTS =
    /\.(png|jpg|jpeg|gif|webp|ico|bmp|pdf|zip|tar|gz|7z|rar|mp3|wav|mp4|webm|ogg|wasm|bin|exe|dll|so|dylib|class|jar|docx|xlsx|pptx)$/i;
  const PDF_PAGES_HINT =
    'spawn system/services/pdf_tool.html and use pdf_info → pdf_extract → attach_file (pdf_pages only when the look matters, pdf_text for plain text)';

  const LEGACY_READ =
    '[read_file is a legacy name. Use <read> for text (line ranges) or <attach_file> for the whole file as media.]\n';
  const LEGACY_CREATE = '[create_file is a legacy name. Use <write> (overwrite="true" / append="true").]\n';
  const LEGACY_EDIT = '[edit_file is a legacy name. Use <edit>; for mode="append" use <write append="true">.]\n';

  /**
   * 添付の形で返す（attach_file の本体。read_file の旧挙動もこれ）。
   * 道具がするのは「履歴に media を積む」までで、**モデルに届くかは投影（プロバイダの対応 MIME・大きさ）が決める**。
   * だから文は「積んだ」とだけ言い、届かなかったときは投影の注記がその場に出る（道具の成否と添付の成否は別。T-0690 山内さん）。
   */
  function attachResult(vfs: VfsService, path: string): ToolResult {
    const stat = vfs.stat(AGENT_PRINCIPAL, path);
    if (stat.kind === 'directory') throw new ToolError(`${path} is a directory. attach_file takes a file.`);
    let mimeType = mimeOfPath(path);
    if (mimeType === 'application/octet-stream' && stat.mimeType) mimeType = stat.mimeType;
    const isPdf = mimeType === 'application/pdf';
    const kind = mimeType.startsWith('text/') ? 'a text document' : 'media';
    let log = `Placed ${path} (${mimeType}, ${stat.size} bytes) in the history as ${kind}. Whether the model receives it depends on the model (supported format and size limit); if it cannot be sent, a notice replaces it here.`;
    if (isPdf) {
      log += ` Every page of the PDF is included. To read selected pages next time, ${PDF_PAGES_HINT}.`;
    }
    return {
      log,
      ui: `📎 Attached ${path}`,
      media: { path, mimeType, metadata: {} },
    };
  }

  /** テキストを行の範囲で読む（read の本体） */
  async function readTextResult(
    vfs: VfsService,
    params: any,
    opts: { legacyName?: boolean } = {},
  ): Promise<ToolResult> {
    const path: string = params.path;
    if (!path) throw new ToolError("Attribute 'path' is required.");
    if (!vfs.exists(AGENT_PRINCIPAL, path)) throw new ToolError(`File not found.`);

    const refuse = (why: string): never => {
      const mime = mimeOfPath(path);
      const hint =
        mime === 'application/pdf'
          ? `To read selected pages, ${PDF_PAGES_HINT}. To put the WHOLE document in the context, use <attach_file>.`
          : 'Use <attach_file path="..."> to put the whole file in the context as media.';
      throw new ToolError(`${path} is not a text file (${why}). <read> returns text only. ${hint}`);
    };

    let content = '';
    if (path.match(BINARY_EXTS)) {
      if (opts.legacyName) return attachResult(vfs, path);
      refuse(mimeOfPath(path));
    }
    content = await vfs.readFile(AGENT_PRINCIPAL, path);
    // テキストとして読み込んだ結果、Nullバイトが含まれていればバイナリとみなす
    if (content.indexOf('\0') !== -1) {
      if (opts.legacyName) return attachResult(vfs, path);
      refuse('binary content');
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
      const tag = opts.legacyName ? 'read_file' : 'read';
      logMsg += `\n\n... (File truncated. ${lines.length - endIdx} more lines. Use <${tag} start="${endIdx + 1}"> to read more)`;
    }

    return { log: logMsg, ui: `📖 Read ${path}` };
  }

  /** ファイルを書く（write の本体。create_file の旧挙動は append 無し） */
  async function writeResult(vfs: VfsService, params: any): Promise<ToolResult> {
    const path: string = params.path;
    if (!path) throw new ToolError("Attribute 'path' is required.");
    const isOverwrite = params.overwrite === 'true';
    const isAppend = params.append === 'true';
    if (isOverwrite && isAppend) throw new ToolError('Choose one of overwrite="true" or append="true".');

    let content: string = params.content || '';
    content = content.replace(/^\r?\n/, '').replace(/\r?\n$/, '');

    if (isAppend) {
      // 無ければ「まだ無いはず」（ifVersion: 0）で作る。その間に誰かが作っていれば ESTALE → 下の追記へ
      if (!vfs.exists(AGENT_PRINCIPAL, path)) {
        try {
          const msg = await vfs.writeFile(AGENT_PRINCIPAL, path, content, { overwrite: false, ifVersion: 0 });
          return { log: `${msg} (created; nothing to append to)`, ui: `📝 Created ${path}` };
        } catch (err) {
          if (!(isVfsError(err) && err.code === 'ESTALE')) throw err;
        }
      }
      // 読む→足す→書く を版の照合で（T-0715）。並んだ追記はどれも落ちず、順に積まれる
      await vfs.updateFile(AGENT_PRINCIPAL, path, (current) =>
        current.length && !current.endsWith('\n') ? current + '\n' + content : current + content,
      );
      return { log: `Appended to end of ${path}`, ui: `📝 Appended ${path}` };
    }

    if (!isOverwrite && vfs.exists(AGENT_PRINCIPAL, path)) {
      throw new ToolError(
        `File already exists at ${path}. Set overwrite="true" to replace it, append="true" to add to its end, or use <edit> to modify part of it.`,
      );
    }
    const msg = await vfs.writeFile(AGENT_PRINCIPAL, path, content, { overwrite: isOverwrite });
    return {
      log: msg,
      ui: `📝 ${isOverwrite ? 'Overwrote' : 'Created'} ${path}`,
    };
  }

  /** 一部を直す（edit の本体。append は write へ） */
  async function editResult(vfs: VfsService, params: any, opts: { legacyName?: boolean } = {}): Promise<ToolResult> {
    const path: string = params.path;
    if (!path) throw new ToolError("Attribute 'path' is required.");
    const content: string = params.content || '';
    const tag = opts.legacyName ? 'edit_file' : 'edit';

    // 行ベースの編集モード
    if (params.mode) {
      if (params.mode === 'append' && !opts.legacyName) {
        throw new ToolError('mode="append" is not part of <edit>. Use <write path="..." append="true">.');
      }
      if (!vfs.exists(AGENT_PRINCIPAL, path)) throw new ToolError(`File not found: ${path}`);

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

      // 行の差し替えは「いまの中身」に対して行う。読む→直す→書く は版の照合で守る（T-0715）
      const applyLines = (fileContent: string): string => {
        const lines = fileContent.split(/\r?\n/);
        if (params.mode === 'replace') {
          if (isNaN(eLine)) throw new ToolError('End line required for replace.');
          const count = Math.max(0, eLine - sLine + 1);
          while (lines.length < sIdx) lines.push('');
          lines.splice(sIdx, count, ...insertLines);
          log = `Replaced lines ${sLine}-${eLine}`;
        } else if (params.mode === 'insert') {
          while (lines.length < sIdx) lines.push('');
          lines.splice(sIdx, 0, ...insertLines);
          log = `Inserted at line ${sLine}`;
        } else if (params.mode === 'delete') {
          if (isNaN(eLine)) throw new ToolError('End line required for delete.');
          const count = Math.max(0, eLine - sLine + 1);
          lines.splice(sIdx, count);
          log = `Deleted lines ${sLine}-${eLine}`;
        } else if (params.mode === 'append') {
          // 旧名 edit_file だけ。新しい形は <write append="true">
          lines.push(...insertLines);
          log = `Appended to end of file`;
        } else {
          throw new ToolError(`Unknown mode: ${params.mode}`);
        }
        return lines.join('\n');
      };

      await vfs.updateFile(AGENT_PRINCIPAL, path, applyLines);
      return { log, ui: `✏️ Edited ${path} (${params.mode})` };
    }

    // SEARCH ブロック編集モード
    // 切り出しと適用は editBlocks.ts（VFS に触らない純粋な文字列処理）。ここは橋渡しだけを持つ。
    // どちらも例外を投げうるが、書き込みはその後なので **失敗すれば 1 文字も書かれない**。
    // 読む→当てる→書く は版の照合で守る（T-0715）。同じファイルへ並んだ edit は、先に書かれた分を
    // 読み直して当て直す。当たらなくなっていれば、そのときだけ「一致しない」の失敗になる。
    if (/<{4,}SEARCH/.test(content)) {
      const blocks = parseEditBlocks(content);
      await vfs.updateFile(AGENT_PRINCIPAL, path, (current) =>
        applyEditBlocks(current, blocks, { regex: params.regex === 'true' }),
      );
      const blockMsg = blocks.length > 1 ? `${blocks.length} blocks updated` : 'Content replaced';
      return { log: blockMsg, ui: `✏️ Replaced content in ${path}` };
    }

    throw new ToolError(`Invalid <${tag}> content. Use SEARCH markers or specify 'mode' attribute.`);
  }

  const withNote = (note: string, r: ToolResult): ToolResult => ({ ...r, log: note + (r.log || '') });

  registry.registerSystemTool(setId, setName, {
    name: 'read',
    description: 'Reads a text file (line range) into the context. Refuses binary files.',
    impl: async (params: any, context: { vfs: VfsService }) => readTextResult(context.vfs, params),
  });

  registry.registerSystemTool(setId, setName, {
    name: 'attach_file',
    description: 'Puts a whole file into the context as media (image / PDF / audio / text document). No range.',
    impl: async (params: any, context: { vfs: VfsService }) => {
      const vfs = context.vfs;
      if (!params.path) throw new ToolError("Attribute 'path' is required.");
      if (params.start !== undefined || params.end !== undefined || params.pages !== undefined) {
        throw new ToolError(
          'attach_file has no range: the whole file is attached. For a line range use <read>; for PDF pages use pdf_tool (pdf_info → pdf_extract → attach_file).',
        );
      }
      if (!vfs.exists(AGENT_PRINCIPAL, params.path)) throw new ToolError(`File not found.`);
      return attachResult(vfs, params.path);
    },
  });

  registry.registerSystemTool(setId, setName, {
    name: 'write',
    description: 'Writes a text file: create, overwrite="true", or append="true".',
    impl: async (params: any, context: { vfs: VfsService }) => writeResult(context.vfs, params),
  });

  registry.registerSystemTool(setId, setName, {
    name: 'edit',
    description: 'Edits part of a text file via SEARCH blocks or line mode (insert / replace / delete).',
    impl: async (params: any, context: { vfs: VfsService }) => editResult(context.vfs, params),
  });

  // 旧名（別名）。挙動は旧のまま。結果の先頭で新名を教える
  registry.registerSystemTool(setId, setName, {
    name: 'read_file',
    description: 'Legacy alias: <read> for text, <attach_file> for binary.',
    impl: async (params: any, context: { vfs: VfsService }) =>
      withNote(LEGACY_READ, await readTextResult(context.vfs, params, { legacyName: true })),
  });
  registry.registerSystemTool(setId, setName, {
    name: 'create_file',
    description: 'Legacy alias of <write>.',
    impl: async (params: any, context: { vfs: VfsService }) =>
      withNote(LEGACY_CREATE, await writeResult(context.vfs, { ...params, append: undefined })),
  });
  registry.registerSystemTool(setId, setName, {
    name: 'edit_file',
    description: 'Legacy alias of <edit> (mode="append" included).',
    impl: async (params: any, context: { vfs: VfsService }) =>
      withNote(LEGACY_EDIT, await editResult(context.vfs, params, { legacyName: true })),
  });

  registry.registerSystemTool(setId, setName, {
    name: 'file_info',
    description: 'Get detailed metadata of a file or directory.',
    impl: async (params: any, context: { vfs: VfsService }) => {
      if (!params.path) throw new ToolError("Attribute 'path' is required.");
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
      // PDF のページ数はホストで数えない（pdf.js を持つのはゲストの pdf_tool。推測の数字を出さない）
      if (stat.kind === 'file' && /\.pdf$/i.test(stat.name || '')) {
        log += `PDF: page count and text layer → <pdf_info> (spawn system/services/pdf_tool.html); selected pages → <pdf_extract> then <attach_file>. <attach_file> on the original sends every page.\n`;
      }
      log += `Created: ${new Date(stat.createdAt).toISOString()}\n`;
      log += `Updated: ${new Date(stat.updatedAt).toISOString()}\n`;

      // 2 つの軸を分けて出す（T-0352）:
      //   実体があるか無いか（stub） … ファイル自身の性質
      //   誰の管轄か（syncProvider） … 保存されず、問い合わせのたびにマウント表から導く
      // 両方あって初めて「取りに行ける stub」と「取りに行けない stub（孤児）」を区別できる。
      const isStub = stat.syncState === 'stub';
      const prov = stat.syncProvider;
      if (isStub || prov) {
        const body = isStub ? 'stub (metadata only; the content is not in the VFS yet)' : 'local copy';
        // 担当が登録されていても、そのプロセスが落ちていれば取りに行けない（T-0353）。
        // ここを黙ると『provider が居るのに read が失敗する』という読めない状態になる。
        const owner = prov
          ? `provider=${prov.pid} (mount=/${prov.mountPath})` +
            (prov.alive ? '' : ' — NOT RUNNING; the content cannot be fetched until it is restarted')
          : 'no provider — the content can never be fetched (orphaned stub)';
        log += `Sync: ${body} / ${owner}\n`;
      }
      if (stat.isMountPoint) log += `Mount point: yes (a sync provider is attached here)\n`;
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
      const ignoreHidden = params.show_hidden !== 'true';

      const files = context.vfs.listFiles(AGENT_PRINCIPAL, {
        path: root,
        recursive,
        detail,
        ignoreHidden,
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
            // スタブ（中身がまだ手元に無い）を見分けられるようにする（T-0351）
            const stubMark = f.syncState === 'stub' ? ' | stub' : '';
            return `${typeMark} ${(f.path || f.name).padEnd(40)} | ${sizeStr.padStart(10)} | ${dateStr}${stubMark}`;
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
      // permanent="true" はゴミ箱を経ずに消す（T-0689）。stub の中身を取りに行かないので、
      // プロバイダが応じないときの唯一の逃げ道でもある（向こうの実体は次の照合で消える）
      const permanent = String(params.permanent).toLowerCase() === 'true';
      const msg = await context.vfs.deleteFile(AGENT_PRINCIPAL, params.path, permanent ? { permanent: true } : {});
      return { log: msg, ui: permanent ? `🗑️ Permanently deleted ${params.path}` : `🗑️ Deleted ${params.path}` };
    },
  });

  // ゴミ箱から元の場所へ（T-0470）。元の場所を知らない古いゴミは new_path が要る
  registry.registerSystemTool(setId, setName, {
    name: 'restore_file',
    description: 'Restores a trashed entry to its original location.',
    impl: async (params: any, context: { vfs: VfsService }) => {
      const dest = await context.vfs.restore(
        AGENT_PRINCIPAL,
        params.path,
        params.new_path ? { to: params.new_path } : {},
      );
      return { log: `Restored: ${params.path} -> ${dest}`, ui: `↩️ Restored ${dest}` };
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
