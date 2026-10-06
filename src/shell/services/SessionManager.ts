/**
 * src/shell/services/SessionManager.ts
 * Itera OS v2: Session & Context Manager
 *
 * 会話の「空にする／差し替える」をここ 1 か所に集める（T-0613）。
 * ゴミ箱・`<reset_session>`・履歴モーダルの切り替え・VFS からの読み込みは全部 `_archiveCurrent()` を通り、
 * いまの会話は IndexedDB に退避される（直近 `keep` 件。古いものから剪定）。
 * 添付（system/temp/media）は「残る会話のどれにも参照されていないもの」だけを消す。
 */

import type { VfsService } from '../../core/vfs/VfsService';
import type { HistoryManager, Turn } from '../../core/state/HistoryManager';
import type { SystemLogger } from '../../core/state/SystemLogger';
import type { ToolRegistry } from '../../core/control/ToolRegistry';
import type { Principal, VfsStat } from '../../core/vfs/types';
import { SYSTEM_PRINCIPAL } from '../../core/vfs/types';
import { generateId } from '../../utils/id';
import {
  buildSessionExport,
  buildSessionMeta,
  exportFileName,
  isEmptySession,
  listSavedSessions,
  normalizeKeep,
  parseSessionImport,
  pruneSessions,
  referencedMediaPaths,
  sortSessions,
  unreferencedMedia,
  type CurrentSessionMeta,
  type SavedSessionEntry,
  type SessionMeta,
} from '../../core/state/sessionArchive';

export interface ClearSessionOptions {
  summary?: string;
  triggerLlm?: boolean;
  restoreTools?: boolean;
}

/** 添付の置き場。利用者の添付（EventOrchestrator）と画面写真（ui_tools）が書く場所 */
export const MEDIA_CACHE_DIR = 'system/temp/media';

export type SessionSwitchResult =
  { ok: true; id: string } | { ok: false; reason: 'busy' | 'missing' | 'invalid'; detail?: string };

/** 時計と `keep` の読み方を外から差し替えられるようにする（試験のため） */
export interface SessionManagerDeps {
  /** `preferences.sessionHistoryKeep` を返す。無ければ既定（10） */
  keep?: () => unknown;
  /** VFS の保存先（`ConfigManager.paths().user.sessions`）。宣言が無ければ null */
  sessionsDir?: () => string | null;
  now?: () => number;
}

