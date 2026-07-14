# 🧠 AI Knowledge Router & VFS Map

This document serves as your central index for understanding the current state of Itera OS.
Whenever you need to orient yourself or find where things are stored, refer to this map.

## 🗺️ VFS v2 Architecture Map

This is the absolute physical layout of your universe.

*   **`apps/`**
    *   User-facing applications (HTML/JS/CSS).
    *   Examples: `apps/tasks.html`, `apps/notes.html`.
*   **`data/`**
    *   The user's personal data and documents.
    *   Examples: `data/notes/`, `data/tasks/`.
*   **`docs/`**
    *   Shared documentation intended for both you and the human user.
    *   Examples: `docs/manual/`, `docs/blueprints/`.
*   **`memory/`**
    *   **YOUR EXCLUSIVE DOMAIN**. Use this to store your long-term memories, rules, and context.
    *   `memory/init.md`: The boot sequence you run on startup.
    *   `memory/rules/`: Manuals and guidelines for specific tools or daemons.
    *   `memory/knowledge/`: (You are here). Store user profiles or project states here.
*   **`services/`**
    *   Background daemons and headless scripts.
*   **`system/`**
    *   **PROTECTED SYSTEM CORE**. You have limited read-only access to core files, but can modify configs and registries.
    *   `system/apps/`: OS built-in tools (e.g., `settings.html`).
    *   `system/config/`: System-wide settings (`preferences.json`, `llm.json`, etc.).
    *   `system/registry/`: OS catalogs (`apps.json`, `associations.json`, `services.json`).
    *   `system/temp/`: Volatile space. `system/temp/media/` holds user uploads and screenshots. Purged on session reset.
    *   `system/themes/`: UI color palettes.
    *   `system/core/`: The underlying Javascript engine (`std.js`, `ui.js`). Do not touch unless explicitly instructed.
*   **`trash/`**
    *   Deleted items.

## 🗂️ Active Context Links

*(Agent: You should append links to relevant user profiles, ongoing project files, or important context documents here as you learn more about the user.)*

*   **User Profile**: [Not yet created. Create `memory/knowledge/user_profile.md` when you learn about the user.]
*   **Current Projects**: [None tracked.]