/**
 * src/shell/services/EngineManager.ts
 * 束の表 —— 生きているエンジンの束と、その持ち主（T-0908）。
 *
 * ルート（OS のチャットのエンジン）は 1 つで、起動のときに組まれてここに渡される。ほかは、ゲストのプロセスが
 * 頼んで作らせる束（サブ）。サブは名前も登録簿も持たない: 持ち主はそれを頼んだプロセスで、
 *   - 持ち主が畳む／持ち主のプロセスが終わる／OS が読み込み直される、のどれかで消える
 *   - 消えるとき、そのエンジンに仕えていたプロセスも終わる。そのプロセスが持っていたエンジンは、
 *     「持ち主のプロセスが終わった」ことで畳まれる（木は、持ち主の規則だけから出来る。深さの決まりは置かない）
 *   - 宛先に書けるのは持ち主だけ（of）。持ち主でない者には、在るかどうかも答えない
 *   - 道具は、システムの道具と自分に仕えるプロセスの道具のほかに、作る者が与えた組（toolsets）だけが見える（T-0912）
 *
 * ここは束を作って表に載せるだけで、ゲストへの届け方は知らない。持ち主への知らせは onOwnerEvent で聞く。
 */

import type { Principal, VfsStat } from '../../core/vfs/types';
import { SYSTEM_PRINCIPAL } from '../../core/vfs/types';
import type { VfsService } from '../../core/vfs/VfsService';
import type { VfsHandle } from '../../core/vfs/VfsHandle';
import type { Engine } from '../../core/control/Engine';
import { createEngineBundle, type EngineBundle } from '../../core/control/EngineBundle';
import type { ToolRegistry } from '../../core/control/ToolRegistry';
import type { ToolShell } from '../../core/control/ToolContext';
import type { Translator } from '../../core/cognitive/Translator';
import { normalizeEngineOverrides, overlayEngineConfig, type EngineConfigReader } from '../../core/sys/engineConfig';
import { ENGINES_TEMP_DIR, EngineConversation } from '../../core/state/EngineConversation';
import type { PromptRole } from '../../config/system_prompts';
import { MAX_SUB_ENGINES } from '../../config/engine_limits';
import { generateId } from '../../utils/id';
import { OS_MOVER, type Mover } from '../windowing/processGate';
import { contextFromHistory } from '../../api/chatApi';

/** 作るときに渡せるもの。どちらも省ける */
export interface EngineSpec {
  /** OS の設定への上書き（engineConfig.ts）。省いた鍵は OS の設定に追随する */
  config?: unknown;
  /** 保存してあった会話から始める（保存のディレクトリ・その中の session.json）。省けば空 */
  from?: unknown;
  /**
   * 与える道具の組（T-0912）: プロセスの名前（pid）の並び。作るプロセスが仕えるエンジンから見えている組だけを渡せる。
   * 省けば、このエンジンに見えるのはシステムの道具と、自分に仕えるプロセスの道具だけ
   */
  toolsets?: unknown;
}
const SPEC_KEYS = ['config', 'from', 'toolsets'];

/** 頼んだプロセスと、その主体（保存された会話を読むのは、頼んだ者の権限） */
export interface EngineOwner {
  pid: string;
  principal: Principal;
}

export interface SubEngine {
  readonly id: string;
  readonly ownerPid: string;
  /** 持ち主が何のアプリか（記録に残す） */
  readonly ownerApp: string;
  readonly bundle: EngineBundle;
  readonly conversation: EngineConversation;
}

/**
 * 束の表を読むだけの口（overview）が返す 1 行（T-0916。エンジンの一覧の窓が読む）。素の値だけ: 束そのものは外へ渡さない。
 * 状態は Engine.status() のまま（running／busy／scheduled。どれも false なら何も進んでいない）
 */
export interface EngineOverview {
  id: string;
  role: 'root' | 'sub';
  /** 持ち主のプロセス（サブだけ。ルートは null） */
  ownerPid: string | null;
  /** 持ち主が何のアプリか（サブだけ） */
  ownerApp: string | null;
  running: boolean;
  busy: boolean;
  scheduled: boolean;
  outstandingTools: number;
  /** 会話のターンの数 */
  turns: number;
  /** このエンジンに仕えているプロセスの数（プロセスの記録の engine） */
  serving: number;
  /** 最後の応答のモデルと、そのときの文脈の長さ（履歴から読む。応答がまだ無ければ null） */
  model: string | null;
  contextTokens: number | null;
}