export class SessionManager {
  private vfs: VfsService;
  private history: HistoryManager;
  private logger: SystemLogger;
  private toolRegistry: ToolRegistry;
  private onSessionChanged: (() => void) | null = null;
  private isBusy: () => boolean = () => false;
  private readonly keep: () => unknown;
  private readonly sessionsDir: () => string | null;
  private readonly now: () => number;
  /** いまの会話の札。起動後に 1 度だけ DB から読む（無ければ振る） */
  private currentMeta: CurrentSessionMeta | null = null;
  /** 会話を差し替える操作は直列に（切り替えの途中で別の切り替えが走ると退避が食い違う） */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    vfs: VfsService,
    history: HistoryManager,
    logger: SystemLogger,
    toolRegistry: ToolRegistry,
    deps: SessionManagerDeps = {},
  ) {
    this.vfs = vfs;
    this.history = history;
    this.logger = logger;
    this.toolRegistry = toolRegistry;
    this.keep = deps.keep ?? (() => undefined);
    this.sessionsDir = deps.sessionsDir ?? (() => null);
    this.now = deps.now ?? (() => Date.now());
  }

  /** 会話が空になった／差し替わったあとに呼ぶ（画面の描き直し） */
  public setOnSessionChangedCallback(callback: () => void): void {
    this.onSessionChanged = callback;
  }

  /** エンジンが走っているか（切り替えを断る判定。知っているのは Engine なので注入する） */
  public setBusyProbe(probe: () => boolean): void {
    this.isBusy = probe;
  }

  private _serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  // ==========================================
  // いまの会話の札
  // ==========================================

  private async _ensureCurrentMeta(): Promise<CurrentSessionMeta> {
    if (this.currentMeta) return this.currentMeta;
    let meta: CurrentSessionMeta | undefined;
    try {
      meta = await this.history.getCurrentMeta();
    } catch (e) {
      console.warn('[SessionManager] Failed to read current session meta:', e);
    }
    if (!meta || typeof meta.id !== 'string' || !meta.id) {
      // 初めて（この版より前から続いている会話）。最初のターンの時刻を始まりにする
      const first = this.history.get()[0];
      meta = { id: generateId(), createdAt: first ? first.timestamp : this.now() };
      await this._setCurrentMeta(meta);
    }
    this.currentMeta = meta;
    return meta;
  }

  private async _setCurrentMeta(meta: CurrentSessionMeta): Promise<void> {
    this.currentMeta = meta;
    try {
      await this.history.setCurrentMeta(meta);
    } catch (e) {
      console.warn('[SessionManager] Failed to write current session meta:', e);
    }
  }

  /** いまの会話の札（一覧の先頭に出す） */
  public async currentSession(): Promise<SessionMeta> {
    const meta = await this._ensureCurrentMeta();
    return buildSessionMeta(meta.id, meta.createdAt, this.history.get());
  }

  // ==========================================
  // 退避・剪定・添付の掃除
  // ==========================================

  private _keep(): number {
    return normalizeKeep(this.keep());
  }

  /**
   * いまの会話を退避する。空（発言が無い）なら退避しない。
   * 退避のあと `keep` 件を超えた分を古い方から消す。戻り値は退避したか。
   */
  private async _archiveCurrent(): Promise<boolean> {
    const turns = this.history.get();
    const meta = await this._ensureCurrentMeta();
    if (isEmptySession(turns)) return false;

    const entry = buildSessionMeta(meta.id, meta.createdAt, turns);
    await this.history.putSession(entry.id, turns);
    const index = (await this.history.getSessionsIndex()).filter((m) => m.id !== entry.id);
    index.push(entry);
    await this._writeIndexPruned(index);
    return true;
  }

  /** 索引を剪定して書き、剪定した会話の本体を消す */
  private async _writeIndexPruned(index: SessionMeta[]): Promise<void> {
    const { kept, pruned } = pruneSessions(index, this._keep());
    await this.history.setSessionsIndex(kept);
    for (const m of pruned) {
      try {
        await this.history.deleteSession(m.id);
      } catch (e) {
        console.warn('[SessionManager] Failed to delete pruned session', m.id, e);
      }
    }
  }

  /**
   * 添付の掃除: 置き場にあるファイルのうち、退避中の会話といまの会話のどれにも参照されていないものを消す。
   * （以前は置き場を丸ごと消していた。退避した会話を戻したとき画像が注記にならないように）
   */
  private async _cleanupMedia(): Promise<void> {
    try {
      if (!this.vfs.exists(SYSTEM_PRINCIPAL, MEDIA_CACHE_DIR)) return;
      const files = (
        this.vfs.listFiles(SYSTEM_PRINCIPAL, { path: MEDIA_CACHE_DIR, recursive: true, detail: true }) as VfsStat[]
      )
        .filter((s) => s.kind === 'file')
        .map((s) => s.path);
      const index = await this.history.getSessionsIndex();
      const referenced = referencedMediaPaths(index, this.history.get());
      const targets = unreferencedMedia(files, referenced);
      for (const p of targets) {
        try {
          await this.vfs.deleteFile(SYSTEM_PRINCIPAL, p, { permanent: true });
        } catch (e) {
          console.warn('[SessionManager] Failed to delete media', p, e);
        }
      }
      if (targets.length > 0) console.log(`[SessionManager] Media cache cleaned (${targets.length} unreferenced).`);
    } catch (e) {
      console.warn('[SessionManager] Failed to clean media cache:', e);
    }
  }

  /** 走っているアプリ・デーモンの道具の定義を積み直す（履歴ごと消えるので。T-0246） */
  private _restoreToolDefinitions(): void {
    if (!this.toolRegistry) return;
    const activeToolDefs = this.toolRegistry.getActiveDynamicToolDefinitions();
    if (activeToolDefs.length === 0) return;
    const defsText = activeToolDefs.join('\n');
    this.history.append(
      'system',
      `<event type="tool_available">\n[System: Restored Dynamic Tools]\nThe following tools are currently active from background processes:\n${defsText}\n</event>`,
      {
        type: 'tool_available',
        eventType: 'tool_available',
        trigger_llm: false,
      },
    );
  }

  // ==========================================
  // 空にする（ゴミ箱・<reset_session>）
  // ==========================================

  public clearSession(options: ClearSessionOptions = {}): Promise<void> {
    return this._serialize(() => this._clearSession(options));
  }

  private async _clearSession(options: ClearSessionOptions): Promise<void> {
    const summary = options.summary || null;
    const triggerLlm = options.triggerLlm || false;
    const restoreTools = options.restoreTools || false;

    const archived = await this._archiveCurrent();

    if (this.logger) {
      this.logger.log('system', {
        action: 'session_reset',
        archived,
        restoreTools,
        hasSummary: !!summary,
      });
    }

    this.history.clear();
    await this._setCurrentMeta({ id: generateId(), createdAt: this.now() });

    await this._cleanupMedia();

    if (restoreTools) this._restoreToolDefinitions();

    if (summary) {
      this.history.append(
        'system',
        `<event type="session_reset">\n[Session Restored & Context Compressed]\n\n${summary}\n</event>`,
        {
          type: 'event_log',
          trigger_llm: triggerLlm,
        },
      );
    }

    this.onSessionChanged?.();
  }

  // ==========================================
  // 一覧・切り替え・削除（履歴モーダル）
  // ==========================================

  /** 退避した会話（新しい順） */
  public async listSessions(): Promise<SessionMeta[]> {
    return sortSessions(await this.history.getSessionsIndex());
  }

  /**
   * 退避した会話に切り替える。いまの会話は退避する。
   * エンジンが走っていれば断る（走っている束を見捨てると、その結果が新しい会話に落ちる）。
   */
  public switchSession(id: string): Promise<SessionSwitchResult> {
    return this._serialize(async () => {
      if (this.isBusy()) return { ok: false, reason: 'busy' };
      const index = await this.history.getSessionsIndex();
      const meta = index.find((m) => m.id === id);
      const turns = meta ? await this.history.getSession(id) : undefined;
      if (!meta || !turns) return { ok: false, reason: 'missing' };
      await this._activate({ id: meta.id, createdAt: meta.createdAt }, turns, 'switched', meta.updatedAt);
      return { ok: true, id: meta.id };
    });
  }

  /** 退避した会話を消す（本体と索引。参照されなくなった添付も） */
  public deleteSession(id: string): Promise<void> {
    return this._serialize(async () => {
      const index = (await this.history.getSessionsIndex()).filter((m) => m.id !== id);
      await this.history.setSessionsIndex(index);
      try {
        await this.history.deleteSession(id);
      } catch (e) {
        console.warn('[SessionManager] Failed to delete session', id, e);
      }
      await this._cleanupMedia();
    });
  }

  /**
   * 会話を差し替える共通の手順: いまの会話を退避 → 索引から外す → turns を差し替えて永続化 → 復帰の印を積む → 掃除。
   * 復帰の印は `trigger_llm: false`（切り替えは利用者の操作であって依頼ではない。次に話しかけるまで起こさない）。
   */
  private async _activate(
    meta: CurrentSessionMeta,
    turns: Turn[],
    how: 'switched' | 'loaded',
    lastActivity: number,
  ): Promise<void> {
    await this._archiveCurrent();
    const index = (await this.history.getSessionsIndex()).filter((m) => m.id !== meta.id);
    await this.history.setSessionsIndex(index);
    try {
      await this.history.deleteSession(meta.id);
    } catch {
      /* 索引に無ければ本体も無い */
    }

    this.history.load(turns);
    await this._setCurrentMeta(meta);
    await this.history.persist();

    if (this.logger) {
      this.logger.log('system', { action: `session_${how}`, sessionId: meta.id, turns: turns.length });
    }

    const stamp = (ms: number) => new Date(ms).toISOString();
    const defs = this.toolRegistry ? this.toolRegistry.getActiveDynamicToolDefinitions() : [];
    const lines = [
      how === 'switched'
        ? `[System: Switched to an earlier session (last activity ${stamp(lastActivity)}). Time now: ${stamp(this.now())}.]`
        : `[System: Loaded a session from the VFS (last activity ${stamp(lastActivity)}). Time now: ${stamp(this.now())}.]`,
      'Files, processes and tool definitions may have changed since. Re-check before acting.',
    ];
    if (defs.length > 0) {
      lines.push('The following tools are currently active from background processes:', defs.join('\n'));
    }
    this.history.append('system', `<event type="session_${how}">\n${lines.join('\n')}\n</event>`, {
      type: 'event_log',
      eventType: `session_${how}`,
      trigger_llm: false,
    });

    await this._cleanupMedia();
    this.onSessionChanged?.();
  }

  // ==========================================
  // VFS への保存・VFS からの読み込み
  // ==========================================

  /** 会話（`current` ならいまの会話）を JSON にする */
  public async exportSession(id: string | 'current'): Promise<string | null> {
    let meta: CurrentSessionMeta;
    let turns: Turn[];
    if (id === 'current') {
      meta = await this._ensureCurrentMeta();
      turns = this.history.get();
    } else {
      const found = (await this.history.getSessionsIndex()).find((m) => m.id === id);
      const stored = found ? await this.history.getSession(id) : undefined;
      if (!found || !stored) return null;
      meta = { id: found.id, createdAt: found.createdAt };
      turns = stored;
    }
    return JSON.stringify(buildSessionExport(meta, turns, this.now()), null, 2);
  }

  /** 会話を VFS に書く（上書きの確認はダイアログの側で済んでいる前提） */
  public async exportSessionToVfs(id: string | 'current', path: string, principal: Principal): Promise<boolean> {
    const json = await this.exportSession(id);
    if (json === null) return false;
    await this.vfs.writeFile(principal, path, json, { overwrite: true });
    if (this.logger) this.logger.log('system', { action: 'session_export', sessionId: id, path });
    return true;
  }

  /** VFS の保存先（宣言が無ければ null）。読む側はこれだけを使う */
  public savedSessionsDir(): string | null {
    const d = this.sessionsDir();
    return typeof d === 'string' && d.trim() ? d.trim().replace(/\/+$/, '') : null;
  }

  /**
   * 会話を**既定の保存先**に書く（ダイアログ無し）。名前は `exportFileName`（会話の始まりの日時＋題）なので、
   * 同じ会話を保存し直すと同じファイルを上書きする。保存先の宣言が無ければ null。
   */
  public async exportSessionToDefaultDir(id: string | 'current', principal: Principal): Promise<string | null> {
    const dir = this.savedSessionsDir();
    if (!dir) return null;
    const meta =
      id === 'current' ? await this.currentSession() : (await this.history.getSessionsIndex()).find((m) => m.id === id);
    if (!meta) return null;
    if (!this.vfs.exists(principal, dir)) await this.vfs.mkdir(principal, dir);
    const path = `${dir}/${exportFileName(meta)}`;
    const ok = await this.exportSessionToVfs(id, path, principal);
    return ok ? path : null;
  }

  /**
   * 既定の保存先にある会話の一覧。**名前と stat だけ**で組む（中身は読まない。同期のスタブも取りに行かない —— 山内さん 2026-10-06）。
   * 保存先の宣言が無い・まだ無ければ空。
   */
  public listSavedSessions(principal: Principal): SavedSessionEntry[] {
    const dir = this.savedSessionsDir();
    if (!dir || !this.vfs.exists(principal, dir)) return [];
    try {
      const stats = this.vfs.listFiles(principal, { path: dir, detail: true }) as VfsStat[];
      return listSavedSessions(stats);
    } catch (e) {
      console.warn('[SessionManager] Failed to list saved sessions:', e);
      return [];
    }
  }

  /** 保存先のファイルをゴミ箱へ移す（永久には消さない） */
  public async deleteSavedSession(path: string, principal: Principal): Promise<void> {
    await this.vfs.deleteFile(principal, path);
    if (this.logger) this.logger.log('system', { action: 'session_export_deleted', path });
  }

  /**
   * VFS のファイルを読んで、その会話に切り替える（いまの会話は退避）。
   * 形が違えば断る。id が退避中の会話やいまの会話と衝突すれば採り直す。
   */
  public importSessionFromVfs(path: string, principal: Principal): Promise<SessionSwitchResult> {
    return this._serialize(async () => {
      if (this.isBusy()) return { ok: false, reason: 'busy' };
      let text: string;
      try {
        text = await this.vfs.readFile(principal, path);
      } catch (e) {
        return { ok: false, reason: 'invalid', detail: (e as Error).message };
      }
      const parsed = parseSessionImport(text);
      if (!parsed.ok) return { ok: false, reason: 'invalid', detail: parsed.reason };

      const current = await this._ensureCurrentMeta();
      const index = await this.history.getSessionsIndex();
      const taken = new Set([current.id, ...index.map((m) => m.id)]);
      const id = parsed.id && !taken.has(parsed.id) ? parsed.id : generateId();
      const last = parsed.turns.length > 0 ? parsed.turns[parsed.turns.length - 1].timestamp : parsed.createdAt;
      await this._activate({ id, createdAt: parsed.createdAt }, parsed.turns, 'loaded', last);
      return { ok: true, id };
    });
  }
}
