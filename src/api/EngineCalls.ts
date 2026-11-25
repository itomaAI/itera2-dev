/**
 * src/api/EngineCalls.ts
 * MetaOS.engine の実体 —— 持ち主のプロセスが、自分のエンジンに働きかける口（T-0908）。
 *
 * 動詞は MetaOS.chat と同じ（append・wake・stop・reset・status）で、規則も同じもの（chatApi.ts・chatPost.ts）を通る。
 * 違うのは相手の決め方だけ: chat は「呼んだプロセスが仕えるエンジン」、ここは「呼んだプロセスが持っているエンジン」を
 * id で指す。持ち主でない者には、在るかどうかも答えない（束の表の of）。
 *
 * 持ち主にだけ在るもの:
 *   turns   … 会話の全文（描くため）
 *   save    … 会話を文書として VFS に書く（書くのは呼び手の権限。書式は OS のチャットの保存と同じ）
 *   dispose … 畳む（仕えていたプロセスも終わる）
 *   list    … 自分が持っているエンジン
 *   知らせ  … 束の表が出すもの（onOwnerEvent）を、持ち主のプロセスにだけ `engine:event` として送る
 *              （MetaOS.llm の文字と同じ道。生成は何分も黙ることがあるので、RPC の返事では運ばない）
 *
 * ここは束を作らない・畳まない（束の表の仕事）。ゲストへ届く形を決めるだけ。
 */

import type { Turn } from '../core/state/HistoryManager';
import type { StopOptions } from '../core/control/Engine';
import type { Principal } from '../core/vfs/types';
import type { VfsService } from '../core/vfs/VfsService';
import {
  buildChatStatus,
  buildResetPlan,
  type ChatAppendRequest,
  type ChatResetOpts,
  type ChatStatus,
  type ChatStatusInput,
} from './chatApi';
import { postToBundle, type Caller, type PostTarget } from './chatPost';

/** 束の表が返すエンジンのうち、ここが使う面（EngineManager の SubEngine が満たす） */
export interface OwnedEngine {
  readonly id: string;
  readonly bundle: PostTarget & {
    /** リセットのあと、この役割のエンジンがすること（申し送りの頭に置く 1 行） */
    readonly afterReset: string;
    wake(): void;
    stop(options?: StopOptions): void;
    reset(options?: { summary?: string; restoreTools?: boolean }): Promise<unknown>;
    statusInput(): Promise<ChatStatusInput>;
  };
  readonly conversation: {
    readonly history: { get(): Turn[] };
    save(dir: string, principal: Principal): Promise<{ path: string; media: number }>;
  };
}

/** 持ち主への知らせ（束の表が出す形） */
export interface OwnerNotice {
  ownerPid: string;
  engineId: string;
  event: string;
  data: unknown;
}

/** 束の表のうち、ここが使う面（EngineManager が満たす） */
export interface EngineTable {
  create(owner: Caller, spec?: { config?: unknown; from?: unknown; toolsets?: unknown }): Promise<OwnedEngine>;
  of(ownerPid: string, id: string): OwnedEngine;
  owned(ownerPid: string): OwnedEngine[];
  dispose(id: string, reason?: 'owner_request'): Promise<boolean>;
  onOwnerEvent(callback: (notice: OwnerNotice) => void): void;
}

