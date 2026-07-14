# 05. Customization & System Configuration

Itera OS v2 uses a decentralized configuration model. Instead of a single massive file, settings are split into specific registries within the `system/` directory.

You can modify these files directly via the code editor, or have the AI agent do it for you using natural language.

## 1. System Settings (`system/config/`)

This directory holds the dynamic configuration of your OS environment.

*   **`preferences.json`**: Holds your identity and language settings.
    ```json
    {
      "username": "User",
      "agentName": "Itera",
      "language": "English",
      "autoUpdateSystemFiles": true
    }
    ```
*   **`llm.json`**: Configures the active AI provider and model.
    ```json
    {
      "model": "anthropic/claude-3-5-sonnet-20241022",
      "temperature": 1.0
    }
    ```
*   **`appearance.json`**: Controls the visual layout and active theme path.
*   **`network.json`**: Configures the CORS proxy URL.

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
        "path": "apps/tasks.html",
        "description": "Manage daily to-dos"
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
Defines which apps should start silently in the background when the OS boots.

```json
[
    {
        "pid": "my_crawler_daemon",
        "path": "apps/crawler.html"
    }
]
```

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