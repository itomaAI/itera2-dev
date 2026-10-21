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
│   ├── locales/            # Interface language files (.json). English is built into the host
│   ├── core/               # Shared core libraries (std.js, ui.js)
│   ├── registry/           # App and Service registries
│   ├── services/           # OS built-in background daemons
│   ├── temp/               # [Volatile Layer] sessions/<id>/ holds each chat session's uploads and screenshots. Deleted with the session. Not synced.
│   └── themes/             # UI Themes (.json)
│
└── trash/                  # [Recycle Bin] (Read/Write). Not synced — per device.
    └── <deletedAt>_<name>  # Flat. Each entry remembers where it came from (stat().trashedFrom / deletedAt);
                            # MetaOS.fs.restore(path) puts it back (never overwrites: "name (2).ext"). Not purged automatically.
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
    *   `.registerSyncProvider(path, { onMutate, onFetchContent, onMove? })`: Declares that the current app is a Sync Provider. `onFetchContent(path)` is called to download real content for stubs. `onMutate(mutations)` receives array of VfsMutation (`ATTACH`, `DETACH`, `MUTATE`) avoiding echo-loops automatically. `onMove(oldPath, newPath)` (optional) moves the remote record for a rename inside the same provider: the host calls it **before** moving the local node, and only skips fetching stubs when it returns `true` (`false` / an exception means nothing was changed, and the host falls back to fetching). The capability is derived from the presence of the function (the bridge reports `capabilities.move`; see `listMounts()`).
    *   A stub is fetched **before its path changes**: `rename` / `copy` / `delete` (to trash) / `restore` first download every stub under the source, because a provider knows contents only by path and a moved stub could never be fetched again. If one cannot be fetched, the operation fails with `ESTUB` and nothing is changed. The only exception is a `rename` inside one provider that offers `onMove` (not into `trash/`, not the provider's own rename).
    *   `.unregisterSyncProvider(path)`: Removes the sync provider registration.

*   **System & IPC (`MetaOS.system`)**:
    *   `.spawn(path, opts)`: Starts a process. \`opts: { pid, type, show, forceReload, args }\`. (\`show=true\` brings the app to the foreground, set \`forceReload=true\` to ignore cache. The OS automatically resolves the correct PID if omitted.)
    *   `.kill(pid)`: Terminates a process.
    
*   **Host UI (`MetaOS.host`)**:
    *   `.openEditor(path)`: Opens the Host's code editor fallback.
    *   `.notify(message, title)`: Sends a system toast notification.

*   **Chat (`MetaOS.chat`)** — the primitive operations on the conversation. None of them needs the LLM to be responsive, so a daemon can use them to recover a stuck session (e.g. a `/reset` received over Telegram):
    *   `.append(role, content, opts)`: Puts one turn in the history. `role` is `'user'` or `'system'`; `content` is a string or an array of `{text}` / `{media:{path}}` parts; `opts: { wake=false, visible=true, eventType, attachments }`. Returns `{ id }`.
    *   `.wake()`: Asks the engine to evaluate the history (idle if nothing is unread). `.stop()`: aborts generation.
    *   `.reset({ summary, restoreTools=true })`: Clears the conversation (the current one is archived to the session history). It does not wake the AI; the next message does, and the AI reads `summary` then. Returns `{ archived, sessionId }`.
    *   `.status()`: Engine state, turn count, current session and the last context size from the usage log.
    *   `.sessions()` / `.switchSession(id)` / `.saveSession(id)` / `.loadSession(path)`: the session history.

*   **AI Interaction (`MetaOS.ai`)** — thin wrappers over `MetaOS.chat`:
    *   `.ask(text, opts)`: Sends a chat message as the user and wakes the AI (`opts.silent=true` only places it).
    *   `.task(instruction, context, opts)`: Triggers the AI to perform a background task.
    *   `.log(message, type, opts)`: Appends an event to the AI's history (e.g., to inform the AI that a user clicked a button). Pass `opts.trigger_llm=true` to wake the AI (debounced 1.5s).

*   **Network & Hardware (`MetaOS.net`, `MetaOS.device`)**:
    *   `.fetch(url, opts)`: Fetches external APIs (can bypass CORS via proxy).
    *   `.takePhoto(opts)`: Opens the native camera interface.

*   **Vendor libraries (`MetaOS.vendor`)**: Large third-party libraries (pdf.js, MathJax, Monaco) ship with the host under its `vendor/` directory, not in the VFS, and are fetched only when used. A guest never guesses the host URL (no `window.top.location`); it asks:
    *   `.resolve(name)`: Returns `{ name, version, url, entry, worker, dirs }` with absolute URLs (`url` is the library directory; `entry` the main module; `worker` the Web Worker if any). Throws when the name is not in this build, listing what is available.
    *   `.list()`: Names available in this build. The catalog is `vendor/manifest.json`, written at build time by `scripts/copy_vendor.js`.
*   **Dynamic Tools (`MetaOS.tools`)**:
    *   `.register(toolDef)`: Allows a Guest app to expose a custom JavaScript function as a new tool (LPML tag) for the AI to use.

---
**Next Step:** Proceed to [03_design_system.md](03_design_system.md) to learn how to create UI that matches the OS theme.