export interface EngineCallsDeps {
  engines: EngineTable;
  vfs: Pick<VfsService, 'stat' | 'withBlob'>;
  /** 持ち主のプロセスへ通知する。相手がもう居なければ何もしない */
  send(pid: string, action: 'engine:event', payload: { id: string; event: string; data: unknown }): void;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 知らせの中身を、ゲストへ送る形にする。束の知らせはホストの中の形のまま出てくる（文字の塊は裸の文字列、
 * 失敗は Error）ので、どの知らせも「欄を持つ素の値」に揃える。ターンは保存できる形（JSON）なので、そのまま。
 *   stream_chunk → `{ text }`
 *   loop_stop    → `{ reason, message? }`（message は失敗のときの理由）
 */
export function ownerEventData(event: string, data: unknown): unknown {
  if (event === 'stream_chunk') return { text: typeof data === 'string' ? data : '' };
  if (event === 'loop_stop') {
    const d = isRecord(data) ? data : {};
    const out: { reason: string; message?: string } = { reason: typeof d.reason === 'string' ? d.reason : 'unknown' };
    if (d.error !== undefined && d.error !== null) {
      const message = (d.error as { message?: unknown }).message;
      out.message = typeof message === 'string' ? message : String(d.error);
    }
    return out;
  }
  return data === undefined || data === null ? {} : data;
}

export class EngineCalls {
  private readonly deps: EngineCallsDeps;

  constructor(deps: EngineCallsDeps) {
    this.deps = deps;
    deps.engines.onOwnerEvent((notice) => {
      deps.send(notice.ownerPid, 'engine:event', {
        id: notice.engineId,
        event: notice.event,
        data: ownerEventData(notice.event, notice.data),
      });
    });
  }

  /** 呼び手が持っているエンジンを引く。持ち主でなければ、無いのと同じ答え（束の表が断る） */
  private own(caller: Caller, id: unknown): OwnedEngine {
    if (typeof id !== 'string' || !id) throw new Error('MetaOS.engine: an engine id is required');
    return this.deps.engines.of(caller.pid, id);
  }

  /**
   * 作る。spec はゲストが渡したまま束の表へ（形の検査も、省いたときの既定も、束の表が持つ）。
   * 受け付けない spec は、束の表が理由を付けて断る。保存された会話（from）は呼び手の権限で読む
   */
  async create(caller: Caller, spec: unknown): Promise<{ id: string }> {
    const engine = await this.deps.engines.create(
      caller,
      spec as { config?: unknown; from?: unknown; toolsets?: unknown } | undefined,
    );
    return { id: engine.id };
  }

  async append(caller: Caller, id: unknown, req: ChatAppendRequest): Promise<{ id: string }> {
    return postToBundle(this.deps.vfs, this.own(caller, id).bundle, caller, req, 'engine.append');
  }

  async wake(caller: Caller, id: unknown): Promise<true> {
    this.own(caller, id).bundle.wake();
    return true;
  }

  async stop(caller: Caller, id: unknown): Promise<true> {
    this.own(caller, id).bundle.stop({ by: { kind: 'owner' } });
    return true;
  }

  /** 止めて会話を空にする。起こさない。消える前の会話は、知らせ（reset）で持ち主に渡る */
  async reset(caller: Caller, id: unknown, opts: ChatResetOpts | null | undefined): Promise<unknown> {
    const { bundle } = this.own(caller, id);
    const plan = buildResetPlan(opts, caller.pid, bundle.afterReset);
    return bundle.reset({ summary: plan.summary, restoreTools: plan.restoreTools });
  }

  async status(caller: Caller, id: unknown): Promise<ChatStatus> {
    return buildChatStatus(await this.own(caller, id).bundle.statusInput());
  }

  async turns(caller: Caller, id: unknown): Promise<Turn[]> {
    return this.own(caller, id).conversation.history.get();
  }

  async save(caller: Caller, id: unknown, path: unknown): Promise<{ path: string; media: number }> {
    const engine = this.own(caller, id);
    if (typeof path !== 'string' || !path.trim()) throw new Error('engine.save: path is required');
    return engine.conversation.save(path, caller.principal);
  }

  async dispose(caller: Caller, id: unknown): Promise<boolean> {
    return this.deps.engines.dispose(this.own(caller, id).id, 'owner_request');
  }

  async list(caller: Caller): Promise<Array<{ id: string; status: ChatStatus }>> {
    const owned = this.deps.engines.owned(caller.pid);
    return Promise.all(
      owned.map(async (engine) => ({ id: engine.id, status: buildChatStatus(await engine.bundle.statusInput()) })),
    );
  }
}
