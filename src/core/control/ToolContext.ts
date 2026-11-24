/**
 * src/core/control/ToolContext.ts
 * システムの道具に渡す文脈（T-0903）。
 *
 * 道具は権限を持たない。呼んだエンジンが渡した取っ手だけを使う ——
 * 道具の中に主体（Principal）の定数を書かない（tools/noPrincipalInTools.test.ts が見張る）。
 * 道具の実体は全エンジンで 1 組を共有し、エンジンごとに違うのはここに入る取っ手だけ。
 *
 *   fs           … VFS の取っ手。このエンジンの役割と個体の印が焼き込まれている（VfsHandle.ts）
 *   engine       … このエンジン自身（道具から見える口だけ）
 *   conversation … このエンジンの会話（空にする・添付を置く）
 *   tools        … このエンジンに見える道具の一覧（tool_catalog が読む）
 *   shell        … OS の画面と、プロセスの口（このエンジンの取っ手。動かせるのは自分に仕えるプロセスだけ）
 *
 * ゲストの道具（アプリ・デーモンが登録したもの）には渡らない。あちらは登録したプロセスの権限で動く。
 */

import type { VfsHandle } from '../vfs/VfsHandle';
import type { ToolDefinitionInfo, ToolSetSummary } from './ToolRegistry';

/** 道具から見える、自分を呼んだエンジン */
export interface ToolEngine {
  /** あとから自分に知らせる（set_timer）。タイマーはエンジンが預かり、エンジンを畳むと消える */
  scheduleSystemEvent(delayMs: number, actionType: string, message: string): void;
}

/** 道具から見える、このエンジンの会話 */
export interface ToolConversation {
  /** リセットのあと、この役割のエンジンがすること（申し送りの見出しの下に置く 1 行。文は system_prompts.ts の役割ごとの部分） */
  readonly afterReset: string;
  /** 会話を空にして始め直す（reset_session） */
  reset(options: { summary?: string; triggerLlm?: boolean; restoreTools?: boolean }): Promise<unknown>;
  /** 会話の添付の置き場にファイルを置き、置いた VFS のパスを返す（take_screenshot）。置き場と書く権限は会話の側が持つ */
  putAttachment(name: string, blob: Blob): Promise<string>;
}

/** 道具から見える、このエンジンの道具の一覧（tool_catalog）。エンジンが実行に使っている口と同じものを読む */
export interface ToolCatalog {
  listToolSets(includeSystem?: boolean): ToolSetSummary[];
  getToolDefinition(toolName: string): ToolDefinitionInfo | null;
}

/** 道具から見えるプロセス 1 つ */
export interface ToolProcessInfo {
  pid: string;
  path: string;
  type: 'app' | 'daemon';
  state: 'foreground' | 'background' | 'running';
  /** 仕えるエンジンの id */
  engine: string;
  /** このエンジンに仕えているか */
  mine: boolean;
}

/** 道具がプロセスを起こすときに渡すもの。仕える先は渡さない（取っ手が、このエンジンにする） */
export interface ToolSpawnOptions {
  /**
   * 名指しの pid。居れば、そこへの再開か起こし直しになる。ほかのエンジンに仕えるプロセスの名前なら断られる。
   * 省けば、個体の決め方（shell/windowing/processIdentity.ts）が、このエンジンから見た「そのアプリ」の個体を選ぶ
   */
  pid?: string;
  path: string;
  type?: 'app' | 'daemon';
  show?: boolean;
  forceReload?: boolean;
  args?: Record<string, string>;
  currentUri?: string;
}

/**
 * 道具から見える、プロセスの口（T-0908）。エンジンごとの取っ手（実体は shell/windowing/engineProcesses.ts）。
 * 動かせる（終わらせる・コードを差す・名指しで再開／起こし直す）のは、このエンジンに仕えるプロセスだけ
 * （OS のチャットのエンジンは全部）。見る（一覧・画面写真）のは全部。断るときは ToolError。
 */
export interface ToolProcesses {
  /** 起こす。起こしたプロセスは、このエンジンに仕える。窓の上限に当たれば断られる */
  spawn(options: ToolSpawnOptions): Promise<void>;
  /** 終わらせる。居なければ false */
  kill(pid: string): boolean;
  list(): ToolProcessInfo[];
  /** 画面写真（Base64）。pid を省けば前面のアプリ */
  capture(pid?: string, timeoutMs?: number): Promise<string>;
  /** プロセスの中でコードを走らせ、戻り値を返す。居なければ断る */
  evalJs(pid: string, code: string): Promise<unknown>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** 道具から見える shell */
export interface ToolShell {
  /** 利用者の取っ手。利用者に見せるために読むときだけ使う（files・open） */
  userFs: VfsHandle;
  /** プロセスの口（このエンジンの取っ手） */
  processes: ToolProcesses;
  // 画面（関連付けの解決・エディタとビューワー・エクスプローラ）
  resolver?: any;
  modals?: any;
  _revealInExplorer?: (path: string) => boolean;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface ToolContext {
  fs: VfsHandle;
  engine: ToolEngine;
  conversation: ToolConversation;
  tools: ToolCatalog;
  shell: ToolShell;
}
