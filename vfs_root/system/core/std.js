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
    }
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

  // ==========================================
  // Domain Specific APIs (Tasks, Calendar, etc.)
  // ==========================================
  const Domain = {
    // --- Tasks ---
    async getTasks() {
      if (!global.MetaOS) return [];
      try {
        const files = await global.MetaOS.fs.list('data/tasks');
        const taskFiles = files.filter(f => f.endsWith('.json'));
        const allTasks = [];
        for (const path of taskFiles) {
          const tasks = await Utils.safeReadJson(path, []);
          if (Array.isArray(tasks)) allTasks.push(...tasks);
        }
        return allTasks;
      } catch (e) {
        return [];
      }
    },

    async addTask(title, dueDate = '', priority = 'medium') {
      if (!title.trim()) return;
      const monthKey = Utils.getMonthKey();
      const path = `data/tasks/${monthKey}.json`;
      const tasks = await Utils.safeReadJson(path, []);
      const newTask = {
        id: Date.now().toString(),
        title: title.trim(),
        status: 'pending',
        dueDate: dueDate,
        priority: priority,
        created_at: new Date().toISOString()
      };
      tasks.push(newTask);
      await Utils.safeWriteJson(path, tasks);
      AI.logEvent(`User added a new task: "${newTask.title}" (Due: ${dueDate || 'None'})`, 'task_added');
      return newTask;
    },

    async _updateTaskInFile(id, updaterFn) {
      if (!global.MetaOS) return false;
      try {
        const files = await global.MetaOS.fs.list('data/tasks');
        const taskFiles = files.filter(f => f.endsWith('.json'));
        for (const path of taskFiles) {
          let tasks = await Utils.safeReadJson(path, []);
          const index = tasks.findIndex(t => t.id === id);
          if (index !== -1) {
            tasks = updaterFn(tasks, index);
            await Utils.safeWriteJson(path, tasks);
            return true;
          }
        }
      } catch (e) {}
      return false;
    },

    async updateTask(id, updates) {
      let updatedTitle = "";
      const success = await this._updateTaskInFile(id, (tasks, index) => {
        tasks[index] = { ...tasks[index], ...updates };
        updatedTitle = tasks[index].title;
        return tasks;
      });
      if (success && updates.title) AI.logEvent(`User updated task: "${updatedTitle}"`, 'task_updated');
      return success;
    },

    async toggleTask(id) {
      return await this._updateTaskInFile(id, (tasks, index) => {
        tasks[index].status = tasks[index].status === 'completed' ? 'pending' : 'completed';
        return tasks;
      });
    },

    async deleteTask(id) {
      let deletedTitle = "";
      const success = await this._updateTaskInFile(id, (tasks, index) => {
        deletedTitle = tasks[index].title;
        tasks.splice(index, 1);
        return tasks;
      });
      if (success) AI.logEvent(`User deleted task: "${deletedTitle}"`, 'task_deleted');
      return success;
    },

    // --- Events (Calendar) ---
    async getEvents(monthKey) {
      const path = `data/events/${monthKey}.json`;
      let events = await Utils.safeReadJson(path, []);
      events.sort((a, b) => a.date < b.date ? -1 : (a.date > b.date ? 1 : 0));
      return events;
    },

    async addEvent(title, date, time = '', note = '') {
      if (!title.trim() || !date) return;
      const monthKey = date.slice(0, 7);
      const path = `data/events/${monthKey}.json`;
      let events = await Utils.safeReadJson(path, []);
      const newEvent = { id: Date.now().toString(), title: title.trim(), date, time, note };
      events.push(newEvent);
      await Utils.safeWriteJson(path, events);
      AI.logEvent(`User added a calendar event: "${title}" on ${date} ${time}`, 'event_added');
      return newEvent;
    },

    async updateEvent(id, updates) {
      const { originalDate, date, title, time, note } = updates;
      await this.deleteEvent(id, originalDate || date);
      return await this.addEvent(title, date, time, note);
    },

    async deleteEvent(id, dateStr) {
      if (!dateStr) return false;
      const monthKey = dateStr.slice(0, 7);
      const path = `data/events/${monthKey}.json`;
      let events = await Utils.safeReadJson(path, []);
      const initialLen = events.length;
      const eventToDelete = events.find(e => e.id === id);
      events = events.filter(e => e.id !== id);
      if (events.length !== initialLen) {
        await Utils.safeWriteJson(path, events);
        if (eventToDelete) AI.logEvent(`User deleted calendar event: "${eventToDelete.title}" on ${eventToDelete.date}`, 'event_deleted');
        return true;
      }
      return false;
    },

    async getCalendarItems(monthKey) {
      const events = await this.getEvents(monthKey);
      const formattedEvents = events.map(e => ({ ...e, type: 'event' }));
      const allTasks = await this.getTasks();
      const formattedTasks = allTasks
        .filter(t => t.dueDate && t.dueDate.startsWith(monthKey) && t.status !== 'completed')
        .map(t => ({ id: t.id, title: t.title, date: t.dueDate, time: '', type: 'task', priority: t.priority }));
      return [...formattedEvents, ...formattedTasks];
    },

    // --- Notes & Apps ---
    async getRecentNotes(limit = 5) {
      if (!global.MetaOS) return [];
      try {
        const files = await global.MetaOS.fs.list('data', { recursive: true, detail: true });
        return files.filter(f => f.path.endsWith('.md'))
                    .sort((a, b) => b.updatedAt - a.updatedAt)
                    .slice(0, limit)
                    .map(f => f.path);
      } catch (e) {
        return [];
      }
    },

    async getApps() {
      // V2 ではレジストリから取得
      return await Utils.safeReadJson('system/registry/apps.json', []);
    }
  };

  global.App = { FS, Context, Storage, Config, AI, ...Domain };

})(window);