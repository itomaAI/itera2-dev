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
  'common.ok': 'OK',
  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.delete': 'Delete',
  'common.rename': 'Rename',
  'common.open': 'Open',
  'common.skip': 'Skip',

  // ---- dialog
  'dialog.alert.title': 'System Alert',
  'dialog.confirm.title': 'Confirmation',
  'dialog.prompt.title': 'Input Required',
  'dialog.loading': 'Processing...',
  'dialog.conflict.title': 'Item Already Exists',
  'dialog.conflict.message': 'An item named "{name}" already exists in this location.',
  'dialog.conflict.detailFolder': 'Do you want to merge the folders? Files with the same names will be replaced.',
  'dialog.conflict.detailFile': 'Do you want to replace it with the one you are moving?',
  'dialog.conflict.merge': 'Merge',
  'dialog.conflict.replace': 'Replace',
  'dialog.conflict.keepBoth': 'Keep Both',
  'dialog.conflict.applyToAll': 'Do this for all current conflicts',

  // ---- shell (header, sidebar, status)
  'shell.boot.initializing': 'Initializing Itera OS v2...',
  'shell.header.tagline': 'REAL Architecture',
  'shell.cloudSync': 'Cloud Sync',
  'shell.cloudSyncWithDetail': 'Cloud Sync — {detail}',
  'shell.sudo.enable': 'Enable System Privileges',
  'shell.sudo.disable': 'Disable System Privileges',
  'shell.sudo.dialogTitle': 'Enable Sudo Mode',
  'shell.sudo.dialogMessage':
    'WARNING: Enabling System Privileges (Sudo) allows you to modify or delete core OS files.\n\nIncorrect actions may break the system. Are you sure you want to proceed?',
  'shell.sudo.confirm': 'Enable Sudo',
  'shell.sudo.enabled': 'System privileges enabled.',
  'shell.sudo.disabled': 'System privileges disabled.',
  'shell.systemManagement': 'System Management',
  'shell.newFile': 'New File',
  'shell.newFolder': 'New Folder',
  'shell.uploadFile': 'Upload File',
  'shell.toggleExplorer': 'Toggle Explorer',
  'shell.nav.back': 'Back',
  'shell.nav.forward': 'Forward',
  'shell.home': 'Home',
  'shell.reload': 'Reload',
  'shell.recentApps': 'Recent Apps',
  'shell.toggleChat': 'Toggle Chat',
  'shell.compiling': 'Compiling...',
  'shell.statusbar.runtime': 'Itera Runtime (V2)',
  'shell.mobile.files': 'Files',
  'shell.mobile.view': 'View',
  'shell.mobile.chat': 'Chat',

  // ---- shell (chat panel chrome)
  'chat.agentLabel': 'Itera Agent',
  'chat.modelLoading': 'Loading...',
  'chat.fullscreen': 'Fullscreen',
  'chat.apiKeys': 'API Keys',
  'chat.clearHistory': 'Clear History',
  'chat.inputPlaceholder': 'Instructions... (Ctrl+Enter)',
  'chat.attachFile': 'Attach file',

  // ---- system modal
  'systemModal.title': 'System Management',
  'systemModal.backup': 'Full Backup (ZIP)',
  'systemModal.export': 'Export',
  'systemModal.import': 'Import',
  'systemModal.diagnostics': 'Diagnostics & Recovery',
  'systemModal.persistenceChecking': 'Storage persistence: checking…',
  'systemModal.fsck': 'Check & Repair VFS (fsck)',
  'systemModal.backupIndex': 'Backup Index',
  'systemModal.restoreIndex': 'Restore Index',
  'systemModal.dangerZone': 'Danger Zone',
  'systemModal.dangerDescription': 'This will permanently delete all files, settings, and apps from the system.',
  'systemModal.factoryReset': 'Factory Reset',

  // ---- api keys modal
  'apiKeys.title': 'API Keys',
  'apiKeys.save': 'Save Keys',

  // ---- task switcher
  'taskSwitcher.title': 'Recent Apps',

  // ---- boot notices
  'notice.storageLost':
    'Browser storage was cleared while Itera was running, so it was reloaded. Local files and chat history on this device are gone unless you have a backup or a sync target.',
  'notice.resetDone': 'Local data has been reset to factory state.',
  'notice.resetFailed': 'Could not erase local data. Close other tabs and try again: {reason}',
  'notice.repairClean': 'Repair ran, but no problems were found in the file system.',
  'notice.repaired': {
    one: 'Repaired the file system ({count} issue). Rescued files are in .lost+found.',
    other: 'Repaired the file system ({count} issues). Rescued files are in .lost+found.',
  },
  'notice.repairFailed': 'Repair failed: {reason}',

  // ---- boot failure & tab guard
  'boot.error.title': 'System Boot Error',
  'boot.error.hint':
    'Try "Reload" first. If this screen keeps coming back, try "Repair and boot". Use the factory reset only as a last resort.',
  'boot.action.reload': 'Reload',
  'boot.action.repair': 'Repair and boot',
  'boot.action.repairDescription':
    'Fixes mismatches between metadata and file contents before booting. Nothing is deleted (rescued files go to .lost+found).',
  'boot.action.factoryReset': 'Factory reset (erase all data)',
  'boot.action.factoryResetDescription':
    'Erases all Itera files and chat history on this device and boots from a clean state. This cannot be undone. Make sure you have a backup (ZIP export or a sync target) first.',
  'boot.action.factoryResetConfirm':
    'This will erase all Itera files and chat history on this device. This cannot be undone.\nIf Itera is open in another tab, close it first.\n\nContinue?',
  'boot.action.factoryResetConfirmFinal': 'Really erase everything? (final confirmation)',
  'boot.action.failed': '[{label}] failed: {reason}',
  'boot.waiting.message': 'Itera is already open in another tab of this browser. Only one tab can run at a time.',
  'boot.waiting.title': 'Already open in another tab',
  'boot.waiting.hint': 'Continue in the other tab, or switch to this one.',
  'boot.waiting.useThisTab': 'Use this tab',
  'boot.waiting.useThisTabDescription':
    'Stops the other tab and boots here. Anything already saved on this device carries over.',
  'boot.waiting.goToOther': 'Go to the other tab',
  'boot.waiting.goToOtherDescription':
    'Some browsers do not allow switching tabs automatically. If nothing happens, switch by hand.',
  'guard.movedTab.title': 'Moved to another tab',
  'guard.movedTab.body': 'Itera is now running in another tab. You can close this one.',
  'guard.storageLost.title': 'Browser storage was cleared',
  'guard.storageLost.body':
    'The data stored on this device was removed while Itera was running. Stopping and reloading.',

  // ---- shell notifications (error bodies stay English)
  'notify.cannotOpen': 'Cannot open: {reason}',
  'notify.cannotRun': 'Cannot run: {reason}',
  'notify.fileNotFound': 'File not found: {reason}',
  'notify.unknownSystemModal': 'Unknown system modal: {name}',
  'notify.notTextFile':
    'Not a text file, so it is not opened in the editor. Download it and open it with an app on your device.',
  'notify.daemonSpawned': 'Spawned {path} as daemon',
  'notify.daemonSpawnFailed': 'Failed to spawn daemon: {reason}',
  'notify.cannotOpenMedia': 'Cannot open media: {reason}',
  'notify.saveFailed': 'Save failed: {reason}',
  'notify.attachmentSaveFailed': 'Failed to save attachment: {reason}',
  'chat.clear.title': 'Clear Chat History',
  'chat.clear.message': 'Are you sure you want to clear the chat history and media cache?',
  'chat.clear.confirm': 'Clear History',

  // ---- chat panel
  'chat.files.open': 'Open',
  'chat.files.download': 'Download',
  'chat.files.missing': 'Not found',
  'chat.deleteMessage.title': 'Delete Message',
  'chat.deleteMessage.message': 'Are you sure you want to delete this message from the history?',
  'chat.cannotDownload': 'Cannot download: {reason}',
  'chat.media.loading': '[Loading media: {path}]',
  'chat.media.loadingImage': 'Loading image...',
  'chat.media.fileNotFound': '(File not found)',
  'chat.media.loadError': 'Error loading image: {reason}',
  'chat.media.imagePreview': 'Image Preview',
  'chat.media.binaryData': 'BINARY DATA',

  // ---- chat panel 2
  'chat.media.attachment': 'Attachment',

  // ---- explorer
  'explorer.cannotOpenFile': 'Cannot open file: {reason}',
  'explorer.create.titleFile': 'New File',
  'explorer.create.titleFolder': 'New Folder',
  'explorer.create.messageFile': 'Enter name for the new file:',
  'explorer.create.messageFolder': 'Enter name for the new folder:',
  'explorer.create.confirm': 'Create',
  'explorer.menu.newFile': 'New File',
  'explorer.menu.newFolder': 'New Folder',
  'explorer.menu.uploadFileHere': 'Upload File Here...',
  'explorer.menu.uploadFolderHere': 'Upload Folder Here...',
  'explorer.menu.runAsApp': '🖥️ Run as App',
  'explorer.menu.openIn': 'Open in {app}',
  'explorer.menu.runAsDaemon': '⚙️ Run as Daemon',
  'explorer.menu.fallbackRunAsApp': ' ↳ 🖥️ Run as App',
  'explorer.menu.addToContext': 'Add to Context',
  'explorer.menu.copyPath': 'Copy Path',
  'explorer.menu.duplicate': 'Duplicate',
  'explorer.menu.rename': 'Rename',
  'explorer.menu.move': 'Move',
  'explorer.menu.download': 'Download',
  'explorer.menu.properties': 'Properties',
  'explorer.menu.restore': 'Restore',
  'explorer.menu.delete': 'Delete',
  'explorer.menu.duplicateN': { one: 'Duplicate {count} item', other: 'Duplicate {count} items' },
  'explorer.menu.moveN': { one: 'Move {count} item', other: 'Move {count} items' },
  'explorer.menu.downloadN': { one: 'Download {count} item', other: 'Download {count} items' },
  'explorer.menu.restoreN': { one: 'Restore {count} item', other: 'Restore {count} items' },
  'explorer.menu.deleteN': { one: 'Delete {count} item', other: 'Delete {count} items' },
  'explorer.pathCopied': 'Path copied to clipboard',
  'explorer.copyFailed': 'Failed to copy: {reason}',
  'explorer.upload.progress': { one: 'Uploading {count} item...', other: 'Uploading {count} items...' },
  'explorer.upload.failedFor': 'Upload failed for {name}: {reason}',
  'explorer.upload.complete': { one: 'Upload complete: {count} item', other: 'Upload complete: {count} items' },
  'explorer.upload.sourceAndOthers': '{name} and others',
  'explorer.upload.analyzing': 'Analyzing files for upload...',
  'explorer.upload.noneFound': 'No files found to upload.',
  'explorer.upload.starting': {
    one: 'Starting upload: {count} file from "{source}"',
    other: 'Starting upload: {count} files from "{source}"',
  },
  'explorer.upload.importFailedFor': 'Import failed for {name}: {reason}',
  'explorer.upload.completeUploaded': {
    one: 'Upload complete: {count} item uploaded.',
    other: 'Upload complete: {count} items uploaded.',
  },
  'explorer.upload.noneUploaded': 'No files were uploaded.',
  'explorer.rename.title': 'Rename',
  'explorer.rename.message': 'Enter new name for the item:',
  'explorer.duplicate.progress': { one: 'Duplicating {count} item...', other: 'Duplicating {count} items...' },
  'explorer.download.failed': 'Download failed: {reason}',
  'explorer.download.compressing': { one: 'Compressing {count} item...', other: 'Compressing {count} items...' },
  'explorer.download.partial': {
    one: 'Download complete, but {count} file failed to read.',
    other: 'Download complete, but {count} files failed to read.',
  },
  'explorer.restore.title': 'Restore',
  'explorer.restore.unknownOrigin': 'Original location of "{name}" is unknown. Enter the path to restore to:',
  'explorer.restore.failed': 'Restore failed: {reason}',
  'explorer.restore.partial': 'Restored {restored} item(s), {failed} failed (e.g. {path}: {reason})',
  'explorer.restore.doneTo': 'Restored to {path}',
  'explorer.restore.done': { one: 'Restored {count} item', other: 'Restored {count} items' },
  'explorer.delete.title': 'Delete Items',
  'explorer.delete.message': {
    one: 'Are you sure you want to delete {count} item?',
    other: 'Are you sure you want to delete {count} items?',
  },
  'explorer.delete.progress': { one: 'Deleting {count} item...', other: 'Deleting {count} items...' },
  'explorer.delete.failed': 'Delete failed: {reason}',
  'explorer.delete.partial': 'Deleted {deleted} item(s), {failed} failed (e.g. {path}: {reason})',
  'explorer.move.skippedIntoItself': 'Skipped {name}: Cannot move into itself.',
  'explorer.move.replaceFailed': 'Replace failed: {reason}',
  'explorer.move.titleOne': 'Move Item',
  'explorer.move.titleMany': 'Move Items',
  'explorer.move.messageOne': 'Enter destination folder path for "{name}":',
  'explorer.move.messageMany': 'Enter destination folder path for {count} items:',
  'explorer.merge.progress': 'Merging directories...',
  'explorer.merge.failed': 'Merge failed: {reason}',

  // ---- explorer 2
  'explorer.move.progress': { one: 'Moving {count} item...', other: 'Moving {count} items...' },
  'explorer.copy.progress': { one: 'Copying {count} item...', other: 'Copying {count} items...' },

  // ---- properties modal
  'properties.title': 'Properties',
  'properties.tab.general': 'General',
  'properties.tab.permissions': 'Permissions',
  'properties.apply': 'Apply Changes',
  'properties.cannotOpen': 'Cannot open properties: {reason}',
  'properties.kind': 'Kind:',
  'properties.kind.file': 'File',
  'properties.kind.directory': 'Directory',
  'properties.size': 'Size:',
  'properties.where': 'Where:',
  'properties.created': 'Created:',
  'properties.modified': 'Modified:',
  'properties.perm.intro': 'Control who can access or modify this item.',
  'properties.perm.advanced': '🔒 Advanced (Sudo)',
  'properties.perm.owner': 'Owner',
  'properties.perm.ownerSystem': 'System (kernel)',
  'properties.perm.ownerUser': 'User (local_user)',
  'properties.perm.ownerAgent': 'Agent (Itera_AI)',
  'properties.perm.localUser': 'Local User',
  'properties.perm.readWrite': 'Read & Write',
  'properties.perm.readOnly': 'Read Only',
  'properties.perm.noAccess': 'No Access',
  'properties.perm.aiAgent': 'AI Agent',
  'properties.perm.aiAgentDescription': 'Autonomous modifications',
  'properties.perm.guestApps': 'Guest Apps',
  'properties.perm.guestAppsDescription': 'Any installed application',
  'properties.perm.recursive': 'Apply to enclosed items',
  'properties.perm.applying': 'Applying permissions...',
  'properties.perm.updated': 'Permissions updated',
  'properties.perm.saveFailed': 'Failed to save: {reason}',

  // ---- tree view
  'tree.tooltip': 'Size: {size}\nUpdated: {updated}',
  'tree.synced': 'Synced',
  'tree.syncedStub': 'Synced (content is on the host)',

  // ---- system modal actions
  'systemModal.reset.title': 'Factory Reset',
  'systemModal.reset.message':
    'WARNING: This will permanently delete ALL files and settings.\n\nAre you absolutely sure you want to proceed?',
  'systemModal.reset.confirm': 'Reset System',
  'systemModal.persistenceGranted': "Storage persistence: granted — the browser will not evict this site's data.",
  'systemModal.persistenceDenied':
    "Storage persistence: not granted — the browser may evict this site's data under storage pressure. Export a backup regularly.",
  'systemModal.persistenceUnknown': 'Storage persistence: unknown.',
  'systemModal.backup.creating': 'Creating Backup...',
  'systemModal.backup.skippedNote': {
    one: ' Skipped {count} provider-managed file (see {manifest}).',
    other: ' Skipped {count} provider-managed files (see {manifest}).',
  },
  'systemModal.backup.exportedWithErrors': {
    one: 'Backup Exported, but {count} file failed to read.{note}',
    other: 'Backup Exported, but {count} files failed to read.{note}',
  },
  'systemModal.backup.exported': 'Backup Exported.{note}',
  'systemModal.backup.exportFailed': 'Export failed: {reason}',
  'systemModal.restore.title': 'Restore Backup',
  'systemModal.restore.message':
    'CAUTION: This will ERASE all current files and restore from "{name}".\n\nAre you sure you want to continue?',
  'systemModal.restore.confirm': 'Restore',
  'systemModal.restore.progress': 'Restoring Backup...',
  'systemModal.restore.complete': {
    one: 'Restore Complete: {count} file. Reloading...',
    other: 'Restore Complete: {count} files. Reloading...',
  },
  'systemModal.restore.failed': 'Restore Failed: {reason}',
  'systemModal.fsck.progress': 'Checking VFS Consistency...',
  'systemModal.fsck.clean': 'File system is clean. No errors found.',
  'systemModal.fsck.repaired':
    "Repaired {total} issues:\n- Circular References: {circular}\n- Orphans Rescued: {orphans}\n- Missing Contents Fixed: {missing}\n- Dangling Contents Rescued: {dangling}\n\nCheck '.lost+found' folder in root if files were rescued.",
  'systemModal.fsck.failed': 'Repair failed: {reason}',
  'systemModal.index.exported': 'Index Backup Exported',
  'systemModal.index.exportFailed': 'Index backup failed: {reason}',
  'systemModal.index.restoreTitle': 'Restore Index',
  'systemModal.index.restoreMessage':
    'CAUTION: This will overwrite your entire file system index with "{name}".\nAre you sure you want to proceed?',
  'systemModal.index.restoreConfirm': 'Restore Index',
  'systemModal.index.restoring': 'Restoring Index...',
  'systemModal.index.restored': 'Index restored. Reloading system...',
  'systemModal.index.restoreFailed': 'Index Restore Failed: {reason}',

  // ---- file picker
  'filePicker.selectFile': 'Select a File',
  'filePicker.selectFolder': 'Select a Folder',
  'filePicker.selectItem': 'Select an Item',
  'filePicker.allFiles': 'All Files',
  'filePicker.foldersOnly': 'Folders only',
  'filePicker.allowed': 'Allowed: {list}',
  'filePicker.noFileSelected': 'No file selected',
  'filePicker.noFolderSelected': 'No folder selected',
  'filePicker.noItemSelected': 'No item selected',
  'filePicker.fileName': 'File name',
  'filePicker.invalidType': 'Invalid file type selected.',
  'filePicker.selectAFolder': 'Select a folder',
  'filePicker.overwrite': '{path} already exists. Overwrite?',
  'filePicker.saveAs': 'Save As',

  // ---- command palette
  'palette.placeholder': 'Search files, apps, or ask AI...',
  'palette.navigate': 'Navigate',
  'palette.select': 'Select',
  'palette.close': 'Close',
  'palette.settings.title': 'System Settings',
  'palette.settings.subtitle': 'Preferences, Theme, LLM, Network',
  'palette.apiKeys.title': 'API Keys',
  'palette.apiKeys.subtitle': 'Manage LLM API Secrets',
  'palette.monitor.title': 'Activity Monitor',
  'palette.monitor.subtitle': 'View background processes',
  'palette.appSubtitle': 'App • {path}',
  'palette.fileSubtitle': 'File • /{path}',
  'palette.askAi': 'Ask AI: "{query}"',
  'palette.askAiSubtitle': 'Itera Agent',
  'palette.noResults': 'No results found.',

  // ---- activity monitor
  'monitor.title': 'Activity Monitor',
  'monitor.subtitle': 'Real-time Process List',
  'monitor.autoUpdating': 'Auto-updating (1s)',
  'monitor.killAll': 'Kill All Daemons',
  'monitor.killAllMessage': 'Are you sure you want to terminate all background daemons?',
  'monitor.killAllConfirm': 'Kill All',
  'monitor.empty': 'No processes running.',

  // ---- sync modal
  'sync.title': 'Cloud Sync',
  'sync.subtitle': 'Sync Providers',
  'sync.localOnly': 'Local Mode Only',
  'sync.notSignedIn': 'Not Signed In',
  'sync.noAdapters': 'No sync adapters installed.',
  'sync.active': 'Cloud Sync Active',
  'sync.online': 'Online',

  // ---- media, recorder, editor, misc
  'audio.stopAndSave': 'Stop & Save',
  'apiKeys.loading': 'Loading providers...',
  'apiKeys.saved': 'API Keys saved.',
  'media.previewNotAvailable': 'Preview Not Available',
  'media.unknownType': 'Unknown Type',
  'media.downloadFile': 'Download File',
  'taskSwitcher.empty': 'No recent apps',
  'editor.binaryNotSupported': 'Binary file editing is not supported.',
  'editor.saved': 'Saved!',
  'editor.saveFailed': 'Failed',
  'process.notFound': 'No {path} found.',
  'process.launchFailed': 'Failed to launch {path}',
  'guest.fileNotFound': 'File not found',
  'guest.notAFile': 'Not a file (directory)',
  'sync.status.loadFailed': 'Load failed',
  'sync.status.noAdapters': 'No Adapters',
  'sync.status.connected': 'Connected',
  'sync.status.connectedN': '{count} Connected',
  'sync.status.connecting': 'Connecting...',
  'sync.status.error': 'Error',
  'chat.exitFullscreen': 'Exit fullscreen (Esc)',

  // ---- oauth dialog
  'oauth.pasteToken': "Paste access token for '{provider}':",
  'oauth.saveToken': 'Save Token',
  // @@END
} as const satisfies Record<
  string,
  string | { one?: string; other: string; zero?: string; two?: string; few?: string; many?: string }
>;

export type MessageKey = keyof typeof EN;
