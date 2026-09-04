import { describe, it, expect } from 'vitest';
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
  const vfs: any = {
    stat: (_p: any, path: string) => {
      const s = existing[path];
      if (!s) throw new Error(`Not found: ${path}`);
      return { name: path.split('/').pop(), kind: s.kind, size: s.size, path };
    },
  };
  return { vfs };
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
