import { describe, it, expect } from 'vitest';
import {
  ACL_POLICIES,
  BUILTIN_SYSTEM_AREAS,
  aclOfPolicy,
  applyAreaAcls,
  parseAreaAcl,
  resolveAreaAcl,
} from './areaAcl';
import { AGENT_PRINCIPAL, SYSTEM_PRINCIPAL, USER_PRINCIPAL } from './types';
import { normalizeGuestPaths } from '../sys/GuestPaths';

/** 領域の ACL を宣言（acl.json）から組む（T-0614）。 */
describe('aclOfPolicy', () => {
  const perms = (policy: Parameters<typeof aclOfPolicy>[0], who: { type: string; id: string }) =>
    aclOfPolicy(policy).rules.find((r) => r.principal.type === who.type && r.principal.id === who.id)?.permissions;

  it('readonly: 全員 read だけ。open: 利用者 manage、AI とアプリ rw', () => {
    expect(aclOfPolicy('readonly').owner).toEqual(SYSTEM_PRINCIPAL);
    expect(perms('readonly', USER_PRINCIPAL)).toEqual(['read']);
    expect(perms('readonly', AGENT_PRINCIPAL)).toEqual(['read']);
    expect(perms('open', USER_PRINCIPAL)).toEqual(['read', 'write', 'manage']);
    expect(perms('open', AGENT_PRINCIPAL)).toEqual(['read', 'write']);
    expect(perms('open', { type: 'any', id: '*' })).toEqual(['read', 'write']);
  });

  it('agent-only: AI が持ち主で他は read。agent-shared: 利用者とアプリも書ける', () => {
    expect(aclOfPolicy('agent-only').owner).toEqual(AGENT_PRINCIPAL);
    expect(perms('agent-only', AGENT_PRINCIPAL)).toEqual(['read', 'write', 'manage']);
    expect(perms('agent-only', { type: 'any', id: '*' })).toEqual(['read']);
    expect(perms('agent-only', USER_PRINCIPAL)).toBeUndefined();
    expect(perms('agent-shared', USER_PRINCIPAL)).toEqual(['read', 'write']);
    expect(perms('agent-shared', { type: 'any', id: '*' })).toEqual(['read', 'write']);
  });

  it('語彙は 4 つ', () => {
    expect(ACL_POLICIES).toEqual(['readonly', 'open', 'agent-only', 'agent-shared']);
  });
});

describe('parseAreaAcl', () => {
  it('path か ref のどちらか 1 つと、知っている policy が要る。壊れた行は捨てて理由を残す', () => {
    const r = parseAreaAcl({
      areas: [
        { path: 'system', policy: 'readonly' },
        { ref: 'agent.home', policy: 'agent-only' },
        { path: 'x', ref: 'agent.home', policy: 'open' },
        { policy: 'open' },
        { path: 'y', policy: 'root' },
        'junk',
      ],
    });
    expect(r.entries).toEqual([
      { path: 'system', policy: 'readonly' },
      { ref: 'agent.home', policy: 'agent-only' },
    ]);
    expect(r.problems).toEqual([
      'areas[2]: exactly one of path / ref is required',
      'areas[3]: exactly one of path / ref is required',
      expect.stringMatching(/^areas\[4\]: unknown policy "root"/),
      'areas[5]: not an object',
    ]);
  });

  it('形が違えば空の並びと理由', () => {
    expect(parseAreaAcl(null)).toEqual({ entries: [], problems: ['acl is not an object'] });
    expect(parseAreaAcl({ areas: {} })).toEqual({ entries: [], problems: ['acl.areas is not an array'] });
  });
});

describe('resolveAreaAcl', () => {
  const paths = normalizeGuestPaths({ agent: { home: 'memory', scratch: null } }).paths;

  it('ref は paths の値に解く。先が null なら飛ばし、知らない ref は理由に残す。順序は宣言のまま', () => {
    const r = resolveAreaAcl(
      [
        { path: 'system', policy: 'readonly' },
        { ref: 'agent.scratch', policy: 'agent-shared' },
        { ref: 'agent.home', policy: 'agent-only' },
        { ref: 'agent.bogus', policy: 'open' },
        { path: '/system/config/', policy: 'open' },
      ],
      paths,
    );
    expect(r.areas.map((a) => [a.path, a.policy])).toEqual([
      ['system', 'readonly'],
      ['memory', 'agent-only'],
      ['system/config', 'open'],
    ]);
    expect(r.problems).toEqual(['unknown ref "agent.bogus"']);
  });

  it('組み込みの既定は system/ の守りだけ（ゲスト空間のことは知らない）', () => {
    expect(BUILTIN_SYSTEM_AREAS.every((e) => e.path?.startsWith('system'))).toBe(true);
    expect(BUILTIN_SYSTEM_AREAS[0]).toEqual({ path: 'system', policy: 'readonly' });
  });
});

describe('applyAreaAcls', () => {
  it('在る場所にだけ、並びの順で当てる', async () => {
    const calls: string[] = [];
    const vfs = {
      exists: (_p: unknown, path: string) => path !== 'missing',
      setAclRecursive: async (_p: unknown, path: string) => {
        calls.push(path);
      },
    };
    const paths = normalizeGuestPaths({ agent: { home: 'memory' } }).paths;
    const { areas } = resolveAreaAcl(
      [
        { path: 'system', policy: 'readonly' },
        { path: 'missing', policy: 'open' },
        { ref: 'agent.home', policy: 'agent-only' },
      ],
      paths,
    );
    const applied = await applyAreaAcls(vfs as never, areas);
    expect(applied).toEqual(['system', 'memory']);
    expect(calls).toEqual(['system', 'memory']);
  });
});
