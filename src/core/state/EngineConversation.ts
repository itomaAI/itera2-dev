/**
 * src/core/state/EngineConversation.ts
 * アプリが作ったエンジンの会話の口（T-0908）。OS のチャットの会話での SessionManager に当たる。
 *
 * 会話はメモリにだけ在る。退避も一覧も持たない —— 残すかどうかは持ち主が決め、残すなら文書として書く（save）。
 * 文書の形は OS のチャットの保存と同じ（sessionBundleIo.ts）なので、どちらで保存した会話も、どちらでも開ける。
 *
 *   添付の置き場 … `system/temp/engines/<エンジンの id>/`。畳むと消える。空にしても消さない
 *                    （空にする前の会話は持ち主に渡すので、その添付は畳むまで読める）
 *   空にする     … 消す前の会話を持ち主へ渡してから消す。申し送りと道具の定義は OS のチャットと同じ文（conversationEvents.ts）
 *   始まり       … 見えている動的な道具の定義を置く。保存から始めたときは、読み込んだ印と一緒に
 */

import { HistoryManager } from './HistoryManager';
import type { Principal } from '../vfs/types';
import { SYSTEM_PRINCIPAL } from '../vfs/types';
import { generateId } from '../../utils/id';
import { EXPORT_MEDIA_DIR, EXPORT_SESSION_FILE, buildSessionExport, type SessionExport } from './sessionArchive';
import {
  collectBundleMedia,
  copyBundleMedia,
  readSessionBundle,
  restoreBundleMedia,
  type BundleVfs,
} from './sessionBundleIo';
import {
  sessionActivatedEvent,
  sessionResetEvent,
  toolsRestoredEvent,
  type ConversationEvent,
} from './conversationEvents';

/** アプリが作ったエンジンの添付の置き場の根。エンジンごとに `<根>/<エンジンの id>/` */
export const ENGINES_TEMP_DIR = 'system/temp/engines';

export function engineMediaDir(engineId: string): string {
  return `${ENGINES_TEMP_DIR}/${engineId}`;
}

/** この口が VFS に求めるもの（VfsService が満たす。試験は偽物を差す） */
export interface EngineConversationVfs extends BundleVfs {
  deleteFile(principal: Principal, path: string, options: { permanent?: boolean }): Promise<unknown>;
}

export interface EngineConversationDeps {
  /** このエンジンの id（添付の置き場の名前になる） */
  engineId: string;
  vfs: EngineConversationVfs;
  /** いまこのエンジンに見えている動的な道具の定義（引いたものは会話に置く。台帳は、渡したものとして控える） */
  toolDefinitions: () => string[];
  /** 空にする直前の会話（保存と同じ形）。持ち主へ渡す */
  onReset: (session: SessionExport) => void;
  now?: () => number;
}

export class EngineConversation {
  public readonly history = new HistoryManager();
  /** 添付の置き場 */
  public readonly mediaDir: string;
  private readonly deps: EngineConversationDeps;
  private readonly now: () => number;
  private meta: { id: string; createdAt: number; title: string };
  /** 保存から始めた会話が最後に動いた時刻（始まりの印に書く）。空から始めたら null */
  private loadedLastActivity: number | null = null;

  constructor(deps: EngineConversationDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.mediaDir = engineMediaDir(deps.engineId);
    this.meta = { id: generateId(), createdAt: this.now(), title: '' };
  }

  /** いまの会話の id（生成の台帳の行に添える） */
  public currentId(): string {
    return this.meta.id;
  }

  public async current(): Promise<{ id: string; title: string; createdAt: number }> {
    return { ...this.meta };
  }

  /** いまの会話を、保存と同じ形にする */
  public snapshot(): SessionExport {
    return buildSessionExport(this.meta, this.history.get(), this.now());
  }

  /** 添付の置き場にファイルを置き、置いたパスを返す。置き場は OS の一時領域なので、書くのは OS。同名があれば置き換える */
  public async putAttachment(name: string, blob: Blob): Promise<string> {
    const path = `${this.mediaDir}/${name}`;
    await this.deps.vfs.writeFile(SYSTEM_PRINCIPAL, path, blob, { overwrite: true, system: true });
    return path;
  }

