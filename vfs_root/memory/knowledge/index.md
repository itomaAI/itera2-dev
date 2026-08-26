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
*   **`system/`**
    *   **PROTECTED SYSTEM CORE**. You have limited read-only access to core files, but can modify configs and registries.
    *   `system/apps/`: OS built-in tools (e.g., `settings.html`).
    *   `system/config/`: System-wide settings (`preferences.json`, `llm.json`, etc.).
    *   `system/core/`: The guest runtime contract (`std.js`, `ui.js`). Do not touch unless explicitly instructed.
    *   `system/lib/`: Opt-in first-party shared libraries (`md.js`).
    *   `system/vendor/`: Third-party code vendored as-is (`tw.js`).
    *   `system/registry/`: OS catalogs (`apps.json`, `associations.json`, `services.json`).
    *   `system/services/`: OS built-in background daemons.
    *   `system/temp/`: Volatile space. `system/temp/media/` holds user uploads and screenshots. Purged on session reset.
    *   `system/themes/`: UI color palettes.
*   **`trash/`**
    *   Deleted items.

## 📋 The Work Board (Loom)

**This is where the long-running work lives. Check it at the start of every session.**

*   Cards: `data/apps/loom/*.md` (one node per file — **the files are the single source of truth**;
    the app does not need to be running).
*   **How you work with it: `memory/rules/loom.md`. Read it before you touch a card.**
*   Notation (the canonical spec): `docs/manual/loom_notation.md` — User guide: `docs/manual/loom.md`
*   Pick up your turn with:
    `<search query="^status: (todo|doing)" path="data/apps/loom" regex="true" context="0" />`
    (`todo` / `doing` are yours; `inbox` / `blocked` / `review` / `paused` belong to the user.)
*   Two containers: **projects** hold intent (a viewpoint that is never "done") and **knowledge**;
    **tasks** hold a completion condition and **the work**. Knowledge placed on a task is lost when it closes.

## 🗂️ Active Context Links

*(Agent: You should append links to relevant user profiles, ongoing project files, or important context documents here as you learn more about the user.)*

*   **User Profile**: [Not yet created. Create `memory/knowledge/user_profile.md` when you learn about the user.]
*   **Current Projects**: [None tracked.]