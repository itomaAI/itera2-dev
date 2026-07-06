/**
 * src/core/control/tools/basic_tools.ts
 * Itera OS v2: Basic Tools
 */

import type { ToolRegistry } from "../ToolRegistry";

export function registerBasicTools(registry: ToolRegistry): void {
  const setId = "system:basic";
  const setName = "System: Basic Tools";

  registry.registerSystemTool(setId, setName, {
    name: "get_time",
    description: "Returns the current system time.",
    impl: async () => {
      const now = new Date();
      const log = `Current Time: ${now.toLocaleString()}\nISO: ${now.toISOString()}`;
      return {
        log: log,
        ui: `🕒 Time checked`,
      };
    },
  });
}
