/**
 * Itera Guest UI Kit (ui.js) v2
 * Provides theme configuration, shared UI utilities, and OS-native dialogs.
 */

(function (global) {
  if (global.tailwind) {
    global.tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          fontFamily: {
            sans: [
              'var(--font-sans)',
              'system-ui',
              '-apple-system',
              'BlinkMacSystemFont',
              '"Segoe UI"',
              'Roboto',
              '"Helvetica Neue"',
              'Arial',
              '"Noto Sans JP"',
              '"Noto Sans"',
              '"Hiragino Kaku Gothic ProN"',
              '"Hiragino Sans"',
              'Meiryo',
              'sans-serif',
              '"Apple Color Emoji"',
              '"Segoe UI Emoji"',
              '"Segoe UI Symbol"',
              '"Noto Color Emoji"',
            ],
            mono: [
              'var(--font-mono)',
              'ui-monospace',
              'SFMono-Regular',
              'Menlo',
              'Monaco',
              'Consolas',
              '"Liberation Mono"',
              '"Courier New"',
              'monospace',
            ],
          },
          colors: {
            app: 'rgb(var(--c-bg-app) / <alpha-value>)',
            panel: 'rgb(var(--c-bg-panel) / <alpha-value>)',
            card: 'rgb(var(--c-bg-card) / <alpha-value>)',
            hover: 'rgb(var(--c-bg-hover) / <alpha-value>)',
            overlay: 'rgb(var(--c-bg-overlay) / <alpha-value>)',
            border: {
              main: 'rgb(var(--c-border-main) / <alpha-value>)',
              highlight: 'rgb(var(--c-border-highlight) / <alpha-value>)',
            },
            text: {
              main: 'rgb(var(--c-text-main) / <alpha-value>)',
              muted: 'rgb(var(--c-text-muted) / <alpha-value>)',
              inverted: 'rgb(var(--c-text-inverted) / <alpha-value>)',
              system: 'rgb(var(--c-text-system) / <alpha-value>)',
            },
            primary: 'rgb(var(--c-accent-primary) / <alpha-value>)',
            success: 'rgb(var(--c-accent-success) / <alpha-value>)',
            warning: 'rgb(var(--c-accent-warning) / <alpha-value>)',
            error: 'rgb(var(--c-accent-error) / <alpha-value>)',
          },
        },
      },
    };
  }

  const style = document.createElement('style');
  style.textContent = `
        body { 
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
        }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgb(var(--c-bg-hover)); border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: rgb(var(--c-text-muted)); }
        
        @keyframes iteraFadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes iteraSlideUp { from { opacity: 0; transform: translateY(10px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
        @keyframes iteraSpin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        
        .itera-animate-fade { animation: iteraFadeIn 0.2s ease-out forwards; }
        .itera-animate-modal { animation: iteraSlideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
        .itera-loader { border: 3px solid rgb(var(--c-bg-hover)); border-top: 3px solid rgb(var(--c-accent-primary)); border-radius: 50%; width: 24px; height: 24px; animation: iteraSpin 1s linear infinite; }
    `;
  document.head.appendChild(style);

  global.AppUI = {
    go: (path) => {
      if (global.MetaOS) global.MetaOS.system.spawn(path, { pid: 'main' });
      else window.location.href = path;
    },
    home: () => {
      if (global.MetaOS) global.MetaOS.system.spawn('apps/home.html', { pid: 'main' });
    },
    notify: (message, type = 'info', duration) => {
      if (global.MetaOS) {
        global.MetaOS.host.notify(message, type, duration);
      } else {
        console.log(`[Notification: ${type}] ${message}`);
      }
    },
    alert: async (message, title = 'System Alert') => {
      if (global.MetaOS) {
        return await global.MetaOS.host.showMessageBox({
          title,
          message,
          type: 'warning',
          buttons: [{ label: 'OK', value: undefined, style: 'primary', isDefault: true }],
        }).then(() => undefined);
      } else {
        window.alert(`${title}\n\n${message}`);
        return undefined;
      }
    },
    confirm: async (message, title = 'Confirmation') => {
      if (global.MetaOS) {
        return await global.MetaOS.host.showMessageBox({
          title,
          message,
          type: 'question',
          buttons: [
            { label: 'Cancel', value: false, style: 'normal', isCancel: true },
            { label: 'OK', value: true, style: 'primary', isDefault: true },
          ],
        }).then(res => res ? res.action : false);
      } else {
        return window.confirm(`${title}\n\n${message}`);
      }
    },
    prompt: async (message, defaultValue = '', title = 'Input Required') => {
      if (global.MetaOS) {
        return await global.MetaOS.host.showMessageBox({
          title,
          message,
          type: 'question',
          prompt: { defaultValue },
          buttons: [
            { label: 'Cancel', value: null, style: 'normal', isCancel: true },
            { label: 'OK', value: 'ok', style: 'primary', isDefault: true },
          ],
        }).then(res => {
          if (res && res.action === 'ok') {
            return res.value !== undefined ? res.value : null;
          }
          return null;
        });
      } else {
        return window.prompt(`${title}\n\n${message}`, defaultValue);
      }
    },
    showConflictDialog: async (itemName, isDirectory) => {
      if (global.MetaOS) {
        const actionName = isDirectory ? 'Merge' : 'Replace';
        const detailMsg = isDirectory
          ? 'Do you want to merge the folders? Files with the same names will be replaced.'
          : 'Do you want to replace it with the one you are moving?';

        const buttons = [
          { label: 'Cancel', value: 'cancel', style: 'normal', isCancel: true },
          { label: 'Skip', value: 'skip', style: 'normal' },
        ];

        if (!isDirectory) {
          buttons.push({ label: 'Keep Both', value: 'keep_both', style: 'normal' });
        }

        buttons.push({ label: actionName, value: isDirectory ? 'merge' : 'replace', style: 'primary', isDefault: true });

        const res = await global.MetaOS.host.showMessageBox({
          title: 'Item Already Exists',
          message: `An item named "${itemName}" already exists in this location.`,
          detail: detailMsg,
          type: 'warning',
          checkbox: {
            label: 'Do this for all current conflicts',
            defaultChecked: false,
          },
          buttons,
        });
        return { action: res.action, checkboxChecked: res.checkboxChecked };
      }
      return { action: 'cancel', checkboxChecked: false };
    },
    showMessageBox: async (options) => {
      if (global.MetaOS) {
        return await global.MetaOS.host.showMessageBox(options);
      } else {
        window.alert(`${options.title}\n\n${options.message}`);
        return { action: options.buttons[0]?.value, value: undefined, checkboxChecked: false };
      }
    },
    showLoading: (message = 'Processing...') => {
      if (global.MetaOS) {
        global.MetaOS.host.showLoading(message);
      } else {
        console.log(`[Loading] ${message}`);
      }
    },
    hideLoading: () => {
      if (global.MetaOS) {
        global.MetaOS.host.hideLoading();
      }
    },
    getThemeColor: (tokenName) => {
      const root = document.documentElement;
      let val = getComputedStyle(root).getPropertyValue(`--c-${tokenName}`).trim();
      if (!val) return '#888888';
      return val.includes(' ') ? `rgb(${val.split(' ').join(', ')})` : val;
    },
  };
})(window);