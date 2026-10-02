/**
 * src/core/control/tools/search_tools.ts
 * Itera OS v2: Search Tools
 */

import type { ToolRegistry } from '../ToolRegistry';
import type { VfsService } from '../../vfs/VfsService';
import { AGENT_PRINCIPAL } from '../../vfs/types';

const yieldToMain = () => new Promise((resolve) => setTimeout(resolve, 0));

const isBinary = (path: string) =>
  !!path.match(
    /\.(png|jpg|jpeg|gif|webp|svg|ico|bmp|pdf|zip|tar|gz|7z|rar|mp3|wav|mp4|webm|ogg|eot|ttf|woff|woff2|wasm|bin|exe|dll|so|dylib|class|jar)$/i,
  );

/**
 * 1 ファイルから出す当たりの上限。1 つのファイルが結果を埋め尽くさないため。
 * limit がこれより小さければ limit が上限になる（T-0596）。
 */
export const MAX_HITS_PER_FILE = 5;

/**
 * path による絞り込み。path そのもの（ファイル）か、その下だけを対象にする（T-0596）。
 * 以前は素の前方一致で、path="data/apps/loom" が data/apps/loom_old/ にも当たっていた。
 */
export function isInScope(filePath: string, rootPath: string): boolean {
  if (!rootPath) return true;
  return filePath === rootPath || filePath.startsWith(rootPath + '/');
}

/** 当たった行の前後を、行番号つきで切り出す */
function formatSnippet(lines: string[], j: number, contextLines: number, regex: RegExp): string {
  const startLine = Math.max(0, j - contextLines);
  const endLine = Math.min(lines.length, j + contextLines + 1);
  const maxLineLength = 250;

  return lines
    .slice(startLine, endLine)
    .map((l, idx) => {
      const currentLineNum = startLine + idx + 1;
      const isHitLine = currentLineNum === j + 1;
      const marker = isHitLine ? '>' : ' ';
      let lineText = l;

      // 行が長すぎる場合の Truncation 処理
      if (lineText.length > maxLineLength) {
        const match = isHitLine ? regex.exec(lineText) : null;
        if (match) {
          // マッチした行は、マッチ箇所の前後を切り出す
          const start = Math.max(0, match.index - maxLineLength / 2);
          const end = Math.min(lineText.length, match.index + match[0].length + maxLineLength / 2);
          lineText = (start > 0 ? '...' : '') + lineText.substring(start, end) + (end < lineText.length ? '...' : '');
        } else {
          // 周辺の行（とマッチ位置が取れなかった行）は先頭のみ
          lineText = lineText.substring(0, maxLineLength) + '...';
        }
      }

      return `${marker} ${currentLineNum.toString().padStart(4, ' ')} | ${lineText}`;
    })
    .join('\n');
}