/** 畳んだ理由: 持ち主が畳んだ／持ち主のプロセスが終わった／作る途中で失敗した */
export type EngineDisposeReason = 'owner_request' | 'owner_exit' | 'create_failed';

/**
 * 持ち主への知らせ。
 *   turn_start / stream_chunk / turn_end / loop_stop / turn_placed … 束のもの（中身はそのまま）
 *   reset    … 会話を空にした（`{ session }`: 消える前の会話。保存と同じ形）
 *   disposed … 畳んだ（`{ reason }`）
 */
export const ENGINE_OWNER_EVENTS = [
  'turn_start',
  'stream_chunk',
  'turn_end',
  'loop_stop',
  'turn_placed',
  'reset',
  'disposed',
] as const;
export type EngineOwnerEvent = (typeof ENGINE_OWNER_EVENTS)[number];

export interface EngineOwnerNotice {
  ownerPid: string;
  engineId: string;
  event: EngineOwnerEvent;
  data: unknown;
}

const FORWARDED = ['turn_start', 'stream_chunk', 'turn_end', 'loop_stop', 'turn_placed'] as const;

/** 表が見るプロセスの欄（ProcessManager の Process が満たす） */
interface ServingProcess {
  pid: string;
  app: string;
  engine: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface EngineManagerDeps {
  root: EngineBundle;
  vfs: VfsService;
  /** OS の設定。サブはこれに上書きを重ねて読む */
  configManager: EngineConfigReader;
  translator: Translator;
  registry: ToolRegistry;
  /** そのエンジンの VFS の取っ手（役割と個体の印を焼き込むのは組み立て） */
  fsFor: (engineId: string) => VfsHandle;
  /** 道具に渡す画面とプロセスの口（プロセスの口は、そのエンジンの取っ手） */
  shellFor: (engineId: string) => ToolShell;
  processes: {
    processes: ReadonlyMap<string, ServingProcess>;
    kill(mover: Mover, pid: string): boolean;
    on(event: string, callback: (...args: any[]) => void): void;
  };
  /** プロンプトと上流を差す側（CognitiveManager） */
  cognitive: {
    equip(engine: Engine, config: EngineConfigReader, role: PromptRole): Promise<() => void>;
    contextLimit(config?: EngineConfigReader): Promise<number | null>;
  };
  logger: { log(category: string, payload: any): unknown };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

interface Entry extends SubEngine {
  unequip: (() => void) | null;
}

export class EngineManager {
  private readonly deps: EngineManagerDeps;
  private readonly subs = new Map<string, Entry>();
  /** 作っている途中（表に載る前）の数。上限はこれも数える */
  private creating = 0;
  private readonly listeners: Array<(notice: EngineOwnerNotice) => void> = [];

  constructor(deps: EngineManagerDeps) {
    this.deps = deps;
    // 持ち主のプロセスが終わったら、その持ち物を畳む
    deps.processes.on('process_killed', (pid: string) => {
      for (const entry of [...this.subs.values()]) {
        if (entry.ownerPid === pid) void this.dispose(entry.id, 'owner_exit');
      }
    });
  }

  /** そのプロセスが仕えるエンジンの束（プロセスの記録の engine から引く）。無ければ null */
  public bundleFor(pid: string): EngineBundle | null {
    const engineId = this.deps.processes.processes.get(pid)?.engine;
    if (!engineId) return null;
    if (engineId === this.deps.root.id) return this.deps.root;
    return this.subs.get(engineId)?.bundle ?? null;
  }

  /** 持ち主が、自分のエンジンを引く。持ち主でなければ「無い」と同じ答え */
  public of(ownerPid: string, id: string): SubEngine {
    const entry = this.subs.get(id);
    if (!entry || entry.ownerPid !== ownerPid) throw new Error(`Engine "${id}" not found.`);
    return entry;
  }

  /** そのプロセスが持っているエンジン */
  public owned(ownerPid: string): SubEngine[] {
    return [...this.subs.values()].filter((entry) => entry.ownerPid === ownerPid);
  }

  /**
   * 生きているエンジン全部（ルートが先頭、続いてサブを作った順）を、素の値で読む（T-0916）。
   * 読むだけ: 何も起こさず、何も変えない。持ち主の規則（of）を通さないので、ホストの窓だけが使う（ゲストには渡さない）
   */
  public overview(): EngineOverview[] {
    const procs = [...this.deps.processes.processes.values()];
    const row = (bundle: EngineBundle, role: 'root' | 'sub', ownerPid: string | null, ownerApp: string | null) => {
      const status = bundle.engine.status();
      const turns = bundle.history.get();
      const context = contextFromHistory(turns, null);
      return {
        id: bundle.id,
        role,
        ownerPid,
        ownerApp,
        running: status.running,
        busy: status.busy,
        scheduled: status.scheduled,
        outstandingTools: status.outstandingTools,
        turns: turns.length,
        serving: procs.filter((p) => p.engine === bundle.id).length,
        model: context ? context.model : null,
        contextTokens: context ? context.tokens : null,
      };
    };
    return [
      row(this.deps.root, 'root', null, null),
      ...[...this.subs.values()].map((entry) => row(entry.bundle, 'sub', entry.ownerPid, entry.ownerApp)),
    ];
  }

  /** 持ち主への知らせを聞く（ゲストへ届ける側が聞く） */
  public onOwnerEvent(callback: (notice: EngineOwnerNotice) => void): void {
    this.listeners.push(callback);
  }

  /**
   * エンジンを作る。受け付けないものは、作らずに理由を付けて断る（黙って落とすと、頼んだ側は効いていると思ったまま走る）。
   * 返るまでに、会話（空か、保存から）・プロンプトと上流・始まりの知らせが揃っている。ここからは起こさない。
   * ただし、保存が答えていない発言で終わっていれば、始まりの知らせのあとの評価でエンジンは起きる
   * （未読の発言が在れば起きる、というエンジンの規則のまま。OS のチャットで保存を読み込んだときと同じ）。
   */
  public async create(owner: EngineOwner, spec: EngineSpec = {}): Promise<SubEngine> {
    const { deps } = this;
    const ownerProc = deps.processes.processes.get(owner.pid);
    if (!ownerProc) throw new Error(`Process "${owner.pid}" is not running.`);

    if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
      throw new Error('Invalid engine spec: must be an object');
    }
    const { overrides, problems } = normalizeEngineOverrides(spec.config);
    for (const key of Object.keys(spec)) {
      if (!SPEC_KEYS.includes(key)) problems.push(`${key} is not supported (allowed: ${SPEC_KEYS.join(', ')})`);
    }
    const from = spec.from;
    if (from !== undefined && (typeof from !== 'string' || !from.trim())) {
      problems.push('from must be a non-empty path');
    }
    // 与える組: 作るプロセスが仕えるエンジンから、いま見えている組だけ（見えていなければ作らずに断る）
    let toolsets: string[] = [];
    if (spec.toolsets !== undefined) {
      if (!Array.isArray(spec.toolsets) || spec.toolsets.some((pid) => typeof pid !== 'string' || !pid)) {
        problems.push('toolsets must be an array of process names (pids)');
      } else {
        toolsets = [...new Set(spec.toolsets as string[])];
        const visible = (this.bundleFor(owner.pid)?.tools.listToolSets() ?? []).map((set) => set.id);
        const unseen = toolsets.filter((pid) => !visible.includes(pid));
        if (unseen.length > 0) {
          const names = unseen.map((pid) => `"${pid}"`).join(', ');
          const what = unseen.length === 1 ? 'is not a toolset' : 'are not toolsets';
          problems.push(
            `toolsets: ${names} ${what} visible to the engine this process serves (visible: ${visible.length > 0 ? visible.join(', ') : 'none'})`,
          );
        }
      }
    }
    if (problems.length > 0) throw new Error(`Invalid engine spec: ${problems.join('; ')}`);

    if (this.subs.size + this.creating >= MAX_SUB_ENGINES) {
      throw new Error(`Too many engines (limit ${MAX_SUB_ENGINES}). Dispose one first.`);
    }

    const id = this.newId();
    const config = overlayEngineConfig(deps.configManager, overrides);
    let entry: Entry | null = null;
    const conversation = new EngineConversation({
      engineId: id,
      vfs: deps.vfs,
      toolDefinitions: () => (entry ? entry.bundle.tools.restoreDefinitions() : []),
      onReset: (session) => this.emit(owner.pid, id, 'reset', { session }),
    });

    // 保存から始めるなら、束を作る前に読む（読んでいる間に持ち主が終われば、何も残さずにやめる）
    this.creating++;
    try {
      if (typeof from === 'string') {
        const loaded = await conversation.load(from, owner.principal);
        if (!loaded.ok) throw new Error(`Cannot load the conversation: ${loaded.detail}`);
        if (deps.processes.processes.get(owner.pid) !== ownerProc) throw new Error(this.ownerGone(id));
      }
      const bundle = createEngineBundle({
        id,
        role: 'sub',
        history: conversation.history,
        vfs: deps.vfs,
        configManager: config,
        translator: deps.translator,
        registry: deps.registry,
        // 与えた者は、作るプロセスが仕えるエンジン（見え方なので、そのエンジンの側で組が入れ替わっても追う）
        grant: toolsets.length > 0 ? { from: ownerProc.engine, toolsets } : undefined,
        fs: deps.fsFor(id),
        conversation,
        contextLimit: () => deps.cognitive.contextLimit(config),
      });
      bundle.engine.extraContext.shell = deps.shellFor(id);
      entry = { id, ownerPid: owner.pid, ownerApp: ownerProc.app, bundle, conversation, unequip: null };
      this.subs.set(id, entry);
    } catch (e) {
      await conversation.dispose();
      throw e;
    } finally {
      this.creating--;
    }

    deps.logger.log('process_events', {
      action: 'engine_created',
      engine: id,
      owner: owner.pid,
      app: ownerProc.app,
      ...(toolsets.length > 0 ? { toolsets } : {}),
    });
    for (const event of FORWARDED) {
      entry.bundle.on(event, (data: unknown) => this.emit(owner.pid, id, event, data));
    }

    // ここから先は表に載っているので、持ち主が終われば畳まれる。差している間に畳まれていたら、差したものを外してやめる
    try {
      const unequip = await deps.cognitive.equip(entry.bundle.engine, config, 'sub');
      if (this.subs.get(id) !== entry) {
        unequip();
        throw new Error(this.ownerGone(id));
      }
      entry.unequip = unequip;
    } catch (e) {
      await this.dispose(id, 'create_failed');
      throw e;
    }

    conversation.announceStart();
    return entry;
  }

  /**
   * 畳む。エンジンを止め、仕えていたプロセスを終わらせ、添付の置き場を消す。無ければ false。
   * 仕えていたプロセスが持つエンジンは、そのプロセスが終わることで（上の process_killed から）畳まれる。
   */
  public async dispose(id: string, reason: EngineDisposeReason = 'owner_request'): Promise<boolean> {
    const entry = this.subs.get(id);
    if (!entry) return false;
    this.subs.delete(id);

    entry.unequip?.();
    // 先にエンジンを止める（仕えていたプロセスが終わっていくことに、エンジンが反応しないように）
    entry.bundle.dispose();
    for (const proc of [...this.deps.processes.processes.values()]) {
      if (proc.engine === id) this.deps.processes.kill(OS_MOVER, proc.pid);
    }

    this.deps.logger.log('process_events', {
      action: 'engine_disposed',
      engine: id,
      owner: entry.ownerPid,
      app: entry.ownerApp,
      reason,
    });
    this.emit(entry.ownerPid, id, 'disposed', { reason });
    await entry.conversation.dispose();
    return true;
  }

  /**
   * 添付の置き場（`system/temp/engines/`）の下で、生きているエンジンに無い id のディレクトリを消す（1 規則）。
   * エンジンは揮発なので、読み込み直しのあとに残っているものは全部これに当たる。
   */
  public async sweepLeftovers(): Promise<void> {
    const { vfs } = this.deps;
    try {
      if (!vfs.exists(SYSTEM_PRINCIPAL, ENGINES_TEMP_DIR)) return;
      const entries = vfs.listFiles(SYSTEM_PRINCIPAL, { path: ENGINES_TEMP_DIR, detail: true }) as VfsStat[];
      for (const e of entries) {
        if (e.kind !== 'directory' || this.subs.has(e.name)) continue;
        await vfs.deleteFile(SYSTEM_PRINCIPAL, e.path, { permanent: true });
      }
    } catch (e) {
      console.warn('[EngineManager] Failed to clean engine attachment dirs:', e);
    }
  }

  /** pid と紛れない形にする（変更の個体の印に入る。同期のエコー止めは、印がプロバイダの pid かどうかで見ている） */
  private newId(): string {
    return `eng-${generateId().replace(/-/g, '').slice(0, 12)}`;
  }

  private ownerGone(id: string): string {
    return `The owner of engine "${id}" exited while it was being created.`;
  }

  private emit(ownerPid: string, engineId: string, event: EngineOwnerEvent, data: unknown): void {
    for (const callback of [...this.listeners]) {
      try {
        callback({ ownerPid, engineId, event, data });
      } catch (e) {
        console.warn(`[EngineManager] An owner-event listener failed (${event}).`, e);
      }
    }
  }
}
