import { describe, it, expect } from 'vitest';
import { registerUITools } from './ui_tools';
import { ToolError } from '../ToolError';

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
  const context: any = {
    shell: {
      // プロセスの口は、エンジンごとの取っ手（T-0908）。この道具が使うのは、一覧と撮る口
      processes: {
        list: () => procs,
        capture: async (pid?: string, timeoutMs?: number) => {
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
  /** 取っ手が断る理由（在れば、その ToolError を投げる）と、中のコードの失敗（在れば、ふつうの例外を投げる） */
  const fail: { refuse: string | null; crash: string | null } = { refuse: null, crash: null };
  const context: any = {
    shell: {
      // 相手が居るか・このエンジンから動かせるかを決めるのは取っ手（engineProcesses.ts。T-0908）。ここは、居なければ断る偽物
      processes: {
        list: () => procs,
        evalJs: async (pid: string, code: string) => {
          if (!procs.some((p) => p.pid === pid)) throw new ToolError(`Target process '${pid}' is not running.`);
          if (fail.refuse) throw new ToolError(fail.refuse);
          if (fail.crash) throw new Error(fail.crash);
          calls.push({ pid, code });
          return 42;
        },
      },
    },
  };
  return { context, calls, fail };
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

  it('取っ手が断ったら（このエンジンからは動かせない）、そのまま期待される失敗として返す', async () => {
    const { context, calls, fail } = injectCtx(INJECT_PROCS);
    fail.refuse = 'Process "home" serves another engine ("root"). This engine cannot run code in it.';
    const err = await tools()
      .inject_js.impl({ pid: 'home', content: 'return 1' }, context)
      .catch((e: Error) => e);
    expect((err as Error).name).toBe('ToolError');
    expect((err as Error).message).toBe(fail.refuse);
    expect(calls).toEqual([]);
  });

  it('中で走らせたコードの失敗は、失敗の結果として返す（例外にしない）', async () => {
    const { context, fail } = injectCtx(INJECT_PROCS);
    fail.crash = 'boom';
    const res = await tools().inject_js.impl({ pid: 'home', content: 'throw 1' }, context);
    expect(res).toEqual({ log: 'Execution error in [home]: boom', ui: '⚠️ JS Injection Failed', error: true });
  });
});

/**
 * spawn・open・kill・ps: プロセスの口は、エンジンごとの取っ手（T-0908）
 *
 * 守りたいこと:
 *   - 道具は仕える先を渡さない（取っ手が、呼んだエンジンにする）
 *   - open は pid を名指ししない（どの個体かは、個体の決め方が決める）
 *   - 取っ手が断ったら、そのまま期待される失敗になる
 *   - ps は、このエンジンに仕えていないプロセスにだけ、仕える先を添える
 */
function procCtx(list: any[] = []) {
  const spawned: any[] = [];
  const killed: string[] = [];
  const fail: { refuse: string | null } = { refuse: null };
  const context: any = {
    shell: {
      processes: {
        spawn: async (options: any) => {
          if (fail.refuse) throw new ToolError(fail.refuse);
          spawned.push(options);
        },
        kill: (pid: string) => {
          if (fail.refuse) throw new ToolError(fail.refuse);
          killed.push(pid);
          return list.some((p) => p.pid === pid);
        },
        list: () => list,
      },
      resolver: {
        resolveDefault: (stat: any) =>
          stat.name.endsWith('.html')
            ? { appId: 'HostRunner', appName: 'Runner' }
            : { appId: 'notes', appName: 'Notes', appPath: 'system/apps/notes.html' },
      },
      userFs: { stat: (path: string) => ({ name: path, kind: 'file', path }) },
    },
  };
  return { context, spawned, killed, fail };
}

const toolError = async (p: Promise<unknown>) => {
  const e = (await p.then(
    () => null,
    (err: Error) => err,
  )) as Error | null;
  return e && { name: e.name, message: e.message };
};

describe('spawn・open・kill・ps: プロセスの口は取っ手', () => {
  it('spawn は名指しの pid・種類・引数を渡す。仕える先は渡さない', async () => {
    const { context, spawned } = procCtx();
    const res = await tools().spawn.impl(
      { path: 'data/x.html', pid: 'x', type: 'daemon', show: 'false', force: 'true', file: 'a.md', content: 'ignored' },
      context,
    );
    expect(spawned).toEqual([
      { pid: 'x', path: 'data/x.html', type: 'daemon', show: false, forceReload: true, args: { file: 'a.md' } },
    ]);
    expect(res).toEqual({ log: 'Process spawn requested for data/x.html.', ui: '🚀 Spawned process' });
  });

  it('spawn の既定: 名前なし・表示する・起こし直さない', async () => {
    const { context, spawned } = procCtx();
    await tools().spawn.impl({ path: 'data/x.html' }, context);
    expect(spawned).toEqual([
      { pid: undefined, path: 'data/x.html', type: undefined, show: true, forceReload: false, args: {} },
    ]);
  });

  it('取っ手が断った spawn（ほかのエンジンのプロセスの名指し・窓の上限）は、期待される失敗', async () => {
    const { context, fail } = procCtx();
    fail.refuse = 'Engine "eng-a" already has 4 app windows (limit 4). Close one first.';
    expect(await toolError(tools().spawn.impl({ path: 'data/x.html' }, context))).toEqual({
      name: 'ToolError',
      message: fail.refuse,
    });
  });

  it('open は、関連付けで決まったアプリのパスを渡す。pid は名指ししない', async () => {
    const { context, spawned } = procCtx();
    const res = await tools().open.impl({ path: 'data/a.md' }, context);
    expect(spawned).toEqual([
      {
        path: 'system/apps/notes.html',
        show: true,
        args: { file: 'data/a.md' },
        currentUri: 'metaos://open/data/a.md',
      },
    ]);
    expect(res.log).toBe('Opened data/a.md in Notes');
  });

  it('open で HTML を走らせるときは、名前を渡さない', async () => {
    const { context, spawned } = procCtx();
    await tools().open.impl({ path: 'data/t.html' }, context);
    expect(spawned).toEqual([{ path: 'data/t.html', show: true, currentUri: 'metaos://run/data/t.html' }]);
  });

  it('open を取っ手が断ったら、「開けなかった」理由として返す', async () => {
    const { context, fail } = procCtx();
    fail.refuse = 'Engine "eng-a" already has 4 app windows (limit 4). Close one first.';
    expect(await toolError(tools().open.impl({ path: 'data/a.md' }, context))).toEqual({
      name: 'ToolError',
      message: `Failed to open: ${fail.refuse}`,
    });
  });

  it('kill: 終われば成功・居なければ失敗の結果・取っ手が断ればそのまま', async () => {
    const { context, killed, fail } = procCtx([{ pid: 'a' }]);
    expect(await tools().kill.impl({ pid: 'a' }, context)).toEqual({ log: 'Process terminated.', ui: '🛑 Killed [a]' });
    expect(await tools().kill.impl({ pid: 'zz' }, context)).toEqual({
      log: 'Process not found or already stopped.',
      error: true,
    });
    expect(killed).toEqual(['a', 'zz']);

    fail.refuse = 'Process "a" serves another engine ("root"). This engine cannot kill it.';
    expect(await toolError(tools().kill.impl({ pid: 'a' }, context))).toEqual({
      name: 'ToolError',
      message: fail.refuse,
    });
  });

  it('ps: このエンジンに仕えていないプロセスにだけ、仕える先を添える', async () => {
    const line = (pid: string, type: string, state: string, path: string) =>
      `PID: ${pid.padEnd(15)} | Type: ${type.padEnd(6)} | State: ${state.padEnd(10)} | Path: ${path}`;
    const { context } = procCtx([
      { pid: 'home', type: 'app', state: 'foreground', path: 'system/apps/home.html', engine: 'eng-a', mine: true },
      { pid: 'notes', type: 'app', state: 'background', path: 'system/apps/notes.html', engine: 'root', mine: false },
    ]);
    expect(await tools().ps.impl({}, context)).toEqual({
      log:
        line('home', 'app', 'foreground', 'system/apps/home.html') +
        '\n' +
        line('notes', 'app', 'background', 'system/apps/notes.html') +
        ' | Engine: root',
      ui: '📊 Process List (2)',
    });
    expect(await tools().ps.impl({}, procCtx().context)).toEqual({
      log: 'No processes running.',
      ui: '📊 Process List (0)',
    });
  });

  it('ps scope="mine": このエンジンに仕えるプロセスだけ。既定（と "all"）は全部。知らない値は断る', async () => {
    const line = (pid: string, type: string, state: string, path: string) =>
      `PID: ${pid.padEnd(15)} | Type: ${type.padEnd(6)} | State: ${state.padEnd(10)} | Path: ${path}`;
    const list = [
      { pid: 'home', type: 'app', state: 'foreground', path: 'system/apps/home.html', engine: 'eng-a', mine: true },
      { pid: 'notes', type: 'app', state: 'background', path: 'system/apps/notes.html', engine: 'root', mine: false },
    ];
    expect(await tools().ps.impl({ scope: 'mine' }, procCtx(list).context)).toEqual({
      log: line('home', 'app', 'foreground', 'system/apps/home.html'),
      ui: '📊 Process List (1)',
    });
    expect(await tools().ps.impl({ scope: 'all' }, procCtx(list).context)).toEqual(
      await tools().ps.impl({}, procCtx(list).context),
    );
    expect(await tools().ps.impl({ scope: 'mine' }, procCtx([list[1]]).context)).toEqual({
      log: 'No processes serve this engine.',
      ui: '📊 Process List (0)',
    });
    expect(await toolError(tools().ps.impl({ scope: 'theirs' }, procCtx(list).context))).toEqual({
      name: 'ToolError',
      message: 'Unknown scope "theirs". Use "all" or "mine".',
    });
  });
});
