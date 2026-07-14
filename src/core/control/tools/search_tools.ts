/**
 * src/core/control/tools/search_tools.ts
 * Itera OS v2: Search Tools
 */

import type { ToolRegistry } from '../ToolRegistry';
import type { VfsService } from '../../vfs/VfsService';
import type { Principal } from '../../vfs/types';

const yieldToMain = () => new Promise((resolve) => setTimeout(resolve, 0));

const isBinary = (path: string) =>
  !!path.match(
    /\.(png|jpg|jpeg|gif|webp|svg|ico|bmp|pdf|zip|tar|gz|7z|rar|mp3|wav|mp4|webm|ogg|eot|ttf|woff|woff2|wasm|bin|exe|dll|so|dylib|class|jar)$/i,
  );

export function registerSearchTools(registry: ToolRegistry): void {
  const setId = 'system:search';
  const setName = 'System: Search & indexing';

  const AGENT_PRINCIPAL: Principal = { type: 'agent', id: 'Itera_AI' };

  registry.registerSystemTool(setId, setName, {
    name: 'search',
    description: 'Search text inside files.',
    impl: async (params: any, context: { vfs: VfsService }) => {
      const query = params.query;
      if (!query) throw new Error("Attribute 'query' is required.");

      const rootPath = params.path || '';
      const extensions = params.include
        ? params.include.split(',').map((e: string) => e.trim().toLowerCase().replace(/^\*/, ''))
        : [];
      const contextLines = parseInt(params.context || '2', 10);

      const useRegex = params.regex && params.regex.toLowerCase() === 'true';
      const isCaseSensitive = params.case_sensitive && params.case_sensitive.toLowerCase() === 'true';
      const flags = isCaseSensitive ? 'm' : 'mi';

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
      }) as string[];
      const results: string[] = [];

      let lastYieldTime = performance.now();
      const YIELD_INTERVAL_MS = 15;

      for (const filePath of allFiles) {
        if (rootPath && !filePath.startsWith(rootPath)) continue;

        if (extensions.length > 0) {
          const ext = '.' + filePath.split('.').pop()?.toLowerCase();
          if (!extensions.some((e: string) => ext.endsWith(e))) continue;
        }

        if (performance.now() - lastYieldTime > YIELD_INTERVAL_MS) {
          await yieldToMain();
          lastYieldTime = performance.now();
        }

        if (regex.test(filePath)) {
          results.push(`[Path Match] ${filePath}\n---`);
        }

        if (results.length >= 20) {
          results.push('... (Search truncated: Too many matches)');
          break;
        }

        if (isBinary(filePath)) continue;

        try {
          const content = await context.vfs.readFile(AGENT_PRINCIPAL, filePath);
          const lines = content.split(/\r?\n/);
          let fileHits = 0;

          for (let j = 0; j < lines.length; j++) {
            if (regex.test(lines[j])) {
              fileHits++;

              if (fileHits > 5) {
                results.push(`  ... and more matches in ${filePath}`);
                break;
              }

              const startLine = Math.max(0, j - contextLines);
              const endLine = Math.min(lines.length, j + contextLines + 1);

              const snippet = lines
                .slice(startLine, endLine)
                .map((l, idx) => {
                  const currentLineNum = startLine + idx + 1;
                  const marker = currentLineNum === j + 1 ? '>' : ' ';
                  return `${marker} ${currentLineNum.toString().padStart(4, ' ')} | ${l}`;
                })
                .join('\n');

              results.push(`File: ${filePath}\n${snippet}\n---`);
            }
          }
        } catch (e) {
          // 読み込みエラーはスキップ
        }

        if (results.length >= 20) {
          results.push('... (Search truncated: Too many matches)');
          break;
        }
      }

      if (results.length === 0) {
        return { log: `No matches found.`, ui: `🔍 No matches found` };
      }

      return {
        log: results.join('\n'),
        ui: `🔍 Search: "${query}" (${results.length} hits)`,
      };
    },
  });
}
