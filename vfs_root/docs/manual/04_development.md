# 04. App & Daemon Development Guide

This guide explains how to build custom applications and background services for Itera OS.

## 1. Foreground Apps

An App is an HTML file (usually in `apps/`) that provides a UI.
Use the system libraries (`ui.js` and `std.js`) to inherit the OS theme and standard data access.
(`system/core/` = the contract every app loads, `system/lib/` = opt-in first-party libraries such as `md.js`, `system/vendor/` = third-party code such as Tailwind. See `03_design_system.md`.)

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <script src="/system/vendor/tw.js"></script>
    <script src="/system/core/ui.js"></script>
    <script src="/system/core/std.js"></script>
</head>
<body class="bg-app text-text-main h-screen p-6">
    <button onclick="AppUI.home()" class="text-primary font-bold">Go Home</button>
    
    <script>
        // Use App.Storage (from std.js) for easy JSON Key-Value storage
        async function saveData() {
            await App.Storage.set('my_app_data', { message: 'Hello' });
        }
    </script>
</body>
</html>
```
To show your app in the Launcher, you must add it to the system registry at `system/registry/apps.json`.

### An app made of several files (relative paths, ES modules, `MetaOS.app`)

Keep an app's files in one folder and refer to them **relative to the file you are writing in**. Nothing inside the folder then needs to know where the folder is installed, so the app keeps working when it is moved or copied.

```
apps/mine/
├── index.html        <script type="module" src="./main.js">, <link rel="stylesheet" href="css/main.css">
├── main.js           import { load } from './lib/store.js';
├── lib/store.js      import { parse } from './parse.js';
├── lib/parse.js
├── css/main.css      @import "base.css";  background: url(../img/bg.png);
├── img/bg.png
└── assets/items.json
```

An app's document is not served from its VFS path (it is written into a sandboxed iframe, see `02_architecture.md` "The Guest Origin"). When the app starts, the OS reads its files and resolves the references that are **written statically**. "Relative" always means relative to the file that contains the reference; a leading `/` means the VFS root; URLs with a scheme (`https:`, `data:`, `blob:` …) and `//host/…` are left alone.

| In | Resolved forms |
| :-- | :-- |
| HTML | `src` / `href` of `script`, `link`, `img`, `iframe`, `video`, `audio`, `source`, `embed`, `track`, `input type="image"`; `object data`; `video poster`; `srcset` / `imagesrcset`; `href` of SVG `image` / `use` / `feImage`; `style` attributes and `<style>`; all of these inside `<template>` too |
| CSS | `url(...)`, `@import "..."`, `image-set("...")` |
| ES modules — `<script type="module" src>`, every module they import, and scripts written inline in the HTML (module or classic) | `import … from './x.js'`, `import './x.js'`, `export … from './x.js'`, `import('./x.js')` with a string literal, `new URL('./file.png', import.meta.url)` with a string literal, JSON modules (`import data from './x.json' with { type: 'json' }`) |

Notes on modules:

- Circular imports work, and a module imported from several places is one instance.
- Bare names (`import { h } from 'ui'`) work through the app's own `<script type="importmap">`; its targets are resolved from the HTML file's folder, and targets outside the VFS (`https://…`) are kept as they are. `scopes` and `integrity` have no effect, and keys that are paths (`"./a.js"`) are ignored.
- A query string on a specifier is dropped: `./a.js?v=2` and `./a.js` are the same module.
- A module that cannot be read fails when it is loaded, with `Cannot load module "<VFS path>": … (imported from <file>)`.
- Stack traces and the developer tools show modules as `vfs:///<VFS path>`.

**Nested documents.** An HTML file of the app that is written statically in a frame — `<iframe src="help/index.html">`, `<embed src>`, `<object data>` — starts the same way as the app itself: its own static references are resolved from _its_ folder, and it loads them. It is a separate document with its own opaque origin (`02_architecture.md` "The Guest Origin"), so:

