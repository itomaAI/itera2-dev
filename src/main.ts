/**
 * src/main.ts
 * Itera OS v2: Vite Entry Point
 */

import { ShellController } from "./shell/core/ShellController";
import "./style.css";

window.AppUI = {
  notify: (msg: string, type: string = "info") => {
    console.log(`[Notification: ${type}] ${msg}`);
    if (type === "error") alert(`Error: ${msg}`);
  },
  showLoading: (msg: string) => {
    console.log(`[Loading] ${msg}`);
  },
  hideLoading: () => {
    console.log(`[Loading] Done.`);
  },
  prompt: async (msg: string, defaultVal?: string) => {
    return prompt(msg, defaultVal);
  },
  confirm: async (msg: string) => {
    return confirm(msg);
  },
};

document.addEventListener("DOMContentLoaded", async () => {
  const controller = new ShellController();

  try {
    await controller.init();

    const loader = document.getElementById("boot-loader");
    if (loader) {
      loader.classList.add("animate-fade-out");
      setTimeout(() => {
        loader.remove();
      }, 500);
    }
  } catch (e: any) {
    console.error("System Boot Failed:", e);
    const loader = document.getElementById("boot-loader");
    if (loader) {
      loader.classList.remove("flex-col", "items-center", "justify-center");
      loader.classList.add("p-8");
      loader.innerHTML = `
        <div class="text-error font-bold mb-4 text-xl">System Boot Error</div>
        <div class="text-sm text-text-main font-mono bg-card border border-border-main p-4 rounded shadow-inner whitespace-pre-wrap">${e.message || String(e)}</div>
        <button onclick="location.reload()" class="mt-6 px-6 py-2 bg-primary hover:bg-primary/80 rounded text-sm text-white font-bold transition">Reload OS</button>
      `;
    }
  }
});
