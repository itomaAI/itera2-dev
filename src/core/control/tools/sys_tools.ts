/**
 * src/core/control/tools/sys_tools.ts
 * Itera OS v2: System Control Tools
 */

import type { ToolRegistry } from '../ToolRegistry';

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

  registry.registerSystemTool(setId, setName, {
    name: 'ask',
    description: 'Ask user a question.',
    impl: async (params: any) => ({
      log: `Waiting for user input.`,
      ui: `❓ ${params.content}`,
      halt_loop: true,
    }),
  });

  registry.registerSystemTool(setId, setName, {
    name: 'report',
    description: 'Report to user.',
    impl: async (params: any) => ({
      log: `Displayed message to user.`,
      ui: `📢 ${params.content}`,
      trigger_llm: false,
    }),
  });

  registry.registerSystemTool(setId, setName, {
    name: 'set_timer',
    description: 'Set async timer.',
    impl: async (params: any, context: any) => {
      const delay = parseInt(params.delay, 10);
      if (isNaN(delay) || delay <= 0) throw new Error('Invalid delay.');
      const message = params.message || 'Timer expired.';

      setTimeout(() => {
        if (context.engine) context.engine.injectSystemEvent('timer_alert', message);
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
