import { describe, it, expect, vi } from 'vitest';
import { registerSysTools, parsePresentedPaths } from './sys_tools';

/**
 * files 道具（T-0344）: 利用者にファイルを差し出す。
 * 在るものは stat の結果を添えて artifact に、無いものは missing で残して log で AI に返す。
 * 全部無ければ失敗（「差し出した」と言わない）。
 */
function tools() {
  const defs: Record<string, any> = {};
  const registry: any = { registerSystemTool: (_a: string, _b: string, def: any) => (defs[def.name] = def) };
  registerSysTools(registry);
  return defs;
}

function ctx(existing: Record<string, { kind: 'file' | 'directory'; size?: number }>) {
  // 利用者に見せるための読みは、shell が渡す利用者の取っ手で（T-0903）
  const userFs: any = {
    stat: (path: string) => {
      const s = existing[path];
      if (!s) throw new Error(`Not found: ${path}`);
      return { name: path.split('/').pop(), kind: s.kind, size: s.size, path };
    },
  };
  return { shell: { userFs } };
}

describe('parsePresentedPaths', () => {
  it('1 行 1 パス。箇条書きの印・バッククォート・先頭の / を剥がし、空行と重複を捨てる', () => {
    const paths = parsePresentedPaths('- `個人/資料/a.xlsx`\n\n/data/b.md\n* data/b.md\n  data/c.png  \n');
    expect(paths).toEqual(['個人/資料/a.xlsx', 'data/b.md', 'data/c.png']);
  });
});

describe('files', () => {
  it('在るファイルは名前・大きさ付きで artifact に載り、ui は件数を言う', async () => {
    const res = await tools().files.impl(
      { title: '結果', content: 'data/out.xlsx\ndata/dir' },
      ctx({ 'data/out.xlsx': { kind: 'file', size: 2048 }, 'data/dir': { kind: 'directory' } }),
    );
    expect(res.artifact.kind).toBe('files');
    expect(res.artifact.title).toBe('結果');
    expect(res.artifact.files).toEqual([
      { path: 'data/out.xlsx', name: 'out.xlsx', kind: 'file', size: 2048 },
      { path: 'data/dir', name: 'dir', kind: 'directory', size: undefined },
    ]);
    expect(res.ui).toContain('2');
    expect(res.log).toContain('Presented 2');
    expect(res.trigger_llm).toBe(false);
  });

  it('無いパスは missing で残し、log で AI に返す（黙って落とさない）', async () => {
    const res = await tools().files.impl(
      { content: 'data/ok.md\ndata/nope.md' },
      ctx({ 'data/ok.md': { kind: 'file', size: 1 } }),
    );
    expect(res.artifact.files.map((f: any) => !!f.missing)).toEqual([false, true]);
    expect(res.log).toContain('Not found');
    expect(res.log).toContain('data/nope.md');
    expect(res.ui).toContain('(1)');
  });

  it('全部無ければ失敗（「差し出した」と言わない）', async () => {
    await expect(tools().files.impl({ content: 'data/nope.md' }, ctx({}))).rejects.toThrow(/not found/i);
  });

  it('パスが 1 つも無ければ失敗', async () => {
    await expect(tools().files.impl({ content: '\n  \n' }, ctx({}))).rejects.toThrow(/No file path/);
  });
});

describe('reset_session', () => {
  it('呼んだエンジンの会話を空にし、申し送りを添える（shell ではなく会話の口から。T-0903）', async () => {
    const calls: any[] = [];
    const context: any = {
      conversation: {
        reset: async (options: any) => {
          calls.push(options);
        },
      },
    };
    const res = await tools().reset_session.impl({ content: 'carry this' }, context);
    expect(calls).toHaveLength(1);
    expect(calls[0].summary).toContain('[Carried Over Information]\ncarry this');
    expect(calls[0]).toMatchObject({ triggerLlm: true, restoreTools: true });
    expect(res.halt_loop).toBe(true);
  });
});

describe('set_timer', () => {
  it('呼んだエンジンにタイマーを預ける（道具は自分で setTimeout を持たない。T-0903）', async () => {
    const scheduleSystemEvent = vi.fn();
    const res = await tools().set_timer.impl({ delay: '30', message: 'tea' }, { engine: { scheduleSystemEvent } });
    expect(scheduleSystemEvent).toHaveBeenCalledTimes(1);
    expect(scheduleSystemEvent).toHaveBeenCalledWith(30000, 'timer_alert', 'tea');
    expect(res).toEqual({ log: 'Timer set for 30 seconds.', ui: '⏱️ Timer set (30s)', trigger_llm: false });
  });

  it('message を省くと既定の文で預ける', async () => {
    const scheduleSystemEvent = vi.fn();
    await tools().set_timer.impl({ delay: '5' }, { engine: { scheduleSystemEvent } });
    expect(scheduleSystemEvent).toHaveBeenCalledWith(5000, 'timer_alert', 'Timer expired.');
  });

  it('delay が数でない・0 以下なら失敗し、何も預けない', async () => {
    const scheduleSystemEvent = vi.fn();
    for (const delay of ['abc', '0', '-3', undefined]) {
      await expect(tools().set_timer.impl({ delay }, { engine: { scheduleSystemEvent } })).rejects.toThrow(
        /Invalid delay/,
      );
    }
    expect(scheduleSystemEvent).not.toHaveBeenCalled();
  });
});