- It has no `MetaOS`, no theme CSS, and no access to the app's DOM or variables. The two documents talk with `postMessage` (`frame.contentWindow.postMessage(msg, '*')` / `parent.postMessage(msg, '*')`).
- Files are per document: a module imported by both the app and the nested document is two instances.
- A frame that points back to its own document, or to a document it is nested in, is left as written (with a console warning).
- An HTML file referenced any other way — `fetch(new URL('./part.html', import.meta.url))` — is data: the text you get has its references resolved for the document that fetched it. Use it to insert a fragment into your own DOM, not as the `src` of a frame.

**Not resolved** — the OS either does not read the file or cannot know the value:

- Anything computed at run time: `img.src = './a.png'`, `fetch('./items.json')`, `import(name)`, `new Worker('./w.js')`. Use `MetaOS.app` (below).
- The contents of classic external scripts (`<script src>` without `type="module"`) and of Worker files. Keep a Worker in one self-contained classic file and start it with `new Worker(new URL('./worker.js', import.meta.url))`. (A module Worker with imports cannot be started from an opaque origin in a way that works in both Chromium and Firefox.)
- `<a href>` (links are navigation, which belongs to the OS) and inline event-handler attributes (`onclick="import('./x.js')"`).
- A frame whose `src` is set at run time (`frame.src = 'page.html'`). Write the frame in the HTML.

**`MetaOS.app` — where am I?** Synchronous, available as soon as the bridge is (no `await`):

| Member | Value |
| :-- | :-- |
| `MetaOS.app.path` | VFS path of the app's entry HTML, e.g. `apps/mine/index.html` |
| `MetaOS.app.dir` | Its folder, e.g. `apps/mine` (`''` at the VFS root) |
| `MetaOS.app.pid` | The process id |
| `MetaOS.app.resolve(rel)` | Relative path → VFS path, by the same rule the OS uses for static references: `'assets/x.json'`, `'./x'` and `'../shared/y'` are taken from the app's folder, a leading `/` is the VFS root |

```js
// A file next to the app, read as text
const items = JSON.parse(await MetaOS.fs.read(MetaOS.app.resolve('assets/items.json')));

// A file next to the app, as a URL chosen at run time
img.src = await MetaOS.fs.resolveUrl(MetaOS.app.resolve(`img/${name}.png`));
```

## 2. Background Daemons

Daemons are invisible HTML/JS files that run continuously in the background. They are perfect for timers, WebSocket connections (like Nostr), or cron jobs.

### Creating a Daemon (`system/services/logger.html`)
```html
<script>
    // Runs every 10 minutes
    setInterval(() => {
        // Log a silent event to the AI's history
        MetaOS.ai.log("System health is OK.", "health_check");
        
        // Notify the UI if it's open
        MetaOS.system.broadcast('system_health', { status: 'OK' });
    }, 10 * 60 * 1000);
</script>
```

### Auto-Starting Daemons
To make your daemon start automatically when Itera OS boots, register it in `system/registry/services.json` and set `"autoStart": true`:
```json
[
    {
        "id": "sys_logger",
        "name": "System Logger",
        "icon": "📝",
        "path": "system/services/logger.html",
        "description": "Periodically logs system health.",
        "autoStart": true
    }
]
```
Users can easily toggle the `autoStart` behavior from the System Settings app.

### System privilege (sync daemons only)

Every guest process touches the VFS as `{ type: 'app', id: <app id> }`. The app is *what is running*, not which process: the registry id of the file being run, or — for a file that is not in the registry — the name given at spawn (or a name derived from the path). Several processes of the same app share one principal. The area ACLs (`system/config/acl.json`) are evaluated for that principal. The agent's own area (`agent-only`) is readable by apps but writable only by the AI, so a sync daemon running as an app cannot write changes that arrived from another device into it — uploads succeed, downloads are silently skipped.

A daemon that mirrors another device (cloud sync) therefore needs the `system` principal, which bypasses the ACLs. The privilege is decided by *which file is running*: the file must be listed in `system/services/privileged.json` (`{ "systemPrivilege": ["system/services/<name>.html"] }`), and both that list and the file must be distribution files — files in a read-only area, which only the OS distribution (or the user in Sudo mode) can write. Nothing else grants it: not a `systemPrivilege` flag in `services.json`, not the name given at spawn, not a path that merely starts with `system/` (`system/temp/`, for example, is writable by anyone). Do not list anything that is not a sync provider.