export function registerSearchTools(registry: ToolRegistry): void {
  const setId = 'system:search';
  const setName = 'System: Search & indexing';

  registry.registerSystemTool(setId, setName, {
    name: 'search',
    description: 'Search text inside files.',
    impl: async (params: any, context: { vfs: VfsService }) => {
      const query = params.query;
      if (!query) throw new Error("Attribute 'query' is required.");

      const rootPath = String(params.path || '').replace(/\/+$/, '');
      const extensions = params.include
        ? params.include.split(',').map((e: string) => e.trim().toLowerCase().replace(/^\*/, ''))
        : [];
      const parsedContext = parseInt(params.context || '2', 10);
      const contextLines = isNaN(parsedContext) || parsedContext < 0 ? 2 : parsedContext;
      const parsedLimit = parseInt(params.limit, 10);
      const limit = isNaN(parsedLimit) || parsedLimit <= 0 ? 20 : parsedLimit;
      const perFileLimit = Math.min(MAX_HITS_PER_FILE, limit);

      const useRegex = params.regex && params.regex.toLowerCase() === 'true';
      const isCaseSensitive = params.case_sensitive && params.case_sensitive.toLowerCase() === 'true';
      const flags = isCaseSensitive ? 'm' : 'mi';
      const ignoreHidden = params.show_hidden !== 'true';

      let regex: RegExp;
      try {
        const pattern = useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        regex = new RegExp(pattern, flags);
      } catch (e: any) {
        return {
          log: `Invalid Regex Pattern: "/${query}/" -> ${e.message}`,
          error: true,
        };
      }

      const allFiles = context.vfs.listFiles(AGENT_PRINCIPAL, {
        recursive: true,
        ignoreHidden,
      }) as string[];

      // results は出力の行（当たり・注記）。数えるのは hits（当たり＝パス一致と当たった行）だけで、
      // 注記は数えない。limit は hits に掛ける（T-0596。以前は行のループの中で limit を見ておらず、
      // 1 ファイルだけを探すと limit に関係なく 5 件まで出ていた）。
      const results: string[] = [];
      let hits = 0;
      // 打ち切ったのは「limit に達したあとに、まだ当たりがあった」ときだけ
      let truncated = false;
      let skippedStubsCount = 0;

      let lastYieldTime = performance.now();
      const YIELD_INTERVAL_MS = 15;

      for (const filePath of allFiles) {
        if (!isInScope(filePath, rootPath)) continue;

        // 明示的に指定されていない限り、ログと一時ファイルを検索対象から外す
        if (!rootPath.startsWith('system/logs') && filePath.startsWith('system/logs/')) continue;
        if (!rootPath.startsWith('system/temp') && filePath.startsWith('system/temp/')) continue;

        if (extensions.length > 0) {
          const ext = '.' + filePath.split('.').pop()?.toLowerCase();
          if (!extensions.some((e: string) => ext.endsWith(e))) continue;
        }

        if (performance.now() - lastYieldTime > YIELD_INTERVAL_MS) {
          await yieldToMain();
          lastYieldTime = performance.now();
        }

        if (regex.test(filePath)) {
          if (hits >= limit) {
            truncated = true;
            break;
          }
          results.push(`[Path Match] ${filePath}\n---`);
          hits++;
        }

        if (isBinary(filePath)) continue;

        let isStub = false;
        try {
          const stat = context.vfs.stat(AGENT_PRINCIPAL, filePath);
          isStub = stat.syncState === 'stub';
        } catch (e) {}

        if (isStub) {
          skippedStubsCount++;
          continue;
        }

        let content: string;
        try {
          content = await context.vfs.readFile(AGENT_PRINCIPAL, filePath, { bypassFetch: true });
        } catch (e) {
          // 読み込みエラーはスキップ
          continue;
        }

        const lines = content.split(/\r?\n/);
        let fileHits = 0;
        for (let j = 0; j < lines.length; j++) {
          if (!regex.test(lines[j])) continue;

          if (hits >= limit) {
            truncated = true;
            break;
          }
          if (fileHits >= perFileLimit) {
            results.push(`  ... and more matches in ${filePath}`);
            break;
          }

          results.push(`File: ${filePath}\n${formatSnippet(lines, j, contextLines, regex)}\n---`);
          hits++;
          fileHits++;
        }

        if (truncated) break;
      }

      if (truncated) {
        results.push(
          `... (Search truncated: reached limit=${limit}. More matches exist; narrow the query or path, or raise the limit.)`,
        );
      }

      if (hits === 0) {
        return {
          log: `No matches found.\n(Note: ${skippedStubsCount} stub files were skipped)`,
          ui: `🔍 No matches found`,
        };
      }

      if (skippedStubsCount > 0) {
        results.push(
          `\n... (${skippedStubsCount} stub files were skipped from content search. Use <file_info> or a custom daemon search tool to inspect them.)`,
        );
      }

      return {
        log: results.join('\n'),
        ui: `🔍 Search: "${query}" (${hits}${truncated ? '+' : ''} hits)`,
      };
    },
  });
}
