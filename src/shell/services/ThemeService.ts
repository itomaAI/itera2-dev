/**
 * src/shell/services/ThemeService.ts
 * Itera OS v2: Visual Theme Manager
 */

import type { ConfigManager } from "../../core/sys/ConfigManager";
import type { VfsService } from "../../core/vfs/VfsService";
import { SYSTEM_PRINCIPAL } from "../../core/vfs/types";

export class ThemeService {
  private configManager: ConfigManager;
  private vfs: VfsService;
  private onThemeApplied: ((isDark: boolean) => void) | null = null;

  constructor(configManager: ConfigManager, vfs: VfsService) {
    this.configManager = configManager;
    this.vfs = vfs;
  }

  public setOnThemeAppliedCallback(callback: (isDark: boolean) => void): void {
    this.onThemeApplied = callback;
  }

  public start(): void {
    this.configManager.onUpdate(async (config) => {
      if (config.appearance && config.appearance.theme) {
        await this.applyTheme(config.appearance.theme);
      }
    });
  }

  public async applyTheme(themePath: string): Promise<void> {
    try {
      if (!this.vfs.exists(SYSTEM_PRINCIPAL, themePath)) return;

      const content = await this.vfs.readFile(SYSTEM_PRINCIPAL, themePath);
      const theme = JSON.parse(content);
      const colors = theme.colors;
      if (!colors) return;

      const root = document.documentElement;
      const setVar = (name: string, hex: string) => {
        if (!hex) return;
        const shorthandRegex = /^#?([a-f\d])([a-f\d])([a-f\d])$/i;
        hex = hex.replace(shorthandRegex, (_m, r, g, b) => r + r + g + g + b + b);
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        if (result) {
          root.style.setProperty(
            name,
            `${parseInt(result[1], 16)} ${parseInt(result[2], 16)} ${parseInt(result[3], 16)}`,
          );
        }
      };

      setVar("--c-bg-app", colors.bg?.app);
      setVar("--c-bg-panel", colors.bg?.panel);
      setVar("--c-bg-card", colors.bg?.card);
      setVar("--c-bg-hover", colors.bg?.hover);
      setVar("--c-bg-overlay", colors.bg?.overlay);
      setVar("--c-border-main", colors.border?.main);
      setVar("--c-border-highlight", colors.border?.highlight);
      setVar("--c-text-main", colors.text?.main);
      setVar("--c-text-muted", colors.text?.muted);
      setVar("--c-text-inverted", colors.text?.inverted);
      setVar("--c-text-system", colors.text?.system);
      setVar("--c-text-tag-attr", colors.text?.tag_attr);
      setVar("--c-text-tag-content", colors.text?.tag_content);
      setVar("--c-accent-primary", colors.accent?.primary);
      setVar("--c-accent-success", colors.accent?.success);
      setVar("--c-accent-warning", colors.accent?.warning);
      setVar("--c-accent-error", colors.accent?.error);
      setVar("--c-tag-thinking", colors.tags?.thinking || colors.accent?.primary);
      setVar("--c-tag-plan", colors.tags?.plan || colors.accent?.success);
      setVar("--c-tag-report", colors.tags?.report || colors.accent?.warning);
      setVar("--c-tag-error", colors.tags?.error || colors.accent?.error);

      if (this.onThemeApplied) {
        const isDark = (colors.bg?.app?.toLowerCase() || "") < "#888888";
        this.onThemeApplied(isDark);
      }
    } catch (e) {
      console.warn("[ThemeService] Failed to apply theme", e);
    }
  }
}