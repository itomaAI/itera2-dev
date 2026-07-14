# 00. Overview: What is Itera OS?

## Introduction

**Itera OS v2** is an experimental "Autonomous AI Operating System" that runs entirely within your web browser.
Unlike traditional chatbots that simply reply with text, Itera acts as a complete operating system where an AI agent has direct control over the file system, UI, and system configuration.

It is designed with a unique architecture called **HDI (Host-Driven Intelligence)**, where the AI resides in a privileged "Host" layer and manipulates the user-facing "Guest" environment to build and maintain the optimal workflow for the user.

## Core Philosophy: The REAL Architecture

Itera's autonomy is powered by a loop known as **REAL (Recursive Environment-Agent Loop)**.
This architecture grants the AI "Time" (a continuous existence) and a "Body" (the ability to act).

1.  **Observe**:
    *   The AI reads the current state of the Virtual File System (VFS v2) and the interaction history.
    *   It perceives user inputs, uploaded files, and system events (e.g., file changes).
2.  **Think**:
    *   Based on observations, the AI plans its next move.
    *   It generates a sequence of thoughts and decides which tools to use.
3.  **Act**:
    *   The AI executes specific tools (e.g., `create_file`, `spawn` process) to manipulate the environment.
    *   This is not a simulation; files are actually written to the browser's IndexedDB and OPFS.
4.  **Update**:
    *   The results of the actions are immediately reflected in the UI (Dashboard/Apps).
    *   The loop continues, allowing the AI to iteratively improve the system.

## System Model: Host & Guest

Itera creates a clear separation between the "Brain" and the "Body" to ensure security and stability.

### 1. Host (The Brain & Kernel)
*   **Role**: Core System, Cognitive Layer, File System Manager.
*   **Capabilities**:
    *   Manages the LLM (Large Language Model) connection and Prompt engineering.
    *   Holds root privileges for the VFS and manages Access Control Lists (ACL).
    *   Executes high-level tools and manages the lifecycle of all apps.

### 2. Guest (The Body & Userland)
*   **Role**: User Land, Presentation Layer.
*   **Location**: Apps running in sandboxed `iframe` environments.
*   **Capabilities**:
    *   Runs standard web technologies (HTML/JS/CSS).
    *   Displays the UI (Task Manager, Calendar, etc.).
    *   **Sandboxed**: Cannot directly access the Host's internals.
*   **Bridge**:
    *   Communicates with the Host via the `MetaOS` Bridge Protocol (IPC).
    *   Example: A "Save" button in a Guest app sends a message to the Host to write a file securely.

## Why "Itera"?

The name comes from **"Iterate."**
This OS is not a static product. It is a living environment that you and the AI build together.
If you need a new tool, ask the AI to code it. If you don't like the design, ask the AI to change the theme.
Through rapid iteration, Itera evolves into your personalized digital workspace.

---
**Next Step:** Proceed to [01_user_guide.md](01_user_guide.md) to learn how to use the dashboard and standard apps.