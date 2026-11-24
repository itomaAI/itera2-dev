/**
 * 「配信物である」＝ readonly の領域に在るファイル（T-0904）。
 * 名前（`system/` で始まる）ではなく、ノードに掛かっている ACL で決まること。
 */
import { describe, expect, it } from 'vitest';
import { isDistributionFile, isReadonlyAcl } from './distribution';
import { aclOfPolicy } from './areaAcl';
import { dir, fakeTree, file } from './distributionTestKit';

describe('isReadonlyAcl', () => {
  it('方針 readonly の ACL だけが readonly', () => {
    expect(isReadonlyAcl(aclOfPolicy('readonly'))).toBe(true);
    for (const policy of ['open', 'agent-only', 'agent-shared'] as const) {
      expect(isReadonlyAcl(aclOfPolicy(policy)), policy).toBe(false);
    }
  });

  it('ACL の無い古いノードは誰でも書けるので readonly ではない', () => {
    expect(isReadonlyAcl(null)).toBe(false);
    expect(isReadonlyAcl(undefined)).toBe(false);
  });

  it('持ち主が system でなければ readonly ではない（持ち主は全権を持つ）', () => {
    const acl = aclOfPolicy('readonly');
    expect(isReadonlyAcl({ ...acl, owner: { type: 'app', id: 'x' } })).toBe(false);
    expect(isReadonlyAcl({ ...acl, owner: { type: 'agent', id: 'Itera_AI' } })).toBe(false);
    // system の主体なら id は問わない
    expect(isReadonlyAcl({ ...acl, owner: { type: 'system', id: 'firebase_sync' } })).toBe(true);
  });

  it('read のほかの権限が 1 つでも在れば readonly ではない', () => {
    const acl = aclOfPolicy('readonly');
    expect(
      isReadonlyAcl({ ...acl, rules: [...acl.rules, { principal: { type: 'app', id: 'x' }, permissions: ['write'] }] }),
    ).toBe(false);
    expect(
      isReadonlyAcl({ ...acl, rules: [{ principal: { type: 'user', id: 'local_user' }, permissions: ['manage'] }] }),
    ).toBe(false);
    expect(isReadonlyAcl({ ...acl, rules: [] })).toBe(true);
  });
});

describe('isDistributionFile', () => {
  const tree = () =>
    fakeTree({
      system: dir('readonly'),
      'system/services': dir('readonly'),
      'system/services/sync.html': file('readonly'),
      'system/temp': dir('open'),
      'system/temp/evil.html': file('open'),
      'system/temp/planted.html': file('readonly'),
      'system/registry': dir('open'),
      'system/registry/adapters.json': file('open'),
      memory: dir('agent-only'),
      'memory/x.html': file('agent-only'),
      'top.html': file('readonly'),
    });

  it('readonly の領域のファイルは配信物', () => {
    expect(isDistributionFile(tree(), 'system/services/sync.html')).toBe(true);
    expect(isDistributionFile(tree(), '/system/services/sync.html')).toBe(true);
  });

  it('`system/` の下でも、誰でも書ける領域のファイルは配信物ではない', () => {
    expect(isDistributionFile(tree(), 'system/temp/evil.html')).toBe(false);
    expect(isDistributionFile(tree(), 'system/registry/adapters.json')).toBe(false);
  });

  it('ファイルが readonly でも、置いてあるディレクトリが書けるなら配信物ではない', () => {
    expect(isDistributionFile(tree(), 'system/temp/planted.html')).toBe(false);
  });

  it('AI の領域・ルート直下・ディレクトリ・無いパス・空は配信物ではない', () => {
    expect(isDistributionFile(tree(), 'memory/x.html')).toBe(false);
    expect(isDistributionFile(tree(), 'top.html')).toBe(false);
    expect(isDistributionFile(tree(), 'system/services')).toBe(false);
    expect(isDistributionFile(tree(), 'system/services/none.html')).toBe(false);
    expect(isDistributionFile(tree(), '')).toBe(false);
  });

  it('ACL の無い古いノードは配信物ではない', () => {
    const t = tree();
    t.nodes['system/services/sync.html'].acl = null;
    expect(isDistributionFile(t, 'system/services/sync.html')).toBe(false);
  });

  it('`..` を含む書き方でも、解いた先のファイルとその親で決まる', () => {
    const t = tree();
    const { exists, stat } = t;
    // `..` を解く VFS の形: `system/services/../temp/planted.html` は `system/temp/planted.html`、`system/services/..` は `system`
    const solve = (path: string) => {
      const out: string[] = [];
      for (const part of path.split('/')) {
        if (part === '..') out.pop();
        else if (part) out.push(part);
      }
      return out.join('/');
    };
    t.exists = (p: unknown, path: string) => exists(p, solve(path));
    t.stat = (p: unknown, path: string) => stat(p, solve(path));
    expect(isDistributionFile(t, 'system/services/../temp/planted.html')).toBe(false);
    expect(isDistributionFile(t, 'system/temp/../services/sync.html')).toBe(true);
  });

  it('VFS が投げても false（判定で落ちない）', () => {
    const broken = {
      exists: () => true,
      stat: () => {
        throw new Error('boom');
      },
    };
    expect(isDistributionFile(broken, 'system/services/sync.html')).toBe(false);
  });
});
