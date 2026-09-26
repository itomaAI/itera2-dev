# 05. Customization & System Configuration

Itera OS v2 uses a decentralized configuration model. Instead of a single massive file, settings are split into specific registries within the `system/` directory.

You can modify these files directly via the code editor, or have the AI agent do it for you using natural language.

## 1. System Settings (`system/config/`)

This directory holds the dynamic configuration of your OS environment.

*   **`preferences.json`**: Holds your identity, language and agent behavior settings.
    ```json
    {
      "username": "User",
      "agentName": "Itera",
      "language": "English",
      "autoUpdateSystemFiles": true,
      "maxContinuousTools": 50
    }
    ```
    `maxContinuousTools` caps how many tool executions the agent may chain without your input.
    **Set it to `0` to remove the limit entirely.**
    Unreadable values fall back to the default (50) rather than to "no limit".
    Once the limit is reached the agent stops and stays stopped: raising the limit does **not**
    resume it, because that would turn editing a config file into an unintended resume.
    Say something to the agent to let it continue.
*   **`llm.json`**: Configures the active AI provider and model.
    ```json
    {
      "model": "anthropic/claude-3-5-sonnet-20241022",
      "temperature": 1.0
    }
    ```
*   **`appearance.json`**: Controls the visual layout, the active theme path and the interface language (`locale`, e.g. `"ja"`).
    The interface language is separate from `preferences.language`, which is the language the AI answers in.
*   **`network.json`**: Configures the CORS proxy URL.

### Interface Language (`system/locales/`)

The OS menus, dialogs and notifications follow `appearance.locale`. Pick it in **Settings → Interface Language**.

*   English is built into the host, so the OS works even with no language files at all.
*   Other languages are JSON files named after the language: `system/locales/ja.json`, `zh-Hans.json`, ...
    Shipped: `ja`, `zh-Hans`, `zh-Hant`, `ko`, `es`, `fr`, `de`.
*   Files are layered: `system/locales/<lang>.json`, then `user/locales/<lang>.json` on top (create `user/locales/` if it does not exist).
    A key missing from both falls back to English. A more specific tag wins over a general one (`ja-JP.json` over `ja.json`).
*   Edits apply immediately, without a reload.
*   To change a few words, do not edit `system/locales` (OS updates overwrite it). Put only the keys you want to change in `user/locales/<lang>.json`:

```json
{
  "meta": { "name": "日本語", "englishName": "Japanese" },
  "messages": {
    "explorer.menu.addToContext": "AI に渡す"
  }
}
```

Translations are plain text (HTML is not interpreted). `{name}` marks a value filled in by the OS; keep it as is.
Plural forms use the keys of `Intl.PluralRules` (`{ "one": "...", "other": "..." }`).
The AI-facing text (tool results, error details, event logs) stays in English on purpose.

## 2. System Registries (`system/registry/`)

The registry tells the OS what apps exist and how to handle them.

### `apps.json` (Launcher Registry)
The list of apps shown in the **Library** (Launcher). If you build a new app, add an entry here.

```json
[
    {
        "id": "tasks",
        "name": "Tasks",
        "icon": "✅",
        "path": "system/apps/tasks.html",
        "description": "Manage daily to-dos"
    }
]
```

The Home screen builds its app list from this same list, so **an app appears on Home as soon as
it is registered** — you never edit `home.html` to add one. Two optional keys control that list:

*   `"home": false` — keep the app off the Home screen (it still shows in the Library).
*   `"home": 1` — pin it to the top of the list; smaller numbers come first.
    Entries without the key keep their registry order and follow the pinned ones.

```json
[
    {
        "id": "tasks",
        "name": "Tasks",
        "icon": "✅",
        "path": "system/apps/tasks.html",
        "description": "Manage daily to-dos",
        "home": 3
    }
]
```

### `associations.json` (File Associations)
Defines which app should automatically open when a user clicks a file in the Explorer.

```json
{
  "extensions": {
    "md": "notes",
    "txt": "notes"
  },
  "mimeTypes": {
    "text/markdown": "notes"
  }
}
```

### `services.json` (Background Daemons)
Defines background services and whether they should start silently when the OS boots. You can toggle these from the Settings app.

```json
[
    {
        "id": "my_crawler_daemon",
        "name": "Crawler Daemon",
        "icon": "🕷️",
        "path": "system/services/crawler.html",
        "description": "Fetches data in the background.",
        "autoStart": true
    }
]
```

### Making a built-in app your own

The built-in apps (Home, Notes, Tasks, Calendar, Loom, Settings, ...) live in `system/apps/`.
That folder is **read-only** (for you and for the AI) and is **overwritten by every OS update**, so the apps keep improving.
To change one, make your own copy and point the registry at it:

1. Copy it into your space, e.g. `system/apps/notes.html` → `apps/notes.html`, and edit the copy.
2. In `system/registry/apps.json`, change only the `path` of that entry to your copy (`"path": "apps/notes.html"`).
   For Home, set `appearance.layout.homePath` in `system/config/appearance.json` instead.
3. Nothing else changes: the app id stays the same, so file associations and links that use the id keep working,
   and the app's data stays where it was (`data/apps/...`).

Your copy no longer receives updates. The latest official version is always in `system/upstream/system/apps/`,
so you (or the AI) can compare and merge by hand. To go back, point `path` at `system/apps/...` again.

## 3. Creating Custom Themes (`system/themes/`)

Themes are JSON files. To create a new theme, create a new JSON file (e.g., `system/themes/hacker_green.json`) and define the color palette using Hex codes.

```json
{
    "meta": {
        "name": "Hacker Green",
        "author": "User"
    },
    "colors": {
        "bg": {
            "app": "#000000",       // Main background
            "panel": "#0a0a0a",     // Sidebars, Headers
            "card": "#111111",      // Input fields
            "hover": "#1a1a1a",     // Hover state background
            "overlay": "#000000"    // Backdrop tint color
        },
        "border": {
            "main": "#333333",      
            "highlight": "#00ff00"  
        },
        "text": {
            "main": "#00ff00",      
            "muted": "#008800",     
            "inverted": "#000000",  
            "system": "#00aa00"     
        },
        "accent": {
            "primary": "#00ff00",   
            "success": "#00ff00",   
            "warning": "#ffff00",   
            "error": "#ff0000"      
        }
    }
}
```

Once saved, open the **Settings** app. Your new theme will appear in the list automatically.

---

## Summary

Itera OS is built on absolute transparency.
Everything from the color of a button to the list of installed apps is just a file that you can read and write.
Explore, experiment, and build your perfect environment.

**End of Manual.**