## 3. Inter-Process Communication (IPC)

Itera allows completely decoupled communication between your daemons and your UI apps using `broadcast`.

**In Daemon (Sender):**
```javascript
MetaOS.system.broadcast('data_fetched', { newItems: 5 });
```

**In UI App (Receiver):**
```javascript
if (window.MetaOS) {
    MetaOS.system.on('data_fetched', (payload) => {
        AppUI.notify(`Received ${payload.newItems} items from background!`, 'success');
        refreshUI();
    });
}
```

### Reactive UI with VFS Mutations
To keep your app's UI perfectly synced with the file system without polling, listen to the `vfs_mutation` event. This uses a Change Data Capture (CDC) model.

```javascript
if (window.MetaOS) {
    MetaOS.system.on('vfs_mutation', (mutation) => {
        // mutation.type can be 'ATTACH', 'DETACH', or 'MUTATE'
        if (mutation.path.startsWith('data/my_app/')) {
            console.log('Fact changed:', mutation.type, mutation.path);
            refreshUI();
        }
    });
}
```

### Following OS Settings (`config_changed` / `theme_changed`)
The OS does not know your app. It only announces that its own state changed; whether and how to react is up to you.

*   **`theme_changed`** (`{}`): sent after the host has applied a new theme. The bridge swaps the theme CSS the OS injected into your app (`<style id="itera-guest-theme">`), so anything styled with the theme colors (`bg-app`, `text-main`, ... from `ui.js`) follows immediately. You do not need to write anything.
*   **`config_changed`** (`{ categories: [...] }`): sent when the merged value of a config category actually changed (rewriting the same value is not announced). The values are not included; read them again with `getConfig`. `std.js` wraps this:

```html
<script>
    // The interface language is appearance.locale (not preferences.language, which is the AI's language)
    const applyLocale = (appearance) => render(appearance.locale || 'en');
    App.Config.get('appearance').then(applyLocale);
    App.Config.onChange('appearance', applyLocale);
</script>
```

*   **Your app's text belongs to your app.** The OS translates only its own UI; it never reaches into an app.
    Keep your own strings in the app and choose them from `appearance.locale`.
*   **`<html lang>`**: if your HTML does not declare `lang`, the bridge sets it to the OS language and keeps it in sync.
    If you declare it, the OS leaves it alone.

*   **`registry_changed`** (`{ registries: ['apps' | 'services' | 'associations', ...] }`): sent when a merged registry actually changed (an app or daemon was added, removed or edited). Read it again with `getRegistry`, or use `App.Registry.onChange('apps', (apps) => ...)`.

These events go to every running app and daemon. Apps that ignore them keep working as before (the new values apply when they are reopened).

### Device-local state (`App.Local` / `MetaOS.storage.local`)

An app's state has three homes. Pick by *who should see it*:

| State | Home | Example |
| :-- | :-- | :-- |
| The data itself | VFS (`MetaOS.fs`, `App.Storage`) | notes, tasks, a project file |
| Settings that should be the same on every device | `App.Config` (`system.getConfig / updateConfig`; layered, synced where the build syncs the user layer) | locale, preferred model |
| Small per-device UI state | **`App.Local`** (`MetaOS.storage.local`) | which folders are open, whether the outline pane is shown |

`App.Local` is kept by the host in its own `localStorage`, one JSON record per process id. It never leaves the device, other apps cannot read it, values must be JSON-serializable and small (a few KB), and a failed write throws instead of being swallowed.

```javascript
let openFolders = (await App.Local.get('openFolders', [])) || [];   // read once at start-up
// ...
openFolders.push(path);
App.Local.set('openFolders', openFolders).catch((e) => console.warn(e));
// App.Local.remove('openFolders'); App.Local.keys();
```

🔴 Do **not** use `localStorage`, `sessionStorage` or `indexedDB` from an app: a guest runs in an opaque origin and those calls throw `SecurityError` (see "The Guest Origin" in [02_architecture.md](02_architecture.md) for the full list of what a guest can and cannot see). `App.Local` is the supported route.

