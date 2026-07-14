# 04. App & Daemon Development Guide

This guide explains how to build custom applications and background services for Itera OS.

## 1. Foreground Apps

An App is an HTML file (usually in `apps/`) that provides a UI.
Use the system libraries (`ui.js` and `std.js`) to inherit the OS theme and standard data access.

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="../system/core/ui.js"></script>
    <script src="../system/core/std.js"></script>
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

## 2. Background Daemons

Daemons are invisible HTML/JS files that run continuously in the background. They are perfect for timers, WebSocket connections (like Nostr), or cron jobs.

### Creating a Daemon (`services/logger.html`)
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
        "path": "services/logger.html",
        "description": "Periodically logs system health.",
        "autoStart": true
    }
]
```
Users can easily toggle the `autoStart` behavior from the System Settings app.

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

## 6. Best Practices
1. **Semantic Colors**: Always use `bg-app`, `text-text-main`, `bg-panel` etc. (See 03_design_system.md).
2. **Context Awareness**: Use `App.AI.logEvent()` when the user performs an important action so the AI knows what's happening.
3. **Write Manuals**: When you build a complex app, write a `.md` manual in `docs/apps/` so both you and the AI understand how to use it.
