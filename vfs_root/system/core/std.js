/**
 * Itera OS v2 Guest Standard Library (std.js)
 * Clean, generic VFS and OS utilities for Guest Applications.
 */

(function (global) {
  if (!global.MetaOS) {
    console.warn('[Std] MetaOS bridge not found. The app is likely running outside of Itera OS.');
  }

  // ==========================================
  // Internal Utilities
  // ==========================================
  const Utils = {
    getMonthKey: () => new Date().toISOString().slice(0, 7), // YYYY-MM
    getDateStr: () => new Date().toISOString().slice(0, 10), // YYYY-MM-DD

    async safeReadJson(path, defaultValue = null) {
      try {
        const content = await global.MetaOS.fs.read(path);
        return JSON.parse(content);
      } catch (e) {
        return defaultValue;
      }
    },

    async safeWriteJson(path, data, options = { overwrite: true, silent: true }) {
      if (!global.MetaOS) return;
      const content = JSON.stringify(data, null, 2);
      await global.MetaOS.fs.write(path, content, options);
    },
  };

  // ==========================================
  // File System Utilities
  // ==========================================
  const FS = {
    readJson: Utils.safeReadJson,
    writeJson: Utils.safeWriteJson,
    async readBinary(path) {
      return await global.MetaOS.fs.read(path, { encoding: 'binary' });
    },
    async writeBinary(path, uint8ArrayData, options = { overwrite: true, silent: true }) {
      await global.MetaOS.fs.write(path, uint8ArrayData, options);
    },
  };

  // ==========================================
  // Context & Runtime
  // ==========================================
  const Context = {
    async getArgs() {
      try {
        if (window.__ITERA_ARGS__) return window.__ITERA_ARGS__;
        return (await global.MetaOS.system.getArgs()) || {};
      } catch (e) {
        return window.__ITERA_ARGS__ || {};
      }
    },
  };

  // ==========================================
  // Application KV Storage
  // ==========================================
  const Storage = {
    _getPath(key) {
      const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
      return `data/apps/${safeKey}.json`;
    },
    async get(key, defaultValue = {}) {
      return await FS.readJson(this._getPath(key), defaultValue);
    },
    async set(key, value) {
      await FS.writeJson(this._getPath(key), value);
    },
  };

  // ==========================================
  // System Configuration Access
  // ==========================================
  const Config = {
    async get(category = 'preferences') {
      return await FS.readJson(`system/config/${category}.json`, {});
    },
    async update(category, updates) {
      const current = await this.get(category);
      const merged = { ...current, ...updates };
      const path = `system/config/${category}.json`;
      await global.MetaOS.fs.write(path, JSON.stringify(merged, null, 2), {
        overwrite: true,
        system: true,
        silent: true,
      });
      return merged;
    },
  };

  // ==========================================
  // AI Cognitive Copilot
  // ==========================================
  const AI = {
    async logEvent(message, type = 'app_event', triggerLlm = false) {
      if (global.MetaOS?.ai?.log) {
        await global.MetaOS.ai.log(message, type, { trigger_llm: triggerLlm });
      }
    },
  };

  global.App = { FS, Context, Storage, Config, AI };
})(window);
