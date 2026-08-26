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
