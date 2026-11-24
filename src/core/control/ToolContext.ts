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
 *   shell        … OS の画面とプロセス。エンジンのものではない
 *
 * ゲストの道具（アプリ・デーモンが登録したもの）には渡らない。あちらは登録したプロセスの権限で動く。
 */

import type { VfsHandle } from '../vfs/VfsHandle';
import type { ToolDefinitionInfo, ToolSetSummary } from './ToolRegistry';

/** 道具から見える、自分を呼んだエンジン */
export interface ToolEngine {
  /** このエンジンの id。道具が起こすプロセスは、このエンジンに仕える（spawn・open） */
  readonly id: string;
  /** あとから自分に知らせる（set_timer）。タイマーはエンジンが預かり、エンジンを畳むと消える */
  scheduleSystemEvent(delayMs: number, actionType: string, message: string): void;
}

/** 道具から見える、このエンジンの会話 */
export interface ToolConversation {
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

/* eslint-disable @typescript-eslint/no-explicit-any */
/** 道具から見える shell */
export interface ToolShell {
  /** 利用者の取っ手。利用者に見せるために読むときだけ使う（files・open） */
  userFs: VfsHandle;
  // プロセスと画面。いまは shell の実体をそのまま渡している（プロセスの持ち主を入れる段で取っ手に絞る）
  processManager?: any;
  resolver?: any;
  modals?: any;
  transport?: any;
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
