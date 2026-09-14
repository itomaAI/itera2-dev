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
  // 設定は層になっている（配信の既定 system/config → 利用者の上書き user/config。層の数は配布物ごと）。
  // 併合した値を返すのも、書き先（最後の層）に差分だけ書くのも **ホストの ConfigManager** の仕事なので、
  // ゲストはホストの口（MetaOS.system.getConfig / updateConfig）を使う（T-0431）。
  // 🔴 以前はここで system/config/<category>.json を直接読み書きしていた。2 層の配布物（itera2）では
  //    system/config は配信の層で OS 更新のたびに上書きされるため、設定アプリで変えた値が黙って戻っていた。
  // 口の無い古いホストでは従来どおりファイルへ落ちる（挙動を変えない）。
  const Config = {
    async get(category = 'preferences') {
      if (global.MetaOS?.system?.getConfig) {
        try {
          return (await global.MetaOS.system.getConfig(category)) || {};
        } catch (e) {
          console.warn(`[App.Config] getConfig(${category}) failed; falling back to the file`, e);
        }
      }
      return await FS.readJson(`system/config/${category}.json`, {});
    },
    async update(category, updates) {
      if (global.MetaOS?.system?.updateConfig) {
        return (await global.MetaOS.system.updateConfig(category, updates)) || {};
      }
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
