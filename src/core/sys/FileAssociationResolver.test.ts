import { describe, it, expect } from 'vitest';
import { FileAssociationResolver } from './FileAssociationResolver';

/**
 * ディレクトリの受け皿（T-0251）
 *
 * 背景:
 *   resolveDefault は名前（拡張子・MIME）しか見ていなかった。ディレクトリを渡すと
 *   拡張子が無ければ HostEditor に落ち、readFile が「Cannot read directory as file」で失敗していた。
 *   PDF の Media Viewer と同じ位置づけで、ディレクトリはホストのエクスプローラパネルを返す。
 */

function make(apps: any[] = []) {
  const vfs: any = { exists: () => false, readFile: async () => '{}' };
  const registry: any = { getApp: (id: string) => apps.find((a) => a.id === id), getAllApps: () => apps };
  const bus: any = { subscribe: () => {} };
  return new FileAssociationResolver(vfs, registry, bus);
}
const stat = (name: string, kind: 'file' | 'directory'): any => ({ name, kind, path: name });

describe('FileAssociationResolver: ディレクトリ', () => {
  it('ディレクトリは HostExplorer（関連付けを引かない）', () => {
    const r = make();
    expect(r.resolveDefault(stat('projects', 'directory')).appId).toBe('HostExplorer');
  });

  it('拡張子つきの名前のディレクトリでもアプリに渡さない', () => {
    const notes = { id: 'notes', path: 'apps/notes.html', name: 'Notes', fileHandlers: [{ extensions: ['md'] }] };
    const r = make([notes]);
    expect(r.resolveDefault(stat('memo.md', 'directory')).appId).toBe('HostExplorer');
    expect(r.resolveDefault(stat('memo.md', 'file')).appId).toBe('notes');
  });

  it('「このプログラムで開く」の候補もエクスプローラだけ', () => {
    const r = make();
    expect(r.resolveAllAvailable(stat('projects', 'directory')).map((a) => a.appId)).toEqual(['HostExplorer']);
  });

  it('拡張子の無いファイルは従来どおり HostEditor', () => {
    const r = make();
    expect(r.resolveDefault(stat('README', 'file')).appId).toBe('HostEditor');
  });
});
