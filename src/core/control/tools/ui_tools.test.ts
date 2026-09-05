import { describe, it, expect } from 'vitest';
import { registerUITools } from './ui_tools';

/**
 * open 道具: ディレクトリ（T-0251）
 *
 * 解決器が HostExplorer を返したら、シェルの _revealInExplorer に渡す。
 * 見つからなければ例外（「開いた」と言わない）。
 */
function tools() {
  const defs: Record<string, any> = {};
  const registry: any = { registerSystemTool: (_a: string, _b: string, def: any) => (defs[def.name] = def) };
  registerUITools(registry);
  return defs;
}

function ctx(kind: 'file' | 'directory', revealResult: boolean | undefined) {
  const revealed: string[] = [];
  const shell: any = {
    resolver: {
      resolveDefault: (stat: any) => ({
        appId: stat.kind === 'directory' ? 'HostExplorer' : 'HostEditor',
        appName: 'x',
      }),
    },
    modals: { editor: { open: () => {} } },
  };
  if (revealResult !== undefined) {
    shell._revealInExplorer = (p: string) => {
      revealed.push(p);
      return revealResult;
    };
  }
  const vfs: any = { stat: (_p: any, path: string) => ({ name: path, kind, path }), readFile: async () => '' };
  return { context: { shell, vfs }, revealed };
}

describe('open: ディレクトリ', () => {
  it('HostExplorer なら _revealInExplorer に渡し、📂 を返す', async () => {
    const { context, revealed } = ctx('directory', true);
    const res = await tools().open.impl({ path: 'data/apps' }, context);
    expect(revealed).toEqual(['data/apps']);
    expect(res.ui).toContain('📂');
  });

  it('木に無ければ例外（「開いた」と言わない）', async () => {
    const { context } = ctx('directory', false);
    await expect(tools().open.impl({ path: 'nope' }, context)).rejects.toThrow(/not found/);
  });

  it('エクスプローラが無い環境でも黙って成功しない', async () => {
    const { context } = ctx('directory', undefined);
    await expect(tools().open.impl({ path: 'data' }, context)).rejects.toThrow(/Explorer/);
  });

  it('ファイルは従来どおり（エディタへ）', async () => {
    const { context, revealed } = ctx('file', true);
    const res = await tools().open.impl({ path: 'README' }, context);
    expect(revealed).toEqual([]);
    expect(res.ui).toContain('📝');
  });
});

/**
 * take_screenshot: pid を指定して撮る（T-0350）
 *
 * 守りたいこと:
 *   - pid を省略したら従来どおり前面のアプリ（後方互換）
 *   - pid を渡したらそのプロセス。保存名にも pid が入る
 *   - 知らない pid・デーモンは「撮った」と言わずに止まる（候補を添える）
 *   - timeout は秒で受け、ミリ秒にして渡す（上限 60 秒）
 */
function shotCtx(procs: Array<{ pid: string; type: string; state: string }>) {
  const calls: Array<{ pid: string | undefined; timeoutMs: number | undefined }> = [];
  const written: string[] = [];
  const processes = new Map(procs.map((p) => [p.pid, p]));
  const context: any = {
    shell: {
      processManager: {
        processes,
        captureScreenshot: async (pid?: string, timeoutMs?: number) => {
          calls.push({ pid, timeoutMs });
          return 'QUJD'; // "ABC"
        },
      },
    },
    vfs: {
      writeFile: async (_pr: unknown, path: string) => {
        written.push(path);
        return 'ok';
      },
    },
  };
  return { context, calls, written };
}

const APPS = [
  { pid: 'app_home', type: 'app', state: 'foreground' },
  { pid: 'notes', type: 'app', state: 'background' },
  { pid: 'telegram_daemon', type: 'daemon', state: 'running' },
];

describe('take_screenshot: pid 指定', () => {
  it('pid を省略したら前面のアプリ（従来どおり）', async () => {
    const { context, calls, written } = shotCtx(APPS);
    const res = await tools().take_screenshot.impl({}, context);
    expect(calls).toEqual([{ pid: undefined, timeoutMs: undefined }]);
    expect(res.ui).toContain('app_home');
    expect(written[0]).toContain('screenshot_app_home_');
  });

  it('pid を渡すとそのプロセスを撮り、保存名にも入る', async () => {
    const { context, calls, written } = shotCtx(APPS);
    const res = await tools().take_screenshot.impl({ pid: 'notes' }, context);
    expect(calls[0].pid).toBe('notes');
    expect(res.ui).toContain('notes');
    expect(written[0]).toContain('screenshot_notes_');
  });

  it('背景のアプリも撮れる（前面/背景は z-index の違いでしかない）', async () => {
    const { context, calls } = shotCtx(APPS);
    await tools().take_screenshot.impl({ pid: 'notes' }, context);
    expect(calls[0].pid).toBe('notes');
  });

  it('知らない pid は「撮った」と言わずに止まり、候補を添える', async () => {
    const { context, calls } = shotCtx(APPS);
    await expect(tools().take_screenshot.impl({ pid: 'nope' }, context)).rejects.toThrow(/Process not found/);
    await expect(tools().take_screenshot.impl({ pid: 'nope' }, context)).rejects.toThrow(/app_home, notes/);
    expect(calls).toEqual([]);
  });

  it('デーモンは窓を持たないので撮れない', async () => {
    const { context, calls } = shotCtx(APPS);
    await expect(tools().take_screenshot.impl({ pid: 'telegram_daemon' }, context)).rejects.toThrow(/daemon/);
    expect(calls).toEqual([]);
  });

  it('timeout は秒で受け、ミリ秒にして渡す（上限 60 秒）', async () => {
    const a = shotCtx(APPS);
    await tools().take_screenshot.impl({ pid: 'notes', timeout: '30' }, a.context);
    expect(a.calls[0].timeoutMs).toBe(30000);

    const b = shotCtx(APPS);
    await tools().take_screenshot.impl({ pid: 'notes', timeout: '600' }, b.context);
    expect(b.calls[0].timeoutMs).toBe(60000);

    const c = shotCtx(APPS);
    await tools().take_screenshot.impl({ pid: 'notes', timeout: 'abc' }, c.context);
    expect(c.calls[0].timeoutMs).toBeUndefined();
  });
});
