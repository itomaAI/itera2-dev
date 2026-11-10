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

## The Guest Origin

A guest (an app or a daemon) runs in a sandboxed iframe **without** `allow-same-origin`. Its document therefore has an **opaque origin**: it is not the host's origin, and it is not any other origin either. Everything a guest gets from the host comes through `window.MetaOS` (postMessage); nothing comes through the browser's same-origin plumbing.

What that means for an app, in one table:

| Observable | Value in a guest | Use instead |
| :-- | :-- | :-- |
| `self.origin` | `"null"` | — |
| `location.href` | `about:srcdoc` (the body is written into the bootstrap document, see below) | Do not derive paths from the URL. The app's VFS path is not visible; arguments come in `__ITERA_ARGS__` |
| `localStorage` / `sessionStorage` / `indexedDB` | throw `SecurityError` | `App.Local` / `MetaOS.storage.local` (device-local), `MetaOS.system.getConfig` (synced settings), the VFS (documents) |
| `parent.document`, `window.top.location`, `document.referrer`, `location.ancestorOrigins` | not readable / empty | `MetaOS.vendor.resolve(name)` for host-shipped assets; `MetaOS.host.*` for host UI |
| `new Worker('https://…')` | refused (a Worker must be same-origin with its document) | fetch the script and start the Worker from a URL you own: a `blob:` URL for a classic worker, a `data:` URL for a **module** worker (Chromium refuses module workers from `blob:` in an opaque origin). Hand the Worker object to the library (pdf.js: `workerPort`), not the URL (`pdf_tool.html` does this) |
| `fetch(url)` to an external service | sent with `Origin: null` | `MetaOS.net.fetch` (host origin, proxy, credentials) when the service cares about `Origin` |
| `MetaOS.fs.resolveUrl(path)` | returns `blob:null/…`, created in the app's own window | — (contract unchanged: path → URL string, valid in this document only) |
| `navigator.clipboard.writeText` on a user gesture | allowed (`clipboard-write` is delegated to the iframe); `readText` is not | paste arrives as a user action (`paste` event) |
| `target="_blank"` links | open outside the sandbox (`allow-popups-to-escape-sandbox`) | — |

How a guest document comes to exist: the host puts a small bootstrap in the iframe's `srcdoc`; the bootstrap asks the host for the compiled body (`sys:boot`), receives the entry HTML with its static references replaced by markers plus the referenced files as `Blob` handles, creates `object URL`s **in its own window**, substitutes the markers and writes the body into the same document. The host never hands a URL to a guest, because a URL made by the host would not be readable here.

### Contents are immutable; names move; a handed-out handle lives until it is given back or its process ends

The `Blob` handles above are files in the host's OPFS. An OPFS `File` obtained with `getFile()` becomes unreadable the moment the entry it came from is overwritten, deleted or replaced (Chromium `NotReadableError`, Firefox `AbortError`; a `fetch` of an object URL made from it fails with `TypeError`). Wrapping it in a new `Blob` does not help; only bytes already expanded with `arrayBuffer()` survive. So the VFS never overwrites an entry:

- Every write goes to a **new key**, `<nodeId>@<version>` (the version the VFS already increments on each write). The node's `contentRef` is switched to the new key after the content is on disk.
- The old key is deleted only if no process holds a handle to it. The host records the holder whenever it hands a `Blob` to a guest — the assets of `sys:boot` and the answer to `MetaOS.fs.resolveUrl` (`fs:read_blob`) — as the guest's pid. When that process is killed, its holds are released and keys that no node references any more are removed. Holds are counted per hand-out, and a URL from `resolveUrl` can be given back earlier: `URL.revokeObjectURL(url)` releases that one hand-out (the bridge wraps the call and tells the host). The assets of `sys:boot` are held until the process ends.
- The host's own reads follow the same rule. A read that expands the content (`MetaOS.fs.read` in any encoding, the AI's `read`) holds the key for as long as it is reading and lets go when it is done, so a write that lands in the middle cannot pull the old version away from it: the read returns the version it started with.
- Keys left behind by a crash (a reload before the kill) are removed by `fsck` at the next start: a key whose node has moved on to a newer version is stale and is deleted, not rescued into `.lost+found`.

For an app this means: an image, font or model that a document references lazily keeps working even if another app (or the AI) overwrites that file while the document is open. The document sees the version it was started with; a fresh `spawn` sees the new one. `copy_file` and `rename` are unaffected (a copy is a new node, a rename does not touch the content).

## The MetaOS Bridge Protocol

The **Guest** environment (where apps run) is isolated from the **Host** (where the AI and File System live). To interact with the system, apps use the `window.MetaOS` asynchronous API.

