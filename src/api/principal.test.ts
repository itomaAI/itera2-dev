import { describe, expect, it } from 'vitest';
import { resolvePrincipal } from './principal';

function deps(path: string | undefined, service: any) {
  const processes = new Map<string, any>();
  if (path !== undefined) processes.set('d', { pid: 'd', path });
  return {
    processManager: { processes },
    appRegistry: { getService: (id: string) => (id === 'd' ? service : undefined) },
  };
}

describe('resolvePrincipal (T-0617)', () => {
  it('system/ 配下のデーモンで登録簿に systemPrivilege: true があれば system', () => {
    expect(resolvePrincipal('d', deps('system/services/sync.html', { id: 'd', systemPrivilege: true }))).toEqual({
      type: 'system',
      id: 'd',
    });
  });

  it('登録簿の印が無ければ system/ 配下でも app', () => {
    expect(resolvePrincipal('d', deps('system/services/sync.html', { id: 'd' }))).toEqual({ type: 'app', id: 'd' });
    expect(resolvePrincipal('d', deps('system/services/sync.html', { id: 'd', systemPrivilege: false }))).toEqual({
      type: 'app',
      id: 'd',
    });
    expect(resolvePrincipal('d', deps('system/services/sync.html', { id: 'd', systemPrivilege: 'true' }))).toEqual({
      type: 'app',
      id: 'd',
    });
  });

  it('印があっても system/ の外（利用者の置いた HTML）なら app', () => {
    expect(resolvePrincipal('d', deps('user/apps/sync.html', { id: 'd', systemPrivilege: true }))).toEqual({
      type: 'app',
      id: 'd',
    });
  });

  it('プロセスが見つからない・登録簿が無いときは app', () => {
    expect(resolvePrincipal('d', deps(undefined, { id: 'd', systemPrivilege: true }))).toEqual({
      type: 'app',
      id: 'd',
    });
    expect(resolvePrincipal('d', {})).toEqual({ type: 'app', id: 'd' });
    expect(resolvePrincipal('d', { processManager: null, appRegistry: null })).toEqual({ type: 'app', id: 'd' });
  });
});
