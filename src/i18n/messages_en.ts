/**
 * src/i18n/messages_en.ts
 * ホストの UI の英語の辞書（P-0046 / T-0545）。**英語の原文はここだけ**（VFS に英語の見本は置かない）。
 *
 * - 鍵は意味の名前（`<面>.<項目>`）。鍵の型（MessageKey）はこの表から作る
 * - 引数は `{name}`。複数形は `{ one, other }`（Intl.PluralRules の区分。`count` で選ぶ）
 * - 他の言語は `vfs_root/system/locales/<言語>.json`。鍵を足したら全言語へ足す（試験 locales.test.ts が欠けと余りを落とす）
 * - 🔴 AI の文脈に入る文（ツールの出力・例外の本文・チャット欄のイベント文・ログ）はここに入れない。英語に固定する
 */

export const EN = {

  // ---- common
  'common.ok': "OK",
  'common.cancel': "Cancel",
  'common.close': "Close",
  'common.save': "Save",
  'common.delete': "Delete",
  'common.rename': "Rename",
  'common.open': "Open",
  'common.skip': "Skip",
  'common.yes': "Yes",
  'common.no': "No",

  // ---- dialog
  'dialog.alert.title': "System Alert",
  'dialog.confirm.title': "Confirmation",
  'dialog.prompt.title': "Input Required",
  'dialog.loading': "Processing...",
  'dialog.conflict.title': "Item Already Exists",
  'dialog.conflict.message': "An item named \"{name}\" already exists in this location.",
  'dialog.conflict.detailFolder': "Do you want to merge the folders? Files with the same names will be replaced.",
  'dialog.conflict.detailFile': "Do you want to replace it with the one you are moving?",
  'dialog.conflict.merge': "Merge",
  'dialog.conflict.replace': "Replace",
  'dialog.conflict.keepBoth': "Keep Both",
  'dialog.conflict.applyToAll': "Do this for all current conflicts",

  // ---- shell (header, sidebar, status)
  'shell.boot.initializing': "Initializing Itera OS v2...",
  'shell.header.tagline': "REAL Architecture",
  'shell.status.online': "System Online",
  'shell.cloudSync': "Cloud Sync",
  'shell.cloudSyncWithDetail': "Cloud Sync — {detail}",
  'shell.sudo.enable': "Enable System Privileges",
  'shell.sudo.disable': "Disable System Privileges",
  'shell.sudo.dialogTitle': "Enable Sudo Mode",
  'shell.sudo.dialogMessage': "WARNING: Enabling System Privileges (Sudo) allows you to modify or delete core OS files.\n\nIncorrect actions may break the system. Are you sure you want to proceed?",
  'shell.sudo.confirm': "Enable Sudo",
  'shell.sudo.enabled': "System privileges enabled.",
  'shell.sudo.disabled': "System privileges disabled.",
  'shell.systemManagement': "System Management",
  'shell.storage': "Storage",
  'shell.saved': "Saved",
  'shell.newFile': "New File",
  'shell.newFolder': "New Folder",
  'shell.uploadFile': "Upload File",
  'shell.toggleExplorer': "Toggle Explorer",
  'shell.nav.back': "Back",
  'shell.nav.forward': "Forward",
  'shell.home': "Home",
  'shell.reload': "Reload",
  'shell.recentApps': "Recent Apps",
  'shell.toggleChat': "Toggle Chat",
  'shell.compiling': "Compiling...",
  'shell.statusbar.ready': "Ready",
  'shell.statusbar.runtime': "Itera Runtime (V2)",
  'shell.mobile.files': "Files",
  'shell.mobile.view': "View",
  'shell.mobile.chat': "Chat",

  // ---- shell (chat panel chrome)
  'chat.agentLabel': "Itera Agent",
  'chat.modelLoading': "Loading...",
  'chat.fullscreen': "Fullscreen",
  'chat.apiKeys': "API Keys",
  'chat.clearHistory': "Clear History",
  'chat.thinking': "Thinking...",
  'chat.inputPlaceholder': "Instructions... (Ctrl+Enter)",
  'chat.attachFile': "Attach file",

  // ---- system modal
  'systemModal.title': "System Management",
  'systemModal.backup': "Full Backup (ZIP)",
  'systemModal.export': "Export",
  'systemModal.import': "Import",
  'systemModal.diagnostics': "Diagnostics & Recovery",
  'systemModal.persistenceChecking': "Storage persistence: checking…",
  'systemModal.fsck': "Check & Repair VFS (fsck)",
  'systemModal.backupIndex': "Backup Index",
  'systemModal.restoreIndex': "Restore Index",
  'systemModal.dangerZone': "Danger Zone",
  'systemModal.dangerDescription': "This will permanently delete all files, settings, and apps from the system.",
  'systemModal.factoryReset': "Factory Reset",

  // ---- api keys modal
  'apiKeys.title': "API Keys",
  'apiKeys.save': "Save Keys",

  // ---- task switcher
  'taskSwitcher.title': "Recent Apps",

  // ---- boot notices
  'notice.storageLost': "Browser storage was cleared while Itera was running, so it was reloaded. Local files and chat history on this device are gone unless you have a backup or a sync target.",
  'notice.resetDone': "Local data has been reset to factory state.",
  'notice.resetFailed': "Could not erase local data. Close other tabs and try again: {reason}",
  'notice.repairClean': "Repair ran, but no problems were found in the file system.",
  'notice.repaired': { one: "Repaired the file system ({count} issue). Rescued files are in .lost+found.", other: "Repaired the file system ({count} issues). Rescued files are in .lost+found." },
  'notice.repairFailed': "Repair failed: {reason}",

  // ---- boot failure & tab guard
  'boot.error.title': "System Boot Error",
  'boot.error.hint': "Try \"Reload\" first. If this screen keeps coming back, try \"Repair and boot\". Use the factory reset only as a last resort.",
  'boot.action.reload': "Reload",
  'boot.action.repair': "Repair and boot",
  'boot.action.repairDescription': "Fixes mismatches between metadata and file contents before booting. Nothing is deleted (rescued files go to .lost+found).",
  'boot.action.factoryReset': "Factory reset (erase all data)",
  'boot.action.factoryResetDescription': "Erases all Itera files and chat history on this device and boots from a clean state. This cannot be undone. Make sure you have a backup (ZIP export or a sync target) first.",
  'boot.action.factoryResetConfirm': "This will erase all Itera files and chat history on this device. This cannot be undone.\nIf Itera is open in another tab, close it first.\n\nContinue?",
  'boot.action.factoryResetConfirmFinal': "Really erase everything? (final confirmation)",
  'boot.action.failed': "[{label}] failed: {reason}",
  'boot.waiting.message': "Itera is already open in another tab of this browser. Only one tab can run at a time.",
  'boot.waiting.title': "Already open in another tab",
  'boot.waiting.hint': "Continue in the other tab, or switch to this one.",
  'boot.waiting.useThisTab': "Use this tab",
  'boot.waiting.useThisTabDescription': "Stops the other tab and boots here. Anything already saved on this device carries over.",
  'boot.waiting.goToOther': "Go to the other tab",
  'boot.waiting.goToOtherDescription': "Some browsers do not allow switching tabs automatically. If nothing happens, switch by hand.",
  'guard.movedTab.title': "Moved to another tab",
  'guard.movedTab.body': "Itera is now running in another tab. You can close this one.",
  'guard.storageLost.title': "Browser storage was cleared",
  'guard.storageLost.body': "The data stored on this device was removed while Itera was running. Stopping and reloading.",
  // @@END
} as const satisfies Record<string, string | { one?: string; other: string; zero?: string; two?: string; few?: string; many?: string }>;

export type MessageKey = keyof typeof EN;