### Core API Namespaces

*   **File System (`MetaOS.fs`)**:
    *   `.read(path)`: Reads a file.
    *   `.write(path, content, opts)`: Writes a file. To overwrite an existing file, you MUST pass `{ overwrite: true }` in `opts`. `opts.ifVersion` (optional) makes the write conditional: the host compares it with the file's current `version` inside the write lock and refuses with an error whose `code` is `'ESTALE'` — nothing is written — when they differ (`ifVersion: 0` = "must not exist yet"). Without `ifVersion` the last writer wins, as before.
    *   `.read(path, { withVersion: true })`: Returns `{ content, version }` (text only). The version is taken before the content is read, so a stale content is never paired with a newer version.
    *   `.update(path, updater, opts)`: Read-modify-write guarded by versions. Reads with the version, calls `updater(content, version)` (return the new text, or `null` to leave the file untouched), writes with `ifVersion`, and on `ESTALE` reads again and re-applies `updater` (up to `opts.maxAttempts`, default 8). Returns `{ message, version, attempts }`. Use this instead of a `read` + `write` pair whenever anything else (the AI, another app, a sync provider) may write the same file; a plain pair silently loses one of two concurrent edits. The AI's `edit` / `write append` tools go through the same mechanism.
    *   `.list(path, opts)`: Lists files and directories. (Returns `string[]` or an array of objects if `opts.detail=true`).
    *   `.stat(path)`: Returns file metadata as a plain object `{ id, path, name, kind, size, createdAt, updatedAt, mimeType, version, hash, flags, acl }`. *Note: Itera OS does NOT use Node.js `fs.Stats` objects. Check `kind === 'directory'` instead of calling `isDirectory()`.*
    *   `.getSyncState(path)`: Returns a lightweight, flat dictionary of file versions and hashes (`{ "path/to/file": { hash, version, updatedAt } }`) optimized for fast directory tree synchronization.
    *   `.resolveUrl(path)`: Resolves a VFS path to an object URL usable in `img.src` or CSS. The URL is created inside the app's own window (the host hands over the file as a Blob handle, no bytes are copied), so it is valid only in that document and is released with it. The host keeps the version of the file the URL points to on disk for as long as the URL lives, even after the file is deleted or rewritten — so in a long-running app or daemon, call `URL.revokeObjectURL(url)` once nothing reads from the URL any more (after an image has loaded, after a player has moved on). Do not revoke while something is still reading from it: if the file is rewritten afterwards, that reader loses its source.
    *   `.createStub(path, meta)`: Creates a metadata-only entry (placeholder) in the VFS without uploading actual content. Useful for Cloud Sync providers.
    *   `.registerSyncProvider(path, { onMutate, onFetchContent, onMove? })`: Declares that the current app is a Sync Provider. `onFetchContent(path)` is called to download real content for stubs. `onMutate(mutations)` receives array of VfsMutation (`ATTACH`, `DETACH`, `MUTATE`) avoiding echo-loops automatically. `onMove(oldPath, newPath)` (optional) moves the remote record for a rename inside the same provider: the host calls it **before** moving the local node, and only skips fetching stubs when it returns `true` (`false` / an exception means nothing was changed, and the host falls back to fetching). The capability is derived from the presence of the function (the bridge reports `capabilities.move`; see `listMounts()`).
    *   A stub is fetched **before its path changes**: `rename` / `copy` / `delete` (to trash) / `restore` first download every stub under the source, because a provider knows contents only by path and a moved stub could never be fetched again. If one cannot be fetched, the operation fails with `ESTUB` and nothing is changed. The only exception is a `rename` inside one provider that offers `onMove` (not into `trash/`, not the provider's own rename). `append` also fetches a stub first (appending depends on the existing contents); `write` does not (it replaces them). `delete(path, { permanent: true })` never fetches.
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
    *   The catalog is not only for libraries: a **distribution** (a build of Itera for a demo or a product) can ship its own large assets (a model, a dataset) the same way by listing them in `vendor.extra.json` at the repository root; `copy_vendor.js` copies them under `vendor/<name>/` and adds them to the catalog (see [05_customization.md](05_customization.md)). An app then asks `MetaOS.vendor.resolve('<name>')` instead of guessing the host URL or reading `document.referrer` / `location.ancestorOrigins`.
*   **Dynamic Tools (`MetaOS.tools`)**:
    *   `.register(toolDef)`: Allows a Guest app to expose a custom JavaScript function as a new tool (LPML tag) for the AI to use.

---
**Next Step:** Proceed to [03_design_system.md](03_design_system.md) to learn how to create UI that matches the OS theme.