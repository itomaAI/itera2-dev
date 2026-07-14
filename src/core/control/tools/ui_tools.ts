/**
 * src/core/control/tools/ui_tools.ts
 * Itera OS v2: UI & Process Tools
 */

import type { ToolRegistry } from '../ToolRegistry';
import type { VfsService } from '../../vfs/VfsService';
import { SYSTEM_PRINCIPAL, USER_PRINCIPAL } from '../../vfs/types';

export function registerUITools(registry: ToolRegistry): void {
  const setId = 'system:ui';
  const setName = 'System: Process & UI';

  registry.registerSystemTool(setId, setName, {
    name: 'spawn',
    description: 'Spawn process.',
    impl: async (params: any, context: any) => {
      let pid = params.pid || 'main';
      const path = params.path || 'apps/home.html';
      let mode = params.mode || 'background';
      const forceReload = params.force === 'true';

      if (pid === 'main') {
        mode = 'foreground';
        const basePath = path.split(/[?#]/)[0];
        pid = `app_${basePath.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      }

      const args: Record<string, string> = {};
      for (const [k, v] of Object.entries(params)) {
        if (!['pid', 'path', 'mode', 'force', 'content'].includes(k)) {
          args[k] = String(v);
        }
      }

      const currentUri = `metaos://run/${path}`;

      if (context.shell?.processManager) {
        await context.shell.processManager.spawn(pid, path, mode, forceReload, args, currentUri);
        return { log: `Process started.`, ui: `🚀 Spawned [${pid}]` };
      }
      return { log: 'ProcessManager not available.', error: true };
    },
  });

  registry.registerSystemTool(setId, setName, {
    name: 'open',
    description: 'Open a file using default app.',
    impl: async (params: any, context: any) => {
      const path = params.path;
      if (!path) throw new Error("Attribute 'path' is required.");

      if (context.shell?.resolver) {
        try {
          const stat = context.vfs.stat(USER_PRINCIPAL, path);
          const resolvedApp = context.shell.resolver.resolveDefault(stat);

          if (resolvedApp.appId === 'HostEditor') {
            const content = await context.vfs.readFile(USER_PRINCIPAL, path);
            context.shell.modals.editor.open(path, content);
            return {
              log: `Opened ${path} in Host Editor`,
              ui: `📝 Opened Editor`,
            };
          } else if (resolvedApp.appId === 'HostMediaViewer') {
            const blob = await context.vfs.readBlob(USER_PRINCIPAL, path);
            context.shell.modals.media.open(path, blob);
            return {
              log: `Opened ${path} in Media Viewer`,
              ui: `🖼️ Opened Media`,
            };
          } else {
            const args = { file: path };
            const fullUri = `metaos://open/${path}`;
            await context.shell.processManager.spawn(
              resolvedApp.appId,
              resolvedApp.appPath,
              'foreground',
              false,
              args,
              fullUri,
            );
            return {
              log: `Opened ${path} in ${resolvedApp.appName}`,
              ui: `🚀 Opened [${resolvedApp.appId}]`,
            };
          }
        } catch (e: any) {
          throw new Error(`Failed to open: ${e.message}`);
        }
      }
      return { log: 'Shell not available.', error: true };
    },
  });

  registry.registerSystemTool(setId, setName, {
    name: 'kill',
    description: 'Kill process.',
    impl: async (params: any, context: any) => {
      const pid = params.pid;
      if (!pid) throw new Error("Attribute 'pid' is required.");

      if (context.shell?.processManager) {
        const success = context.shell.processManager.kill(pid);
        if (success) return { log: `Process terminated.`, ui: `🛑 Killed [${pid}]` };
        return { log: `Process not found or already stopped.`, error: true };
      }
      return { log: 'ProcessManager not available.', error: true };
    },
  });

  registry.registerSystemTool(setId, setName, {
    name: 'ps',
    description: 'List processes.',
    impl: async (_params: any, context: any) => {
      if (context.shell?.processManager) {
        const list = context.shell.processManager.list();
        if (list.length === 0) return { log: 'No processes running.', ui: `📊 Process List (0)` };

        const logStr = list
          .map(
            (p: any) =>
              `PID: ${p.pid.padEnd(15)} | Type: ${p.type.padEnd(6)} | State: ${p.state.padEnd(10)} | Path: ${p.path}`,
          )
          .join('\n');

        return { log: logStr, ui: `📊 Process List (${list.length})` };
      }
      return { log: 'ProcessManager not available.', error: true };
    },
  });

  registry.registerSystemTool(setId, setName, {
    name: 'take_screenshot',
    description: 'Capture screenshot.',
    impl: async (_params: any, context: { shell: any; vfs: VfsService }) => {
      if (context.shell?.processManager) {
        await new Promise((r) => setTimeout(r, 1000)); // Render wait

        try {
          // captureScreenshot はプレーンな Base64 文字列を返す
          const base64 = await context.shell.processManager.captureScreenshot();

          const timestamp = Date.now();
          const path = `system/temp/media/screenshot_${timestamp}.png`;

          // ツールの責任として Blob に変換してから VFS に渡す
          const byteString = atob(base64);
          let n = byteString.length;
          const u8arr = new Uint8Array(n);
          while (n--) {
            u8arr[n] = byteString.charCodeAt(n);
          }
          const blob = new Blob([u8arr], { type: 'image/png' });

          // システムのキャッシュディレクトリへの書き込みなので SYSTEM_PRINCIPAL を使用
          await context.vfs.writeFile(SYSTEM_PRINCIPAL, path, blob, {
            overwrite: true,
            system: true,
          });

          return {
            log: `Captured main process and saved to ${path}`,
            ui: `📸 Screenshot Saved`,
            media: { path: path, mimeType: 'image/png', metadata: {} },
          };
        } catch (e: any) {
          return { log: e.message, ui: `⚠️ Screenshot Failed`, error: true };
        }
      }
      return { log: 'ProcessManager not available.', error: true };
    },
  });

  registry.registerSystemTool(setId, setName, {
    name: 'inject_js',
    description: 'Inject JS to process.',
    impl: async (params: any, context: any) => {
      let pid = params.pid;
      const code = params.content || '';

      if (!pid || pid === 'main') {
        if (context.shell?.processManager) {
          const fg = Array.from(context.shell.processManager.processes.values()).find(
            (p: any) => p.state === 'foreground',
          );
          if (fg) pid = (fg as any).pid;
          else pid = 'app_apps_home_html';
        }
      }
      if (!code.trim()) throw new Error('No code provided.');

      if (context.shell?.processManager) {
        const pm = context.shell.processManager;
        const proc = pm.processes.get(pid);

        if (!proc || !proc.iframe || !proc.iframe.contentWindow) {
          throw new Error(`Target process '${pid}' is not running.`);
        }

        try {
          const transport = context.shell['transport'];
          let result = await transport.invokeGuest(pid, 'eval_js', { code }, proc.iframe.contentWindow);

          let logResult = result;
          if (typeof result === 'object' && result !== null) {
            try {
              logResult = JSON.stringify(result, null, 2);
            } catch (e) {
              logResult = String(result);
            }
          } else if (result === undefined) logResult = 'undefined';

          return {
            log: `Execution result:\n${logResult}`,
            ui: `💉 Injected JS into [${pid}]`,
          };
        } catch (err: any) {
          return {
            log: `Execution error in [${pid}]: ${err.message}`,
            ui: `⚠️ JS Injection Failed`,
            error: true,
          };
        }
      }
      return { log: 'ProcessManager not available.', error: true };
    },
  });
}
