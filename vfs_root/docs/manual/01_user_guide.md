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

*   **Header**: Displays a greeting based on the time of day.
*   **Apps Widget**: Provides quick access to standard applications. Click "Library" to see all installed apps.
*   **Active Tasks / Recent Notes**: Shows a summary of your current work.
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

---
**Next Step:** Proceed to [02_architecture.md](02_architecture.md) to understand the internal directory structure.