## 4. Exposing Dynamic Tools to the AI

Guest apps can expose custom JS functions to the AI using `MetaOS.tools.register()`.

```javascript
MetaOS.tools.register({
    name: "edit_cell",
    description: "Edits a cell in the spreadsheet",
    definition: "<define_tag name=\"edit_cell\">Use this to edit a cell. Attributes: row, col</define_tag>",
    handler: async (params) => {
        document.getElementById(`cell-${params.row}${params.col}`).value = params.content;
        return { ui: `Edited ${params.row}${params.col}`, log: "Cell updated." };
    }
}).then(() => {
    // Teach the AI about the tool by logging its definition to history
    MetaOS.ai.log("<define_tag name=\"edit_cell\">...</define_tag>\\nTool is now available.", "tool_available");
});
```
When the app is closed (killed), tools registered by its PID are automatically removed by the OS.

Tool names are unique per engine: `register()` rejects when a tool of that name already exists (a system tool such as `read`, or a tool registered by another process), so a tool never ends up silently shadowed. Registering your own tool again replaces it. Pick names with an app prefix (`sheet_edit_cell`) to stay clear of other apps.

## 5. Network & Hardware Access

Browser iframes are usually restricted by CORS and permission policies. MetaOS provides high-level APIs to bypass these safely via the Host OS.

**Fetching External APIs (CORS Bypass)**
```javascript
// The Host will route this through a public proxy to avoid CORS errors.
const res = await MetaOS.net.fetch('https://api.example.com/data', { useProxy: true, responseType: 'json' });
console.log(res.data);
```

**Using the Camera**
```javascript
// Opens a beautiful, OS-native full-screen camera modal.
// Returns the image as a Base64 Data URL once the user snaps the photo.
const imageBase64 = await MetaOS.device.takePhoto({ facingMode: 'environment' });
```

## 6. Using OS-Native Dialogs (AppUI)

To maintain a consistent look and feel, **do not use browser native `alert()`, `confirm()`, or `prompt()`**. Instead, use the injected `window.AppUI` methods.

```javascript
// Simple Prompts
await AppUI.alert('Operation completed successfully.', 'Success');
const isSure = await AppUI.confirm('Are you sure you want to delete this?', 'Warning');
const name = await AppUI.prompt('Enter your name:', 'John Doe', 'Identity');

// Advanced Message Box
const result = await AppUI.showMessageBox({
    title: 'Unsaved Changes',
    message: 'You have unsaved changes. What would you like to do?',
    type: 'warning',
    buttons: [
        { label: 'Cancel', value: 'cancel', style: 'normal' },
        { label: 'Discard', value: 'discard', style: 'danger' },
        { label: 'Save', value: 'save', style: 'primary', isDefault: true }
    ],
    checkbox: {
        label: 'Do not ask me again',
        defaultChecked: false
    }
});
// result.value will be 'cancel', 'discard', or 'save'
// result.checkboxChecked will be true or false
```

## 7. Running an Engine of Your Own (`MetaOS.engine`)

`MetaOS.chat` talks to the conversation in the chat panel. When an app needs a conversation of its own — a reviewer that reads a document, a worker that runs a long job without filling the user's chat — it can ask the host for another engine.

```javascript
const e = await MetaOS.engine.create({
    // Both keys are optional.
    config: { llm: { model: 'provider/model' }, preferences: { maxContinuousTools: 30 } },
    // from: 'data/apps/reviewer/conv-12',   // continue a conversation written by e.save()
});

// Register listeners right after create resolves.
let reply = '';
e.on('turn_start', () => { reply = ''; });
e.on('stream_chunk', ({ text }) => { reply += text; render(reply); });
e.on('turn_end', ({ turn }) => upsertInTranscript(turn));   // placed or updated: key by turn.id
e.on('loop_stop', ({ reason, message }) => setBusy(false, reason, message));

// The engine has no boot protocol. Its role is the first message.
await e.append('user', 'You review Markdown documents. Read data/report.md and list the unclear sentences.', { wake: true });

// Later
await e.save('data/apps/reviewer/conv-12');   // session.json + media/, the format of a saved chat session
await e.dispose();
```