  /**
   * 保存された会話から始める（エンジンを作るときに 1 度だけ。束を作る前に呼ぶ）。`path` は保存のディレクトリ・
   * その中の `session.json`・旧形式の単一 `.json`。読むのは頼んだ者の主体。同梱の添付は置き場へ写し、参照を付け替える。
   * 会話の id・題・始まりの時刻は文書のものを引き継ぐ（書き戻せば同じ会話）。読めなければ理由を返し、会話は空のまま。
   */
  public async load(path: string, principal: Principal): Promise<{ ok: true } | { ok: false; detail: string }> {
    const read = await readSessionBundle(this.deps.vfs, principal, path);
    if (!read.ok) return { ok: false, detail: read.detail };
    const { parsed, bundleDir } = read;
    const turns = await restoreBundleMedia(this.deps.vfs, principal, bundleDir, this.mediaDir, parsed.turns);
    this.meta = { id: parsed.id || generateId(), createdAt: parsed.createdAt, title: parsed.title };
    this.loadedLastActivity = turns.length > 0 ? turns[turns.length - 1].timestamp : parsed.createdAt;
    this.history.load(turns);
    return { ok: true };
  }

  /**
   * 始まりの知らせを置く（束が出来てから 1 度）。空から始めたら見えている道具の定義だけ、
   * 保存から始めたら読み込んだ印（道具の定義つき）。どちらも起こさない。
   */
  public announceStart(): void {
    const definitions = this.deps.toolDefinitions();
    const event =
      this.loadedLastActivity === null
        ? toolsRestoredEvent(definitions)
        : sessionActivatedEvent('loaded', this.loadedLastActivity, this.now(), definitions);
    if (event) this.place(event);
  }

  /**
   * 会話を空にして始め直す。消す前の会話は持ち主へ渡す（退避は無い。残すかどうかは持ち主）。
   * 添付の置き場はそのまま。戻り値の形は OS のチャットと同じ（`archived` はいつも false）。
   */
  public async reset(
    options: { summary?: string; triggerLlm?: boolean; restoreTools?: boolean } = {},
  ): Promise<{ archived: false; sessionId: string }> {
    this.deps.onReset(this.snapshot());

    this.history.clear();
    this.meta = { id: generateId(), createdAt: this.now(), title: '' };

    if (options.restoreTools) {
      const event = toolsRestoredEvent(this.deps.toolDefinitions());
      if (event) this.place(event);
    }
    if (options.summary) this.place(sessionResetEvent(options.summary, options.triggerLlm || false));

    return { archived: false, sessionId: this.meta.id };
  }

  /**
   * いまの会話を文書として VFS に書く: `<dir>/session.json` と `<dir>/media/`（添付）。書くのは頼んだ者の主体。
   * 同じ場所に書き直せば上書きし、`media/` には足りない分だけ足す。戻り値は書いた場所と、写した添付の数。
   */
  public async save(dir: string, principal: Principal): Promise<{ path: string; media: number }> {
    const target = dir.replace(/\/+$/, '');
    const json = JSON.stringify(this.snapshot(), null, 2);
    await this.deps.vfs.writeFile(principal, `${target}/${EXPORT_SESSION_FILE}`, json, { overwrite: true });
    const sources = collectBundleMedia(this.deps.vfs, this.mediaDir, this.history.get());
    const media = await copyBundleMedia(this.deps.vfs, principal, sources, `${target}/${EXPORT_MEDIA_DIR}`);
    return { path: target, media };
  }

  /** 畳む: 添付の置き場を消す（一時領域なので、ゴミ箱には入れない） */
  public async dispose(): Promise<void> {
    try {
      if (!this.deps.vfs.exists(SYSTEM_PRINCIPAL, this.mediaDir)) return;
      await this.deps.vfs.deleteFile(SYSTEM_PRINCIPAL, this.mediaDir, { permanent: true });
    } catch (e) {
      console.warn('[EngineConversation] Failed to delete the attachment dir', this.mediaDir, e);
    }
  }

  private place(event: ConversationEvent): void {
    this.history.append('system', event.content, event.meta);
  }
}
