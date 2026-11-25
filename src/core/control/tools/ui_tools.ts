/**
 * src/core/control/tools/ui_tools.ts
 * Itera OS v2: UI & Process Tools
 */

import type { ToolRegistry } from '../ToolRegistry';
import type { ToolContext } from '../ToolContext';
import { isProbablyText, TEXT_SNIFF_BYTES } from '../../sys/textDetect';
import { ToolError, asToolFailure, isToolError } from '../ToolError';

export function registerUITools(registry: ToolRegistry): void {
  const setId = 'system:ui';
  const setName = 'System: Process & UI';

  registry.registerSystemTool(setId, setName, {
    name: 'spawn',
    description: 'Spawn process.',
    impl: async (params: any, context: ToolContext) => {
      const path = params.path;
      if (!path) throw new ToolError("Attribute 'path' is required.");

      const pid = params.pid || undefined;
      const type = params.type || undefined;
      const show = params.show !== 'false'; // default true
      const forceReload = params.force === 'true';

      const args: Record<string, string> = {};
      for (const [k, v] of Object.entries(params)) {
        if (!['pid', 'path', 'type', 'show', 'force', 'content'].includes(k)) {
          args[k] = String(v);
        }
      }

      if (context.shell?.processes) {
        // 起こしたプロセスが仕える先は、取っ手が決める（このエンジン）
        await context.shell.processes.spawn({ pid, path, type, show, forceReload, args });
        return { log: `Process spawn requested for ${path}.`, ui: `🚀 Spawned process` };
      }
      return { log: 'ProcessManager not available.', error: true };
    },
  });

  registry.registerSystemTool(setId, setName, {
    name: 'open',
    description: 'Open a file using default app.',
    impl: async (params: any, context: ToolContext) => {
      const path = params.path;
      if (!path) throw new ToolError("Attribute 'path' is required.");

      if (context.shell?.resolver) {
        try {
          const stat = context.shell.userFs.stat(path);
          const resolvedApp = context.shell.resolver.resolveDefault(stat);

          if (resolvedApp.appId === 'HostExplorer') {
            // ディレクトリの受け皿はホストのエクスプローラパネル（解決器が決める）
            const reveal = context.shell._revealInExplorer;
            if (typeof reveal !== 'function') throw new Error('Explorer is not available.');
            if (!reveal(path)) throw new ToolError(`Directory not found in explorer: ${path}`);
            return { log: `Revealed folder ${path} in Explorer`, ui: `📂 Opened folder` };
          } else if (resolvedApp.appId === 'HostEditor') {
            // 関連付けの無いバイナリ（xlsm など）はエディタに出さず、ビューワー（ダウンロード）へ（T-0389）
            const blob = await context.shell.userFs.readBlob(path);
            const head = new Uint8Array(await blob.slice(0, TEXT_SNIFF_BYTES).arrayBuffer());
            if (!isProbablyText(head)) {
              context.shell.modals.media.open(path, blob);
              return {
                log: `Opened ${path} in Media Viewer (not text; no app is associated, download only)`,
                ui: `📦 Opened Media (download)`,
              };
            }
            context.shell.modals.editor.open(path, await blob.text());
            return {
              log: `Opened ${path} in Host Editor`,
              ui: `📝 Opened Editor`,
            };
          } else if (resolvedApp.appId === 'HostMediaViewer') {
            const blob = await context.shell.userFs.readBlob(path);
            context.shell.modals.media.open(path, blob);
            return {
              log: `Opened ${path} in Media Viewer`,
              ui: `🖼️ Opened Media`,
            };
          } else if (resolvedApp.appId === 'HostRunner') {
            const fullUri = `metaos://run/${path}`;
            await context.shell.processes.spawn({ path, show: true, currentUri: fullUri });
            return {
              log: `Ran ${path}`,
              ui: `🚀 Ran [${path}]`,
            };
          } else {
            const args = { file: path };
            const fullUri = `metaos://open/${path}`;
            // pid を名指ししない: 個体の決め方が、このエンジンから見た「そのアプリ」の個体（無ければ新しい個体）にする
            await context.shell.processes.spawn({
              path: resolvedApp.appPath,
              show: true,
              args,
              currentUri: fullUri,
            });
            return {
              log: `Opened ${path} in ${resolvedApp.appName}`,
              ui: `🚀 Opened [${resolvedApp.appId}]`,
            };
          }
        } catch (e: any) {
          // 開けない理由（VFS の拒否・上で投げた ToolError）はそのまま期待される失敗として返す。
          // それ以外（配線の欠け・起動の中の例外）は実装の例外なので包まずに通す（T-0677）
          const failure = asToolFailure(e);
          if (isToolError(failure))
            throw new ToolError(`Failed to open: ${failure.message}`, { cause: e, code: failure.code });
          throw e;
        }
      }
      return { log: 'Shell not available.', error: true };
    },
  });

  registry.registerSystemTool(setId, setName, {
    name: 'kill',
    description: 'Kill process.',
    impl: async (params: any, context: ToolContext) => {
      const pid = params.pid;
      if (!pid) throw new ToolError("Attribute 'pid' is required.");

      if (context.shell?.processes) {
        const success = context.shell.processes.kill(pid);
        if (success) return { log: `Process terminated.`, ui: `🛑 Killed [${pid}]` };
        return { log: `Process not found or already stopped.`, error: true };
      }
      return { log: 'ProcessManager not available.', error: true };
    },
  });

  registry.registerSystemTool(setId, setName, {
    name: 'ps',
    description: 'List processes.',
    impl: async (params: any, context: ToolContext) => {
      if (context.shell?.processes) {
        // scope="mine": このエンジンに仕えるプロセス（＝動かせるもの）だけ。既定は全部（見るのは全部。T-0912）
        const scope = String(params?.scope || 'all');
        if (scope !== 'all' && scope !== 'mine') {
          throw new ToolError(`Unknown scope "${scope}". Use "all" or "mine".`);
        }
        const mine = scope === 'mine';
        const all = context.shell.processes.list();
        const list = mine ? all.filter((p) => p.mine) : all;
        if (list.length === 0) {
          return { log: mine ? 'No processes serve this engine.' : 'No processes running.', ui: `📊 Process List (0)` };
        }

        // このエンジンに仕えていないプロセスには、仕える先を添える（動かせるのは、自分に仕えるものだけ）
        const logStr = list
          .map(
            (p) =>
              `PID: ${p.pid.padEnd(15)} | Type: ${p.type.padEnd(6)} | State: ${p.state.padEnd(10)} | Path: ${p.path}` +
              (p.mine ? '' : ` | Engine: ${p.engine}`),
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
    impl: async (params: any, context: ToolContext) => {
      const processes = context.shell?.processes;
      if (processes) {
        // pid を省略すれば従来どおり前面のアプリ（T-0350）
        const wanted = String(params?.pid || '').trim();
        const procs = processes.list();

        if (wanted) {
          const proc = procs.find((p) => p.pid === wanted);
          if (!proc) {
            const capturable = procs.filter((p) => p.type !== 'daemon').map((p) => p.pid);
            throw new ToolError(`Process not found: ${wanted}. Capturable apps: ${capturable.join(', ') || '(none)'}`);
          }
          if (proc.type === 'daemon') {
            throw new ToolError(`Cannot capture a daemon (it has no visible window): ${wanted}`);
          }
        }

        // timeout は秒で受ける。既定は ProcessManager 側の 15 秒、上限 60 秒
        const sec = Number(params?.timeout);
        const timeoutMs = Number.isFinite(sec) && sec > 0 ? Math.min(sec, 60) * 1000 : undefined;

        const foreground = procs.find((p) => p.state === 'foreground');
        const target = wanted || foreground?.pid || 'foreground';

        await new Promise((r) => setTimeout(r, 1000)); // Render wait

        try {
          // captureScreenshot はプレーンな Base64 文字列を返す
          const base64 = await processes.capture(wanted || undefined, timeoutMs);

          const timestamp = Date.now();
          const safe = String(target).replace(/[^\w.-]+/g, '_');
          const name = `screenshot_${safe}_${timestamp}.png`;

          // ツールの責任として Blob に変換してから VFS に渡す
          const byteString = atob(base64);
          let n = byteString.length;
          const u8arr = new Uint8Array(n);
          while (n--) {
            u8arr[n] = byteString.charCodeAt(n);
          }
          const blob = new Blob([u8arr], { type: 'image/png' });

          // いまの会話の添付の置き場（`system/temp/sessions/<id>/`。T-0613）へ。置き場と書く権限は会話の側が持つ（T-0903）
          const path = await context.conversation.putAttachment(name, blob);

          return {
            log: `Captured ${target} and saved to ${path}`,
            ui: `📸 Screenshot Saved (${target})`,
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
    impl: async (params: any, context: ToolContext) => {
      let pid = params.pid;
      const code = params.content || '';

      if (!code.trim()) throw new ToolError('No code provided.');

      const processes = context.shell?.processes;
      if (!processes) return { log: 'ProcessManager not available.', error: true };

      // pid を省略すれば前面のアプリ。前面が無いときに、居ない pid を当てずっぽうで指さない（T-0903）
      if (!pid || pid === 'main') {
        const fg = processes.list().find((p) => p.state === 'foreground');
        if (!fg) throw new ToolError('No app is in the foreground. Specify pid.');
        pid = fg.pid;
      }

      try {
        const result = await processes.evalJs(pid, code);

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
        // 相手が居ない・このエンジンからは動かせない（取っ手が断った）は、期待される失敗としてそのまま返す
        if (isToolError(err)) throw err;
        return {
          log: `Execution error in [${pid}]: ${err.message}`,
          ui: `⚠️ JS Injection Failed`,
          error: true,
        };
      }
    },
  });
}
