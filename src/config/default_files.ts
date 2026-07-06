/**
 * AUTO-GENERATED FILE - DO NOT EDIT MANUALLY
 * Generated on: 2026-07-06T05:07:20.356Z
 */

export const DEFAULT_FILES: Record<string, string> = {
  "apps/": "",

  "data/": "",

  "docs/": "",

  "index.html": `
<!-- vfs_root/index.html -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Itera OS v2 Dashboard</title>
</head>
<body class="bg-app text-text-main p-8 flex flex-col items-center justify-center h-screen font-sans">
  <div class="text-6xl mb-4">✨</div>
  <h1 class="text-3xl font-bold mb-2">Itera OS v2</h1>
  <p class="text-text-muted">The core system has been successfully initialized.</p>
  <p class="text-xs text-text-muted mt-8 font-mono opacity-50">VFS & IPC Subsystems Active</p>
</body>
</html>`.trim(),

  "system/config/appearance.json": JSON.stringify(
    {
      theme: "system/themes/light.json",
    },
    null,
    2,
  ),

  "system/config/llm.json": JSON.stringify(
    {
      model: "gemini-3-flash-preview",
      temperature: 1,
    },
    null,
    2,
  ),

  "system/config/preferences.json": JSON.stringify(
    {
      username: "User",
      agentName: "Itera",
      language: "English",
    },
    null,
    2,
  ),

  "system/registry/apps.json": JSON.stringify([], null, 2),

  "system/registry/associations.json": JSON.stringify(
    {
      extensions: {
        md: "notes",
        txt: "notes",
      },
      mimeTypes: {},
    },
    null,
    2,
  ),

  "system/registry/services.json": JSON.stringify([], null, 2),

  "system/themes/dark.json": JSON.stringify(
    {
      meta: {
        name: "Itera Dark",
        author: "System",
      },
      colors: {
        bg: {
          app: "#0f172a",
          panel: "#1e293b",
          card: "#334155",
          hover: "#475569",
          overlay: "#000000",
        },
        border: {
          main: "#334155",
          highlight: "#3b82f6",
        },
        text: {
          main: "#f1f5f9",
          muted: "#94a3b8",
          inverted: "#0f172a",
          system: "#60a5fa",
          tag_attr: "#94a3b8",
          tag_content: "#cbd5e1",
        },
        accent: {
          primary: "#3b82f6",
          success: "#10b981",
          warning: "#f59e0b",
          error: "#ef4444",
        },
        tags: {
          thinking: "#1e3a8a",
          plan: "#064e3b",
          report: "#312e81",
          error: "#7f1d1d",
        },
      },
    },
    null,
    2,
  ),

  "system/themes/light.json": JSON.stringify(
    {
      meta: {
        name: "Itera Light",
        author: "System",
      },
      colors: {
        bg: {
          app: "#f9fafb",
          panel: "#ffffff",
          card: "#f3f4f6",
          hover: "#e5e7eb",
          overlay: "#000000",
        },
        border: {
          main: "#e5e7eb",
          highlight: "#3b82f6",
        },
        text: {
          main: "#1f2937",
          muted: "#6b7280",
          inverted: "#ffffff",
          system: "#2563eb",
          tag_attr: "#6b7280",
          tag_content: "#374151",
        },
        accent: {
          primary: "#2563eb",
          success: "#059669",
          warning: "#d97706",
          error: "#dc2626",
        },
        tags: {
          thinking: "#1d4ed8",
          plan: "#047857",
          report: "#4338ca",
          error: "#b91c1c",
        },
      },
    },
    null,
    2,
  ),

  "system/themes/midnight.json": JSON.stringify(
    {
      meta: {
        name: "Midnight Protocol",
        author: "System",
      },
      colors: {
        bg: {
          app: "#020617",
          panel: "#0f172a",
          card: "#1e293b",
          hover: "#334155",
          overlay: "#000000",
        },
        border: {
          main: "#1e293b",
          highlight: "#6366f1",
        },
        text: {
          main: "#e2e8f0",
          muted: "#64748b",
          inverted: "#020617",
          system: "#818cf8",
          tag_attr: "#94a3b8",
          tag_content: "#cbd5e1",
        },
        accent: {
          primary: "#6366f1",
          success: "#10b981",
          warning: "#f59e0b",
          error: "#f43f5e",
        },
        tags: {
          thinking: "#312e81",
          plan: "#064e3b",
          report: "#4338ca",
          error: "#881337",
        },
      },
    },
    null,
    2,
  ),
};

export const BUILD_TIME = 1783314440356;