What to know:

*   **Ownership.** The engine belongs to the process that created it. No other process can address it, and it disappears when the owner calls `dispose()`, when the owner's process ends (closing the app is enough), or when the OS reloads. Nothing is kept unless the app calls `e.save(dir)`. At most 8 such engines are alive at a time.
*   **Same verbs as `MetaOS.chat`.** `append`, `wake`, `stop`, `reset` and `status` follow the same rules. `reset` does not archive: the conversation that is about to disappear arrives in the `reset` event (`{ session }`, the same object `save` writes), and the app decides whether to keep it.
*   **The app draws.** The host UI shows nothing for this conversation. `turn_end` carries a turn each time it is placed or updated — the user's, the model's, and system turns such as tool results. A tool-result turn arrives again as its results come in, so key what you draw by `turn.id`. `e.turns()` returns the whole conversation; read it right after `create`, because the conversation may already hold turns no event announced (a system turn listing the dynamic tools the engine can see; with `from`, the saved turns). What the model says to the user — `<report>`, `<ask>` — is in the model's turn.
*   **Tools and permissions** are those of the OS chat's AI. The engine also sees the dynamic tools registered with the OS chat. Processes it starts (`spawn`, `open`) serve it: their `MetaOS.chat` reaches this engine, it can end only those processes, and it can keep at most 4 windows open.
*   **What those processes can move.** A process acts on other processes as the engine it serves. `MetaOS.system.kill(pid)`, and a `MetaOS.system.spawn` that names a running pid (resume or restart), work only on processes serving the same engine; for any other process the call is rejected (`Process "…" serves another engine …`). What such a process opens — `MetaOS.host.open`, `MetaOS.host.goHome`, `MetaOS.nav.back` / `forward` — is an instance serving its engine (a second instance of the app if the OS chat already has one), never the OS chat's window. Processes that serve the OS chat's engine — every ordinary app and daemon — can act on any process, as before. Seeing is not restricted: `MetaOS.system.ps()` and `capture(pid)` cover every process. `system/logs/process_events/` records who moved a process (`by`: `os`, `user` or `engine`; with `byEngine`, and `via` when a guest process asked).
*   **Settings.** `config` is laid over the OS settings for this engine only; keys left out follow the OS when the user changes them. API keys and custom endpoints cannot be passed. Any key other than `config` and `from` is refused.
*   **Events.** `turn_start` `{ role, turnId }`, `stream_chunk` `{ text }`, `turn_end` `{ role, turn }`, `loop_stop` `{ reason, message? }` (`idle`, `abort`, `max_tools`, `not_configured`, `error`), `turn_placed` `{ turn }` (a system turn placed from outside), `reset` `{ session }`, `disposed` `{ reason }`. `stop()`, `reset()` and `dispose()` each announce a `loop_stop` with `abort`, also when the engine was idle. `e.on` throws on a name that is not in this list.
*   **Knowing that a run has ended.** Wait for `loop_stop`. Do not poll `status()` for it: `status()` is a snapshot, and between a tool result and the next generation (and right after `append(…, { wake: true })`) the engine waits a moment before it wakes — `running` and `busy` are both false then, and only `scheduled` is true. Nothing is in progress when `busy` and `scheduled` are both false. A scheduled evaluation does not always lead to a reply: it ends idle when nothing is unread — the one right after `create`, which looks at the turns the engine starts with, is an example.
*   **`status().context` with `from`.** Right after `create({ from })` it is that of the saved conversation (its last reply), until this engine replies.

## 8. Best Practices
1. **Semantic Colors**: Always use `bg-app`, `text-text-main`, `bg-panel` etc. (See 03_design_system.md).
2. **Context Awareness**: Use `App.AI.logEvent()` when the user performs an important action so the AI knows what's happening.
3. **Write Manuals**: When you build a complex app, write a `.md` manual in `docs/apps/` so both you and the AI understand how to use it.
