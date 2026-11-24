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

function ctx(kind: 'file' | 'directory', revealResult: boolean | undefined, content: Uint8Array | string = '') {
  const edited: string[] = [];
  const viewed: string[] = [];
  const revealed: string[] = [];
  const shell: any = {
    resolver: {
      resolveDefault: (stat: any) => ({
        appId: stat.kind === 'directory' ? 'HostExplorer' : 'HostEditor',
        appName: 'x',
      }),
    },
    modals: {
      editor: { open: (p: string) => edited.push(p) },
      media: { open: (p: string) => viewed.push(p) },
    },
  };
  if (revealResult !== undefined) {
    shell._revealInExplorer = (p: string) => {
      revealed.push(p);
      return revealResult;
    };
  }
  // 利用者に見せるための読みは、shell が渡す利用者の取っ手で（T-0903）
  shell.userFs = {
    stat: (path: string) => ({ name: path, kind, path }),
    readFile: async () => '',
    readBlob: async () => new Blob([content as unknown as BlobPart]),
  };
  return { context: { shell }, revealed, edited, viewed };
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
    const { context, revealed, edited } = ctx('file', true, '# README\n');
    const res = await tools().open.impl({ path: 'README' }, context);
    expect(revealed).toEqual([]);
    expect(res.ui).toContain('📝');
    expect(edited).toEqual(['README']);
  });

  it('関連付けの無いバイナリ（xlsm の zip 先頭）はエディタに出さず、ビューワー（ダウンロード）へ（T-0389）', async () => {
    const zipHead = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);
    const { context, edited, viewed } = ctx('file', true, zipHead);
    const res = await tools().open.impl({ path: '個人/資料/見積.xlsm' }, context);
    expect(edited).toEqual([]);
    expect(viewed).toEqual(['個人/資料/見積.xlsm']);
    expect(res.ui).toContain('📦');
    expect(res.log).toMatch(/not text/);
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
    // 置き場と書く権限は会話の側（T-0903）。道具は名前と中身を渡すだけ
    conversation: {
      putAttachment: async (name: string) => {
        const path = `system/temp/sessions/s1/${name}`;
        written.push(path);
        return path;
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

/**
 * inject_js: 相手の決め方（T-0903）
 *
 * 守りたいこと:
 *   - pid を渡したらそのプロセス（デーモンでもよい）
 *   - pid を省略（または 'main'）したら前面のアプリ
 *   - 前面のアプリが無いときは、居ない pid を当てずっぽうで指さず、「pid を指定して」と返す
 *   - 中身が空なら、相手を探す前に断る
 */
function injectCtx(procs: Array<{ pid: string; type: string; state: string }>) {
  const calls: Array<{ pid: string; code: string }> = [];
  const processes = new Map(procs.map((p) => [p.pid, { ...p, iframe: { contentWindow: {} } }]));
  const context: any = {
    shell: {
      processManager: { processes },
      transport: {
        invokeGuest: async (pid: string, _method: string, payload: { code: string }) => {
          calls.push({ pid, code: payload.code });
          return 42;
        },
      },
    },
  };
  return { context, calls };
}

const INJECT_PROCS = [
  { pid: 'home', type: 'app', state: 'background' },
  { pid: 'notes', type: 'app', state: 'foreground' },
  { pid: 'loom_daemon', type: 'daemon', state: 'background' },
];
const NO_FOREGROUND = INJECT_PROCS.map((p) => ({ ...p, state: 'background' }));

describe('inject_js: 相手の決め方', () => {
  it('pid を渡すとそのプロセスへ（デーモンでもよい）', async () => {
    const { context, calls } = injectCtx(INJECT_PROCS);
    const res = await tools().inject_js.impl({ pid: 'loom_daemon', content: 'return 1' }, context);
    expect(calls).toEqual([{ pid: 'loom_daemon', code: 'return 1' }]);
    expect(res.log).toContain('42');
    expect(res.ui).toContain('[loom_daemon]');
  });

  it("pid を省略（または 'main'）したら前面のアプリへ", async () => {
    const { context, calls } = injectCtx(INJECT_PROCS);
    await tools().inject_js.impl({ content: 'return 1' }, context);
    await tools().inject_js.impl({ pid: 'main', content: 'return 2' }, context);
    expect(calls.map((c) => c.pid)).toEqual(['notes', 'notes']);
  });

  it('前面のアプリが無ければ、居ない pid を指さずに「pid を指定して」と返す', async () => {
    const { context, calls } = injectCtx(NO_FOREGROUND);
    const err = await tools()
      .inject_js.impl({ content: 'return 1' }, context)
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('ToolError');
    expect((err as Error).message).toBe('No app is in the foreground. Specify pid.');
    expect(calls).toEqual([]);
  });

  it('前面が無くても、pid を渡せば届く', async () => {
    const { context, calls } = injectCtx(NO_FOREGROUND);
    await tools().inject_js.impl({ pid: 'home', content: 'return 1' }, context);
    expect(calls.map((c) => c.pid)).toEqual(['home']);
  });

  it('渡した pid が動いていなければ、その pid の名前で断る', async () => {
    const { context, calls } = injectCtx(INJECT_PROCS);
    await expect(tools().inject_js.impl({ pid: 'nope', content: 'return 1' }, context)).rejects.toThrow(
      "Target process 'nope' is not running.",
    );
    expect(calls).toEqual([]);
  });

  it('中身が空なら、相手を探す前に断る（前面が無くても同じ答え）', async () => {
    const { context } = injectCtx(NO_FOREGROUND);
    await expect(tools().inject_js.impl({ content: '  ' }, context)).rejects.toThrow('No code provided.');
  });
});
