# 02. System Architecture

Understanding the internal structure of Itera OS v2 is essential for customizing the system and developing new applications.

## Directory Structure (VFS v2)

The Virtual File System is organized into specific domains. Some areas are strictly protected by the OS to prevent accidental corruption.

```text
/
├── apps/                   # [Application Layer] (Read/Write)
│   ├── tasks.html          # Standard apps live here
│   ├── calendar.html
│   └── ...
│
├── data/                   # [User Data Layer] (Read/Write)
│   ├── notes/              # Markdown files
│   ├── tasks/              # Task JSON databases
│   └── events/             # Calendar event data
│
├── docs/                   # [Documentation Layer] (Read/Write)
│   └── manual/             # Shared user/AI manuals (like this one)
│
├── memory/                 # [AI Cognitive Layer] (User: Read-Only, AI: Read/Write)
│   ├── init.md             # The AI's boot protocol
│   └── rules/              # AI knowledge and behavior guidelines
│
├── system/                 # [System Core Layer] (Strictly Protected)
│   ├── apps/               # OS built-in apps (Settings, etc.)
│   ├── config/             # Dynamic OS configuration
│   ├── core/               # Shared core libraries (std.js, ui.js)
│   ├── registry/           # App and Service registries
│   ├── services/           # OS built-in background daemons
│   ├── temp/               # [Volatile Layer] User uploads and screenshots. Purged on session reset.
│   └── themes/             # UI Themes (.json)
│
└── trash/                  # [Recycle Bin] (Read/Write)
    └── ...                 # Deleted files
```

---

## The MetaOS Bridge Protocol

The **Guest** environment (where apps run) is isolated from the **Host** (where the AI and File System live). To interact with the system, apps use the `window.MetaOS` asynchronous API.

### Core API Namespaces

*   **File System (`MetaOS.fs`)**:
    *   `.read(path)`: Reads a file.
    *   `.write(path, content, opts)`: Writes a file. To overwrite an existing file, you MUST pass `{ overwrite: true }` in `opts`.
    *   `.list(path, opts)`: Lists files and directories. (Returns `string[]` or an array of objects if `opts.detail=true`).
    *   `.stat(path)`: Returns file metadata as a plain object `{ id, path, name, kind, size, createdAt, updatedAt, mimeType, version, hash, flags, acl }`. *Note: Itera OS does NOT use Node.js `fs.Stats` objects. Check `kind === 'directory'` instead of calling `isDirectory()`.*
    *   `.getSyncState(path)`: Returns a lightweight, flat dictionary of file versions and hashes (`{ "path/to/file": { hash, version, updatedAt } }`) optimized for fast directory tree synchronization.
    *   `.resolveUrl(path)`: Resolves a VFS path to a usable Blob URL for `img.src` or CSS.
    *   `.createStub(path, meta)`: Creates a metadata-only entry (placeholder) in the VFS without uploading actual content. Useful for Cloud Sync providers.
    *   `.registerSyncProvider(path, { onMutate, onFetchContent })`: Declares that the current app is a Sync Provider. `onFetchContent(path)` is called to download real content for stubs. `onMutate(mutations)` receives array of VfsMutation (`ATTACH`, `DETACH`, `MUTATE`) avoiding echo-loops automatically.
    *   `.unregisterSyncProvider(path)`: Removes the sync provider registration.

*   **System & IPC (`MetaOS.system`)**:
    *   `.spawn(path, opts)`: Starts a process. \`opts: { pid, type, show, forceReload, args }\`. (\`show=true\` brings the app to the foreground, set \`forceReload=true\` to ignore cache. The OS automatically resolves the correct PID if omitted.)
    *   `.kill(pid)`: Terminates a process.
    
*   **Host UI (`MetaOS.host`)**:
    *   `.openEditor(path)`: Opens the Host's code editor fallback.
    *   `.notify(message, title)`: Sends a system toast notification.

*   **AI Interaction (`MetaOS.ai`)**:
    *   `.task(instruction, context, opts)`: Triggers the AI to perform a background task.
    *   `.log(message, type, opts)`: Appends an event to the AI's history (e.g., to inform the AI that a user clicked a button).

*   **Network & Hardware (`MetaOS.net`, `MetaOS.device`)**:
    *   `.fetch(url, opts)`: Fetches external APIs (can bypass CORS via proxy).
    *   `.takePhoto(opts)`: Opens the native camera interface.

*   **Dynamic Tools (`MetaOS.tools`)**:
    *   `.register(toolDef)`: Allows a Guest app to expose a custom JavaScript function as a new tool (LPML tag) for the AI to use.

---
**Next Step:** Proceed to [03_design_system.md](03_design_system.md) to learn how to create UI that matches the OS theme.