/**
 * src/shell/services/HostGuestToolInvoker.test.ts
 * ゲストの道具を呼んだときの失敗の分け方（T-0677）
 *
 *   ゲストの handler が投げた（RPC の返事が error） … その道具の契約上の答え → ToolError
 *   RPC の timeout・transport の失敗・プロセスが居ない … 経路の失敗 → そのまま（ToolRegistry が赤で出す）
 */

import { describe, it, expect } from 'vitest';
import { HostGuestToolInvoker } from './HostGuestToolInvoker';
import { RpcManager, RpcRemoteError } from '../../ipc/RpcManager';
import { isToolError } from '../../core/control/ToolError';

function invoker(invokeGuest: () => Promise<unknown>) {
  const pm: any = { processes: new Map([['p1', { pid: 'p1', iframe: { contentWindow: {} } }]]) };
  const transport: any = { invokeGuest };
  return new HostGuestToolInvoker(pm, transport);
}

describe('HostGuestToolInvoker: 失敗の分け方', () => {
  it('ゲストが返した error（RpcRemoteError）は ToolError になり、文面はそのまま・元は cause に残る', async () => {
    const inv = invoker(() => Promise.reject(new RpcRemoteError('Tool handler not found: x')));
    const err: any = await inv.invokeTool('p1', 'x', {}).catch((e) => e);
    expect(isToolError(err)).toBe(true);
    expect(err.message).toBe('Tool handler not found: x');
    expect(err.cause).toBeInstanceOf(RpcRemoteError);
  });

  it('timeout など RPC の例外はそのまま投げる', async () => {
    const inv = invoker(() => Promise.reject(new Error('RPC Timeout: Request 1 exceeded 150000ms')));
    const err: any = await inv.invokeTool('p1', 'x', {}).catch((e) => e);
    expect(isToolError(err)).toBe(false);
    expect(err.message).toContain('RPC Timeout');
  });

  it('プロセスが居なければ RPC に出る前にそのまま投げる（ToolError ではない）', async () => {
    const inv = invoker(() => Promise.resolve('never'));
    const err: any = await inv.invokeTool('gone', 'x', {}).catch((e) => e);
    expect(isToolError(err)).toBe(false);
    expect(err.message).toContain("Target process 'gone' is no longer available");
  });

  it('RpcManager: 相手の error の返事は RpcRemoteError、timeout は素の Error', async () => {
    const rpc = new RpcManager(20);
    const p1 = rpc.waitFor('a');
    rpc.resolve('a', null, 'boom');
    const e1: any = await p1.catch((e) => e);
    expect(e1).toBeInstanceOf(RpcRemoteError);
    expect(e1.message).toBe('boom');

    const p2 = rpc.waitFor('b');
    const e2: any = await p2.catch((e) => e);
    expect(e2).not.toBeInstanceOf(RpcRemoteError);
    expect(e2.message).toContain('RPC Timeout');
  });
});
