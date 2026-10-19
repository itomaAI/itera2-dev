/**
 * src/core/vfs/VfsError.test.ts
 * VFS の「拒否」は VfsError（code つき）で投げる（T-0677）
 *
 * 拒否（無い・ある・ディレクトリだ・権限が無い）と故障（OPFS の I/O・内部矛盾）を、受け取る側が型で見分けられること。
 * 文面は従来のまま（ゲストに見える message は変えない）。
 */

import { describe, it, expect } from 'vitest';
import { VfsService } from './VfsService';
import { VfsAuth } from './VfsAuth';
import { VfsError, isVfsError } from './VfsError';
import { AGENT_PRINCIPAL } from './types';

function serviceWith(nodes: Record<string, any>) {
  const svc: any = Object.create(VfsService.prototype);
  svc.pathResolver = { normalizePath: (p: string) => p, getIdByPath: (p: string) => (p in nodes ? p : undefined) };
  svc.nodeStore = { getNode: (id: string) => nodes[id] };
  svc.auth = { checkNodePermission: () => {} };
  svc.providerManager = { fetchContent: async () => false };
  return svc as VfsService;
}

describe('VfsError', () => {
  it('readBlob: 無いパスは ENOENT、ディレクトリは EISDIR、取ってこれない stub は ESTUB。文面は従来どおり', async () => {
    const svc = serviceWith({
      dir: { kind: 'directory', meta: {} },
      'stub.md': { kind: 'file', meta: { syncState: 'stub' } },
    });
    const e1: any = await svc.readBlob(AGENT_PRINCIPAL, 'nope.md').catch((e) => e);
    expect(isVfsError(e1)).toBe(true);
    expect(e1.code).toBe('ENOENT');
    expect(e1.message).toBe('File not found: nope.md');

    const e2: any = await svc.readBlob(AGENT_PRINCIPAL, 'dir').catch((e) => e);
    expect(e2.code).toBe('EISDIR');
    expect(e2.message).toBe('Cannot read directory as file: dir');

    const e3: any = await svc.readBlob(AGENT_PRINCIPAL, 'stub.md').catch((e) => e);
    expect(e3.code).toBe('ESTUB');
  });

  it('VfsAuth: 権限が無ければ EACCES', () => {
    const node = { id: 'n1', name: 'secret.md', acl: { owner: { type: 'user', id: 'u' }, rules: [] } };
    const auth = new VfsAuth({ getNode: () => node } as any);
    let caught: any = null;
    try {
      auth.checkNodePermission(AGENT_PRINCIPAL, 'n1', 'write');
    } catch (e) {
      caught = e;
    }
    expect(isVfsError(caught)).toBe(true);
    expect(caught.code).toBe('EACCES');
    expect(caught.message).toContain('Permission Denied');
  });

  it('VfsError は Error でもある（既存の catch と toThrow は壊れない）。name で見分けられる', () => {
    const e = new VfsError('EEXIST', 'Destination already exists: a');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('VfsError');
    expect(isVfsError({ name: 'VfsError', message: 'x', code: 'ENOENT' })).toBe(true);
    expect(isVfsError(new Error('x'))).toBe(false);
  });
});
