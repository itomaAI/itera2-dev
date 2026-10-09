# 01. User Guide

This guide explains how to navigate the Itera OS v2 interface and use its core features.

## The Interface

The Itera interface consists of three main areas:

1.  **Sidebar (Left)**: File Explorer, Storage Usage, and System Controls.
2.  **Workspace (Center)**: The main screen where apps and the dashboard run.
3.  **Chat Panel (Right)**: The interface for communicating with the AI Agent.

---

## 1. Dashboard & Navigation

When you boot Itera, you see the **Dashboard**. This is your home base.

*   **Header**: A greeting based on the time of day, the date, the weather and the model the AI is using now.
*   **Left column — Apps and System**:
    *   **Apps**: Quick access to the registered applications. Click "Library" to see all installed apps.
    *   **System**: How long the current conversation is (tokens against the model's context window, when the model list states it), storage used on this device (click to open the trash), and the machines connected through Local Bridge.
*   **Center column — Loom**: The open Loom cards, split into **Your turn** (blocked, review, inbox, paused) and **the AI's turn** (doing, to do). Click a card to open it in Loom.
*   **Right column — Calendar, Tasks and Notes**: This month's calendar with today's events, your active tasks (nearest due date first; tick to complete, click to edit), your recent notes and the AI's latest journal entries.
*   **Command Palette**: Press `Cmd/Ctrl + K` anywhere in the OS to open the Command Palette. You can quickly launch apps, search for files, or send a quick prompt to the AI.

**Tip:** You can always return to the dashboard from any app by clicking the **Home Button (House Icon)** in the top center toolbar.

---

## 2. Standard Applications

*   **✅ Tasks**: A simple yet powerful task manager. Tasks are sorted by priority and date.
*   **📅 Calendar**: A monthly view calendar integrated with your tasks.
*   **📝 Notes**: A Markdown-based note-taking app that supports math equations and code highlighting.
*   **⚙️ Settings**: Customize your OS experience, manage API Keys, and change UI themes.

---

## 3. File Management (Sidebar)

The left sidebar gives you direct access to the Virtual File System (VFS).

*   **Navigation**: Click folders to expand/collapse. Click files to open them.
*   **Context Menu**: Right-click on any file or folder to access options like **Rename**, **Upload Here**, **Download**, or **Delete**.
*   **Properties**: Right-click a file and select "Properties" to view its size, dates, and modify its **Permissions (ACL)** for the AI and Guest apps.
*   **Open With**: Right-click a file to see a list of applications registered to handle that specific file type.

### Uploading & Exporting
*   **Upload**: Drag files or folders from your computer directly onto the sidebar, or use the buttons at the bottom.
*   **Export**: Right-click any folder (or use the System Settings) to download a `.zip` backup of your files.

---

## 4. Working with the AI Agent

The Chat Panel (Right) is where you give instructions to Itera.

*   **Natural Language**: Just ask for what you want.
    *   "Create a new note called 'Ideas' and list 5 app ideas."
    *   "Change the theme to Midnight mode."
    *   "Fix the bug in `apps/script.js`."
*   **Context Management**: You can upload files or drag existing VFS files into the chat to add them to the AI's context as attachments.
*   **Asynchronous Collaboration**: You can type and send new messages even while the AI is thinking or executing tools. The AI will adapt its workflow dynamically.
*   **Stop Button**: If the AI gets stuck in a loop, press the red "Stop" button in the input area to halt its operations.
*   **Session History** (🕘 in the chat header): Clearing the chat (🗑) or a `reset_session` by the AI does not throw the conversation away. The latest 10 sessions (`preferences.sessionHistoryKeep`) stay in this browser's IndexedDB, ordered by last activity; older ones are deleted automatically. From the dialog you can switch back to an earlier session and keep talking (stop the AI first if it is working), delete one, or **save** any session to the VFS: it is written straight into the folder declared as `paths.user.sessions` (`data/sessions` by default) as `YYYYMMDD_HHMM_<title>/` with `session.json` and a `media/` folder holding the session's attachments (saving the same session again overwrites the same folder). Attachments of a live session live in `system/temp/sessions/<session id>/`, which is per device; bundling them makes a saved session complete on other devices too. Sessions found in that folder are listed under **Saved in the VFS** and can be **loaded** back (attachments are restored into the session's folder); the list uses only names and metadata (nothing is read or fetched until you load one).
*   **Slash Commands**: A message that starts with `/` and a known command name is executed by the OS itself, without the AI. The result appears as a system event in the chat (the AI reads it next time it wakes up). `/help` lists them: `/status` (engine state, session, last measured context size), `/stop`, `/reset [note]` (archive this conversation and start a fresh one; the note is carried over and the AI reads it with your next message — this works even when the context has grown too long for the AI to answer), `/ps`, `/open <path | metaos://…>`. Unknown names are sent to the AI as ordinary text (so `/tmp/x` is safe); start with `//` to send a literal slash. Daemons can do the same from outside the chat through `MetaOS.chat` (see [02_architecture.md](02_architecture.md)).

---
**Next Step:** Proceed to [02_architecture.md](02_architecture.md) to understand the internal directory structure.