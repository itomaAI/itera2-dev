/**
 * src/core/control/tools/sys_tools.ts
 * Itera OS v2: System Control Tools
 */

import type { ToolRegistry } from '../ToolRegistry';
import type { PresentedFile } from '../../types/tools';
import { USER_PRINCIPAL } from '../../vfs/types';

/**
 * files の本文からパスを取り出す。1 行 1 パス。
 * 箇条書きの印（- / *）・バッククォート・先頭の / は剥がす（AI が書きがちな揺れを吸収する）。
 * 空行は無視し、同じパスは 1 つにする。
 */
export function parsePresentedPaths(content: string): string[] {
  const out: string[] = [];
  for (const raw of content.split('\n')) {
    let line = raw.trim();
    if (!line) continue;
    line = line
      .replace(/^[-*]\s+/, '')
      .replace(/^`+|`+$/g, '')
      .trim();
    line = line.replace(/^\/+/, '').replace(/\/+$/, '');
    if (line && !out.includes(line)) out.push(line);
  }
  return out;
}

export function registerSysTools(registry: ToolRegistry): void {
  const setId = 'system:core';
  const setName = 'System: Core Logic';

  registry.registerSystemTool(setId, setName, {
    name: 'finish',
    description: 'Halt autonomous loop.',
    impl: async () => ({
      log: `Autonomous loop stopped. Standing by.`,
      ui: `✅ Standby`,
      halt_loop: true,
    }),
  });

  // 【重要】ask / report の `ui` には本文を入れないこと。
  // `ui` は全ツール共通で「絵文字＋短い動詞句」の実行ステータスであり、
  // 本文は `artifact` としてChatPanelへ渡す（別の枠に描かれる）。
  // 以前は ui に本文を積んでいたため、レポートがログの箱の中に等幅で描かれ、
  // かつ modelターンの生出力と合わせて二重に表示されていた。
  registry.registerSystemTool(setId, setName, {
    name: 'ask',
    description: 'Ask user a question.',
    impl: async (params: any) => ({
      log: `Waiting for user input.`,
      ui: `❓ ask`,
      artifact: { kind: 'speech' as const, text: params.content || '' },
      halt_loop: true,
    }),
  });

  registry.registerSystemTool(setId, setName, {
    name: 'report',
    description: 'Report to user.',
    impl: async (params: any) => ({
      log: `Displayed message to user.`,
      ui: `📢 report`,
      artifact: { kind: 'speech' as const, text: params.content || '' },
      trigger_llm: false,
    }),
  });

  // files: 利用者にファイルを差し出す（T-0344）。
  // 本文は 1 行 1 パス。存在を stat で確かめ、ChatPanel が「開く」「ダウンロード」付きで描く。
  // 無いパスは artifact に missing で残しつつ log で AI に返す（黙って落とさない）。
  // 全部無ければ失敗にする（「差し出した」と言わない）。
  registry.registerSystemTool(setId, setName, {
    name: 'files',
    description: 'Present files to user.',
    impl: async (params: any, context: any) => {
      const paths = parsePresentedPaths(params.content || '');
      if (paths.length === 0) throw new Error('No file path given. Write one VFS path per line inside <files>.');

      const files: PresentedFile[] = paths.map((path) => {
        const name = path.split('/').pop() || path;
        try {
          const stat = context.vfs.stat(USER_PRINCIPAL, path);
          const kind = stat?.kind === 'directory' ? 'directory' : 'file';
          return { path, name, kind, size: typeof stat?.size === 'number' ? stat.size : undefined };
        } catch {
          return { path, name, kind: 'file', missing: true };
        }
      });

      const missing = files.filter((f) => f.missing).map((f) => f.path);
      if (missing.length === files.length) {
        throw new Error(`File not found: ${missing.join(', ')}`);
      }
      const shown = files.length - missing.length;
      const log =
        `Presented ${shown} file(s) to user.` + (missing.length ? ` Not found (skipped): ${missing.join(', ')}` : '');

      return {
        log,
        ui: `📎 files (${shown})`,
        artifact: { kind: 'files' as const, title: params.title || undefined, files },
        trigger_llm: false,
      };
    },
  });

  registry.registerSystemTool(setId, setName, {
    name: 'set_timer',
    description: 'Set async timer.',
    impl: async (params: any, context: any) => {
      const delay = parseInt(params.delay, 10);
      if (isNaN(delay) || delay <= 0) throw new Error('Invalid delay.');
      const message = params.message || 'Timer expired.';

      setTimeout(() => {
        // 予定した時刻の割り込みなので、速く起こしてもらう（名乗るのはツール側）
        if (context.engine) context.engine.injectSystemEvent('timer_alert', message, { wake: 'fast' });
      }, delay * 1000);

      return {
        log: `Timer set for ${delay} seconds.`,
        ui: `⏱️ Timer set (${delay}s)`,
        trigger_llm: false,
      };
    },
  });

  registry.registerSystemTool(setId, setName, {
    name: 'reset_session',
    description: 'Reset history session.',
    impl: async (params: any, context: any) => {
      const purgeMedia = params.purge_media === 'true';
      const summary = params.content || '';

      let nextSessionMsg =
        '[System: Session Reset & Context Compressed]\nPlease run the Initialization Protocol first.';
      if (summary) nextSessionMsg += `\n\n[Carried Over Information]\n${summary}`;

      if (context.shell && context.shell.clearSession) {
        // ※ ShellController 側に clearSession の実装が必要
        await context.shell.clearSession({
          purgeMedia,
          summary: nextSessionMsg,
          triggerLlm: true,
          restoreTools: true,
        });
      }

      return {
        log: `Session has been reset.`,
        ui: `♻️ Session Reset`,
        halt_loop: true,
      };
    },
  });

  // 道具の定義を自分で取りに来る入口（T-0246）。
  // 【重要】戻り値に trigger_llm: false を付けない。付けると実行結果で次のターンが始まらない
  //（2026-08-26 に山内さんが踏んだ）。yield/breathe のような「制御」の道具だけが false を返す。
  // 定義は登録時と履歴の消去・リセット時に <event type="tool_available"> で届くが、
  // コンテクストの圧縮で本文が落ちたとき／走っている間に定義が変わったとき／長い定義を要るときだけ読みたいとき
  // のために、一覧と本文を引ける口を残す。
  registry.registerSystemTool(setId, setName, {
    name: 'tool_catalog',
    description: 'List active toolsets or fetch one tool definition.',
    impl: async (params: any) => {
      const action = String(params.action || 'list');
      if (action === 'define') {
        const name = String(params.name || '').trim();
        if (!name) return { log: '[Error] name is required for action="define".', ui: '❌ tool_catalog' };
        const found = registry.getToolDefinition(name);
        if (!found) {
          return {
            log: `[Error] No tool named <${name}> is registered. Use <tool_catalog action="list" /> to see what is active.`,
            ui: '❌ tool_catalog',
          };
        }
        if (!found.definition) {
          return {
            log: `<${name}> belongs to ${found.setName} (${found.kind}). It has no separate definition text — system tools are defined in the system prompt.`,
            ui: `🧰 ${name}`,
          };
        }
        return {
          log: `<toolset name="${found.setName}" pid="${found.setId}">
${found.definition}
</toolset>`,
          ui: `🧰 ${name}`,
        };
      }
      const includeSystem = params.include_system === 'true';
      const sets = registry.listToolSets(includeSystem);
      if (sets.length === 0) {
        return {
          log: 'No dynamic tools are active (no app or daemon has registered any).',
          ui: '🧰 tool_catalog',
        };
      }
      const lines: string[] = [];
      for (const s of sets) {
        lines.push(`[${s.kind}] ${s.name} (pid: ${s.id})${s.description ? ` — ${s.description}` : ''}`);
        for (const t of s.tools) {
          lines.push(
            `  - ${t.name}${t.description && t.description !== t.name ? `: ${t.description}` : ''}${t.hasDefinition ? '' : ' (no definition text)'}`,
          );
        }
      }
      lines.push('', 'Fetch the full definition of one tool with <tool_catalog action="define" name="TOOL_NAME" />.');
      return { log: lines.join('\n'), ui: `🧰 ${sets.length} toolsets` };
    },
  });

  registry.registerSystemTool(setId, setName, {
    name: 'yield',
    description: 'Hand over control.',
    impl: async () => ({
      log: `Handed over control to system. Executing pending tools...`,
      ui: `⏳ Yielding to System`,
      trigger_llm: false,
    }),
  });

  registry.registerSystemTool(setId, setName, {
    name: 'breathe',
    description: 'Refresh reasoning.',
    impl: async () => ({
      log: `Deep breath taken. Reasoning cycle refreshed.`,
      ui: `💨 Taking a breath...`,
      trigger_llm: true,
    }),
  });

  // ダミータグ
  registry.registerSystemTool(setId, setName, {
    name: 'thinking',
    description: 'Log only',
    impl: async () => null,
  });
  registry.registerSystemTool(setId, setName, {
    name: 'plan',
    description: 'Log only',
    impl: async () => null,
  });
}
