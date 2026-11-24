/**
 * src/core/vfs/distributionTestKit.ts
 * 試験用: パス → ノード（種類・ACL・中身）の小さな木。`exists`／`stat`／`readFile` だけを持つ（T-0904）。
 * 配信物の判定（distribution.ts）と、それを使う側（PrivilegeTable・SyncAdapterHost）の試験が使う。
 */
import { aclOfPolicy } from './areaAcl';
import type { AccessControlList } from './types';

export type FakePolicy = 'readonly' | 'open' | 'agent-only' | 'agent-shared';
export interface FakeNode {
  kind: 'file' | 'directory';
  /** null は「ACL の無い古いノード」 */
  acl: AccessControlList | null;
  text?: string;
}

export const dir = (policy: FakePolicy): FakeNode => ({ kind: 'directory', acl: aclOfPolicy(policy) });
export const file = (policy: FakePolicy, text = ''): FakeNode => ({ kind: 'file', acl: aclOfPolicy(policy), text });

const clean = (path: string) => String(path).replace(/^\/+|\/+$/g, '');

export function fakeTree(nodes: Record<string, FakeNode>) {
  const reads: string[] = [];
  return {
    nodes,
    /** readFile で読まれたパス（順に） */
    reads,
    exists: (_principal: unknown, path: string): boolean => clean(path) in nodes,
    stat: (_principal: unknown, path: string) => {
      const node = nodes[clean(path)];
      if (!node) throw new Error(`File or directory not found: ${path}`);
      return { path: clean(path), kind: node.kind, acl: node.acl };
    },
    readFile: async (_principal: unknown, path: string): Promise<string> => {
      reads.push(clean(path));
      const node = nodes[clean(path)];
      if (!node || node.kind !== 'file') throw new Error(`File not found: ${path}`);
      return node.text ?? '';
    },
  };
}
