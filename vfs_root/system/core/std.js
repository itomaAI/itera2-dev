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
    /**
     * 区分 category の値が変わったら callback(新しい値, 変わった区分の一覧) を呼ぶ（T-0539）。
     * ホストは値が実際に変わった区分だけを config_changed で告げる。値は載っていないので、ここで読み直す
     * （層を重ねた値を返すのはホストだけ）。戻り値を呼ぶと購読をやめる。
     */
    onChange(category, callback) {
      const sys = global.MetaOS?.system;
      if (!sys?.on || typeof callback !== 'function') return () => {};
      const handler = async (payload) => {
        const categories = Array.isArray(payload?.categories) ? payload.categories : [];
        if (!categories.includes(category)) return;
        try {
          callback(await Config.get(category), categories);
        } catch (e) {
          console.warn(`[App.Config] onChange(${category}) failed`, e);
        }
      };
      sys.on('config_changed', handler);
      return () => sys.off?.('config_changed', handler);
    },
  };

  // ==========================================
  // Registry Access (apps / services / associations)
  // ==========================================
  // 登録簿も設定と同じく層になっている（配信 system/registry → 利用者 user/registry。層の数は配布物ごと）。
  // 重ねた値を返すのも、書き先（最後の層）に項目の差分だけ書くのも **ホストの AppRegistry** の仕事なので、
  // ゲストはホストの口（MetaOS.system.getRegistry / updateRegistry）を使う（T-0447）。
  // 口の無い古いホストでは従来どおり system/registry/<name>.json を読み書きする（挙動を変えない）。
  const Registry = {
    async get(name, fallback = []) {
      if (global.MetaOS?.system?.getRegistry) {
        try {
          const value = await global.MetaOS.system.getRegistry(name);
          return value === undefined || value === null ? fallback : value;
        } catch (e) {
          console.warn(`[App.Registry] getRegistry(${name}) failed; falling back to the file`, e);
        }
      }
      return await FS.readJson(`system/registry/${name}.json`, fallback);
    },
    // 1 項目だけ更新する（apps / services）。丸ごと書かない —— 丸ごと書くと配信の層の写しが固まる
    async update(name, id, updates) {
      if (global.MetaOS?.system?.updateRegistry) {
        return await global.MetaOS.system.updateRegistry(name, id, updates);
      }
      const path = `system/registry/${name}.json`;
      const list = await FS.readJson(path, []);
      const entries = Array.isArray(list) ? list : [];
      const index = entries.findIndex((e) => e && e.id === id);
      const next = { ...(index >= 0 ? entries[index] : { id }), ...updates, id };
      if (index >= 0) entries[index] = next;
      else entries.push(next);
      await global.MetaOS.fs.write(path, JSON.stringify(entries, null, 2), {
        overwrite: true,
        system: true,
        silent: true,
      });
      return next;
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

  global.App = { FS, Context, Storage, Config, Registry, AI };
})(window);
