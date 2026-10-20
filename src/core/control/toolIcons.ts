/**
 * src/core/control/toolIcons.ts
 * Itera OS v2: 道具（タグ）の記号
 *
 * チャットパネルの MODEL 側（LpmlRenderer のタグ箱の見出し）と SYSTEM 側（各道具が返す `ui:` の 1 行）で
 * 同じ記号を使う。利用者は「📖 read」と「📖 Read memory/init.md」を同じ道具の往復として読む。
 * 記号を変えるときは両側をそろえる（SYSTEM 側は tools/*.ts の `ui:` に直書きしてある）。
 *
 * 登録の無いタグ（ゲストの動的な道具・偽装の tool_output など）は DEFAULT_TOOL_ICON。
 */

export const DEFAULT_TOOL_ICON = '⚙️';

export const TOOL_ICONS: Readonly<Record<string, string>> = {
  // 会話と制御
  thinking: '💭',
  memo: '🗒️',
  plan: '📅',
  report: '📢',
  ask: '❓',
  files: '🗂️',
  yield: '⏳',
  breathe: '💨',
  finish: '✅',

  // 中身（履歴に文字として入る）
  read: '📖',
  write: '📝',
  edit: '✏️',
  read_file: '📖', // 旧名（別名）
  create_file: '📝',
  edit_file: '✏️',

  // 物（丸ごと添付・場所・状態）
  attach_file: '📎',
  search: '🔍',
  list_files: '📂',
  file_info: 'ℹ️',
  delete_file: '🗑️',
  restore_file: '↩️',
  move_file: '🚚',
  copy_file: '📄',

  // プロセスと画面
  spawn: '🚀',
  open: '🪟',
  kill: '🛑',
  ps: '📊',
  take_screenshot: '📸',
  inject_js: '💉',

  // 時刻・セッション・道具
  get_time: '🕒',
  set_timer: '⏱️',
  reset_session: '♻️',
  tool_catalog: '🧰',
};

export function toolIcon(name: string): string {
  return TOOL_ICONS[name] ?? DEFAULT_TOOL_ICON;
}
