/**
 * src/api/LlmCalls.ts
 * Itera OS v2: MetaOS.llm の実体 —— 走っている呼び出しの表（T-0807）
 *
 * 1 回の呼び出し:
 *   設定 → 上流への一組（`resolveLlm`。エンジンと同じ組み立て）→ 本文（Renderer。添付は**呼んだゲストの権限**で読む）
 *   → 送信（Adapter）→ 文字は `llm:chunk`、終わりは `llm:end`、失敗は `llm:error` を**呼んだプロセスにだけ**通知する。
 *
 * 開始の RPC は待たせない。ゲストの RPC は 150 秒で切れるが、生成は考えているだけで何分も黙ることがあるため、
 * 返事は通知で運ぶ。止めるのは `abort`（呼び手）と `abortAll`（プロセスが終わったとき）。
 *
 * ここは会話（履歴）に触らない。台帳には Adapter の入口が `caller: 呼んだ pid` で 1 行書く。
 * 送れない添付は注記に替えずに失敗させる（`mediaFallback` を渡さない）—— 黙って落とすと、呼び手は気づけない。
 */

import type { LlmRequest, RenderEnv } from '../core/cognitive/LlmRequest';
import type { LlmCallOrigin, LlmResult } from '../core/cognitive/adapters/BaseAdapter';
import type { VfsService } from '../core/vfs/VfsService';
import type { Principal } from '../core/vfs/types';
import { buildLlmCall, llmErrorOf, type LlmCallPlan } from './llmApi';

/** 上流への一組のうち、ここが使う面（`CognitiveManager.resolveLlm` が返すものが満たす） */
export interface LlmEndpointLike {
  renderer: { render(request: LlmRequest, env: RenderEnv): Promise<any> };
  adapter: {
    generateStream(
      body: any,
      onChunk: (text: string) => void,
      signal?: AbortSignal,
      origin?: LlmCallOrigin,
    ): Promise<LlmResult>;
  };
}

export type LlmEventAction = 'llm:chunk' | 'llm:end' | 'llm:error';

export interface LlmCallsDeps {
  resolveLlm(config: { model: string; [key: string]: unknown }): Promise<LlmEndpointLike>;
  vfs: VfsService;
  /** 呼んだプロセスへ通知する。相手がもう居なければ何もしない */
  send(pid: string, action: LlmEventAction, payload: unknown): void;
}

interface Running {
  abort: AbortController;
  done: Promise<void>;
}

export class LlmCalls {
  private readonly deps: LlmCallsDeps;
  private readonly running = new Map<string, Running>();

  constructor(deps: LlmCallsDeps) {
    this.deps = deps;
  }

  private key(pid: string, id: string): string {
    return `${pid}\u0000${id}`;
  }

  /**
   * 呼び出しを始める。要求が形として受けられなければ投げる（開始の RPC がそのまま失敗する）。
   * 返る `done` は、通知を出し終えたときに解決する（試験用。ルーターは待たない）。
   */
  start(pid: string, principal: Principal, payload: unknown): { id: string; done: Promise<void> } {
    const plan = buildLlmCall(payload);
    if (!plan.ok) throw new Error(`MetaOS.llm.generate: ${plan.reason}`);
    const key = this.key(pid, plan.id);
    if (this.running.has(key)) throw new Error('MetaOS.llm.generate: a call with this id is already running');

    // 先に表へ載せる（走り出しが同期に失敗しても、片付けが載せる前に走らないように）
    const entry: Running = { abort: new AbortController(), done: Promise.resolve() };
    this.running.set(key, entry);
    entry.done = this.run(pid, principal, plan, entry.abort.signal).finally(() => {
      this.running.delete(key);
    });
    return { id: plan.id, done: entry.done };
  }

  private async run(pid: string, principal: Principal, plan: LlmCallPlan, signal: AbortSignal): Promise<void> {
    const stopped = () => {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    };
    try {
      const endpoint = await this.deps.resolveLlm(plan.config);
      stopped();
      const body = await endpoint.renderer.render(plan.request, { vfs: this.deps.vfs, principal, signal });
      stopped();
      const result = await endpoint.adapter.generateStream(
        body,
        (text) => {
          // 止めたあとに届いた塊は運ばない
          if (!signal.aborted) this.deps.send(pid, 'llm:chunk', { id: plan.id, text });
        },
        signal,
        { caller: pid, tag: plan.tag },
      );
      stopped();
      this.deps.send(pid, 'llm:end', { id: plan.id, result });
    } catch (err) {
      this.deps.send(pid, 'llm:error', { id: plan.id, ...llmErrorOf(err, signal.aborted) });
    }
  }

  /** 呼び手が止める。その pid の、その id だけ（他のプロセスの呼び出しは止められない） */
  abort(pid: string, id: unknown): boolean {
    if (typeof id !== 'string') return false;
    const call = this.running.get(this.key(pid, id));
    if (!call) return false;
    call.abort.abort();
    return true;
  }

  /** プロセスが終わった。その pid の呼び出しを全部止める（上流への接続を残さない） */
  abortAll(pid: string): number {
    let n = 0;
    const prefix = `${pid}\u0000`;
    for (const [key, call] of this.running) {
      if (!key.startsWith(prefix)) continue;
      call.abort.abort();
      n += 1;
    }
    return n;
  }

  /** 走っている呼び出しの数 */
  count(): number {
    return this.running.size;
  }
}
