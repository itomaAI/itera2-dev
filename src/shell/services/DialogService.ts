/**
 * src/shell/services/DialogService.ts
 * Itera OS v2: Host Native Dialog Service
 */

export interface DialogResult<T> {
  value: T;
  checkboxChecked: boolean;
}

export interface MessageBoxOptions<T> {
  title: string;
  message: string;
  detail?: string;
  type?: 'info' | 'warning' | 'error' | 'question';
  buttons: {
    label: string;
    value: T;
    style?: 'primary' | 'danger' | 'normal';
    isDefault?: boolean;
  }[];
  checkbox?: {
    label: string;
    defaultChecked?: boolean;
  };
  prompt?: {
    defaultValue?: string;
    placeholder?: string;
  };
}

export type ConflictAction = 'replace' | 'merge' | 'skip' | 'keep_both' | 'cancel';

export class DialogService {
  // 過去のコードとの互換性のため duration 引数は残しますが、自動では消えなくなります。
  public notify(message: string, type: string = 'info', duration?: number): void {
    let container = document.getElementById('__itera-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = '__itera-toast-container';
      Object.assign(container.style, {
        position: 'fixed',
        top: '1.25rem',
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '0.5rem',
        zIndex: '99999',
        pointerEvents: 'none',
      });
      document.body.appendChild(container);
    }

    const TYPES: Record<string, { color: string }> = {
      info: { color: 'rgb(var(--c-accent-primary))' },
      success: { color: 'rgb(var(--c-accent-success))' },
      warning: { color: 'rgb(var(--c-accent-warning))' },
      error: { color: 'rgb(var(--c-accent-error))' },
    };
    const { color } = TYPES[type] || TYPES['info'];

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
      border: `1px solid rgb(var(--c-border-main))`,
      boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
      fontSize: '0.75rem',
      pointerEvents: 'auto',
      minWidth: '240px',
      maxWidth: '400px',
      wordBreak: 'break-word',
      transition: 'opacity 0.2s ease, transform 0.2s ease',
    });

    toast.innerHTML = `
      <div style="display: flex; align-items: center; gap: 0.5rem; flex: 1;">
        <div style="width:3px; height:100%; min-height:1.25rem; background:${color}; border-radius:1px; flex-shrink:0;"></div>
        <span>${message}</span>
      </div>
      <button class="text-text-muted hover:text-text-main transition flex-shrink-0" style="padding: 2px; line-height: 1;">✕</button>
    `;

    const closeBtn = toast.querySelector('button');
    const closeToast = () => {
      if (document.body.contains(toast)) {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-10px)';
        // transitionendは不安定なため、setTimeoutで確実にDOMから破棄する
        setTimeout(() => toast.remove(), 200);
      }
    };

    if (closeBtn) {
      closeBtn.onclick = closeToast;
    }

    container.appendChild(toast);

    // durationが明示されているか、info/successの場合は自動で消去する
    const shouldAutoDismiss = duration !== undefined ? duration > 0 : type === 'info' || type === 'success';
    const timeoutMs = duration && duration > 0 ? duration : 3000;

    if (shouldAutoDismiss) {
      setTimeout(closeToast, timeoutMs);
    }
  }

  public showLoading(message: string = 'Processing...'): void {
    this.hideLoading();
    const overlay = document.createElement('div');
    overlay.id = '__itera-loading-overlay';
    overlay.className =
      'fixed inset-0 bg-app/80 backdrop-blur-sm z-[99999] flex flex-col items-center justify-center itera-animate-fade';
    overlay.innerHTML = `
      <div class="loader mb-4"></div>
      <div class="text-sm font-bold text-text-muted tracking-wider uppercase animate-pulse">${message}</div>
    `;
    document.body.appendChild(overlay);
  }

  public hideLoading(): void {
    const overlay = document.getElementById('__itera-loading-overlay');
    if (overlay) overlay.remove();
  }

  public alert(message: string, title: string = 'System Alert'): Promise<void> {
    return this.showMessageBox<void>({
      title,
      message,
      type: 'warning',
      buttons: [{ label: 'OK', value: undefined as any, style: 'primary', isDefault: true }]
    }).then(() => undefined);
  }

  public confirm(message: string, title: string = 'Confirmation'): Promise<boolean> {
    return this.showMessageBox<boolean>({
      title,
      message,
      type: 'question',
      buttons: [
        { label: 'Cancel', value: false, style: 'normal' },
        { label: 'OK', value: true, style: 'primary', isDefault: true }
      ]
    }).then(res => res.value);
  }

  public prompt(message: string, defaultValue: string = '', title: string = 'Input Required'): Promise<string | null> {
    return this.showMessageBox<string | null>({
      title,
      message,
      type: 'question',
      prompt: { defaultValue },
      buttons: [
        { label: 'Cancel', value: null, style: 'normal' },
        { label: 'OK', value: 'ok' as any, style: 'primary', isDefault: true }
      ]
    }).then(res => res.value);
  }

  public async showConflictDialog(
    itemName: string,
    isDirectory: boolean
  ): Promise<DialogResult<ConflictAction>> {
    const actionName = isDirectory ? 'Merge' : 'Replace';
    const detailMsg = isDirectory 
      ? 'Do you want to merge the folders? Files with the same names will be replaced.'
      : 'Do you want to replace it with the one you are moving?';
      
    const buttons: MessageBoxOptions<ConflictAction>['buttons'] = [
      { label: 'Cancel', value: 'cancel', style: 'normal' },
      { label: 'Skip', value: 'skip', style: 'normal' }
    ];

    if (!isDirectory) {
      buttons.push({ label: 'Keep Both', value: 'keep_both', style: 'normal' });
    }
    
    buttons.push({ label: actionName, value: isDirectory ? 'merge' : 'replace', style: 'primary', isDefault: true });

    return await this.showMessageBox<ConflictAction>({
      title: 'Item Already Exists',
      message: `An item named "${itemName}" already exists in this location.`,
      detail: detailMsg,
      type: 'warning',
      checkbox: {
        label: 'Do this for all current conflicts',
        defaultChecked: false
      },
      buttons
    });
  }

  public showMessageBox<T>(options: MessageBoxOptions<T>): Promise<DialogResult<T>> {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className =
        'fixed inset-0 bg-black/60 backdrop-blur-sm z-[99999] flex items-center justify-center p-4 itera-animate-fade select-none';

      const box = document.createElement('div');
      box.className =
        'bg-panel border border-border-main rounded shadow-lg w-full max-w-sm flex flex-col overflow-hidden itera-animate-modal';

      // Header
      const header = document.createElement('div');
      header.className = 'px-4 py-3 border-b border-border-main bg-panel flex items-center gap-2';
      
      let icon = '';
      let iconColor = '';
      if (options.type === 'info') { icon = 'ℹ️'; iconColor = 'text-primary'; }
      else if (options.type === 'warning') { icon = '⚠️'; iconColor = 'text-warning'; }
      else if (options.type === 'error') { icon = '❌'; iconColor = 'text-error'; }
      else if (options.type === 'question') { icon = '❓'; iconColor = 'text-primary'; }

      header.innerHTML = `${icon ? `<span class="${iconColor}">${icon}</span>` : ''}<span class="font-bold text-sm text-text-main">${options.title}</span>`;

      // Body
      const body = document.createElement('div');
      body.className = 'p-4 text-sm text-text-main leading-relaxed flex flex-col gap-3';

      const msgEl = document.createElement('div');
      msgEl.className = 'whitespace-pre-wrap';
      msgEl.textContent = options.message;
      body.appendChild(msgEl);

      if (options.detail) {
        const detailEl = document.createElement('div');
        detailEl.className = 'text-xs text-text-muted whitespace-pre-wrap bg-card border border-border-main p-2 rounded';
        detailEl.textContent = options.detail;
        body.appendChild(detailEl);
      }

      let inputEl: HTMLInputElement | null = null;
      if (options.prompt) {
        inputEl = document.createElement('input');
        inputEl.type = 'text';
        inputEl.value = options.prompt.defaultValue || '';
        if (options.prompt.placeholder) inputEl.placeholder = options.prompt.placeholder;
        inputEl.className =
          'w-full bg-app border border-border-main rounded p-2 text-sm text-text-main focus:outline-none focus:border-primary transition';
        inputEl.setAttribute('autocomplete', 'off');
        inputEl.setAttribute('spellcheck', 'false');
        body.appendChild(inputEl);
      }

      let checkboxEl: HTMLInputElement | null = null;
      if (options.checkbox) {
        const cbContainer = document.createElement('label');
        cbContainer.className = 'flex items-center gap-2 mt-2 cursor-pointer';
        
        checkboxEl = document.createElement('input');
        checkboxEl.type = 'checkbox';
        checkboxEl.checked = options.checkbox.defaultChecked || false;
        checkboxEl.className = 'w-4 h-4 rounded border-border-main text-primary focus:ring-primary cursor-pointer';
        
        const cbLabel = document.createElement('span');
        cbLabel.className = 'text-xs font-bold text-text-muted';
        cbLabel.textContent = options.checkbox.label;

        cbContainer.appendChild(checkboxEl);
        cbContainer.appendChild(cbLabel);
        body.appendChild(cbContainer);
      }

      // Footer
      const footer = document.createElement('div');
      footer.className = 'px-4 py-3 border-t border-border-main bg-panel flex justify-end gap-2 flex-wrap';

      let isClosed = false;
      const closeDialog = (btnValue: T) => {
        if (isClosed) return;
        isClosed = true;

        overlay.style.opacity = '0';
        setTimeout(() => overlay.remove(), 200);

        let finalValue = btnValue;
        if (inputEl && btnValue !== null && btnValue !== false && (btnValue as any) !== 'cancel') {
          finalValue = inputEl.value as any;
        }

        resolve({
          value: finalValue,
          checkboxChecked: checkboxEl ? checkboxEl.checked : false
        });
      };

      let defaultBtnEl: HTMLButtonElement | null = null;
      let cancelBtnEl: HTMLButtonElement | null = null;

      options.buttons.forEach((btn: { label: string; value: T; style?: string; isDefault?: boolean }) => {
        const btnEl = document.createElement('button');
        let bgClass = 'bg-card hover:bg-hover text-text-main';
        if (btn.style === 'primary') bgClass = 'bg-primary hover:bg-primary/90 text-white';
        else if (btn.style === 'danger') bgClass = 'bg-error hover:bg-error/90 text-white';

        btnEl.className = `px-4 py-1.5 rounded text-xs font-bold transition shadow-sm ${bgClass}`;
        btnEl.textContent = btn.label;
        btnEl.onclick = () => closeDialog(btn.value);

        footer.appendChild(btnEl);

        if (btn.isDefault) defaultBtnEl = btnEl;
        if (btn.label.toLowerCase() === 'cancel' || btn.value === null || btn.value === false || btn.value === 'cancel') {
          cancelBtnEl = btnEl;
        }
      });

      box.appendChild(header);
      box.appendChild(body);
      box.appendChild(footer);
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      // Focus & Keyboard Navigation
      if (inputEl) {
        setTimeout(() => {
          inputEl!.focus();
          inputEl!.select();
        }, 50);
      } else if (defaultBtnEl) {
        setTimeout(() => defaultBtnEl!.focus(), 50);
      }

      overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          if (inputEl && document.activeElement !== inputEl) return;
          if (defaultBtnEl) defaultBtnEl.click();
        } else if (e.key === 'Escape') {
          if (cancelBtnEl) cancelBtnEl.click();
          else if (defaultBtnEl && options.type === 'alert') defaultBtnEl.click();
        }
      });
    });
  }
}
