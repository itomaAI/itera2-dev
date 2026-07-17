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
      let container = document.getElementById('__itera-toast-container');
      if (!container) {
        container = document.createElement('div');
        container.id = '__itera-toast-container';
        Object.assign(container.style, {
          position: 'fixed',
          bottom: '1.25rem',
          right: '1.25rem',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: '0.5rem',
          zIndex: '99999',
          pointerEvents: 'none',
        });
        document.body.appendChild(container);
      }

      const TYPES = {
        info: { icon: 'ℹ️', color: 'rgb(var(--c-accent-primary))' },
        success: { icon: '✅', color: 'rgb(var(--c-accent-success))' },
        warning: { icon: '⚠️', color: 'rgb(var(--c-accent-warning))' },
        error: { icon: '❌', color: 'rgb(var(--c-accent-error))' },
      };
      const { icon, color } = TYPES[type] || TYPES.info;

      const toast = document.createElement('div');
      toast.className = 'itera-animate-fade';
      Object.assign(toast.style, {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '0.75rem',
        padding: '0.5rem 0.75rem',
        borderRadius: '0.25rem',
        background: 'rgb(var(--c-bg-panel))',
        color: 'rgb(var(--c-text-main))',
        border: `1px solid ${color}`,
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        fontSize: '0.75rem',
        pointerEvents: 'auto',
        minWidth: '240px',
        maxWidth: '320px',
        wordBreak: 'break-word',
        transition: 'opacity 0.2s ease, transform 0.2s ease',
      });

      toast.innerHTML = `
        <div style="display: flex; align-items: center; gap: 0.5rem; flex: 1;">
          <div style="width:3px; height:100%; min-height:1.25rem; background:\${color}; border-radius:1px; flex-shrink:0;"></div>
          <span>\${icon}</span>
          <span>\${message}</span>
        </div>
        <button class="text-text-muted hover:text-text-main transition flex-shrink-0" style="padding: 2px; line-height: 1;">✕</button>
      `;

      const closeBtn = toast.querySelector('button');
      const closeToast = () => {
        if (document.body.contains(toast)) {
          toast.style.opacity = '0';
          toast.style.transform = 'translateY(10px)';
          setTimeout(() => toast.remove(), 200);
        }
      };

      if (closeBtn) {
        closeBtn.onclick = closeToast;
      }

      container.appendChild(toast);

      const shouldAutoDismiss = duration !== undefined ? duration > 0 : type === 'info' || type === 'success';
      const timeoutMs = duration && duration > 0 ? duration : 3000;

      if (shouldAutoDismiss) {
        setTimeout(closeToast, timeoutMs);
      }
    },
    alert: (message, title = 'System Alert') => {
      return AppUI._createDialog({ type: 'alert', message, title });
    },
    confirm: (message, title = 'Confirmation') => {
      return AppUI._createDialog({ type: 'confirm', message, title });
    },
    prompt: (message, defaultValue = '', title = 'Input Required') => {
      return AppUI._createDialog({ type: 'prompt', message, title, defaultValue });
    },
    showLoading: (message = 'Processing...') => {
      AppUI.hideLoading();
      const overlay = document.createElement('div');
      overlay.id = '__itera-loading-overlay';
      overlay.className =
        'fixed inset-0 bg-app/80 backdrop-blur-sm z-[9999] flex flex-col items-center justify-center itera-animate-fade';
      overlay.innerHTML = `
                <div class="itera-loader mb-4"></div>
                <div class="text-sm font-bold text-text-muted tracking-wider uppercase animate-pulse">${message}</div>
            `;
      document.body.appendChild(overlay);
    },
    hideLoading: () => {
      const overlay = document.getElementById('__itera-loading-overlay');
      if (overlay) overlay.remove();
    },
    getThemeColor: (tokenName) => {
      const root = document.documentElement;
      let val = getComputedStyle(root).getPropertyValue(`--c-${tokenName}`).trim();
      if (!val) return '#888888';
      return val.includes(' ') ? `rgb(${val.split(' ').join(', ')})` : val;
    }
  };
})(window);
