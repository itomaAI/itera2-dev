/**
 * src/shell/services/DialogService.ts
 * Itera OS v2: Host Native Dialog Service
 */

export class DialogService {
  // 過去のコードとの互換性のため duration 引数は残しますが、自動では消えなくなります。
  public notify(message: string, type: string = "info", duration?: number): void {
    let container = document.getElementById("__itera-toast-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "__itera-toast-container";
      Object.assign(container.style, {
        position: "fixed",
        top: "1.25rem",
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "0.5rem",
        zIndex: "99999",
        pointerEvents: "none",
      });
      document.body.appendChild(container);
    }

    const TYPES: Record<string, { color: string }> = {
      info: { color: "rgb(var(--c-accent-primary))" },
      success: { color: "rgb(var(--c-accent-success))" },
      warning: { color: "rgb(var(--c-accent-warning))" },
      error: { color: "rgb(var(--c-accent-error))" },
    };
    const { color } = TYPES[type] || TYPES["info"];

    const toast = document.createElement("div");
    toast.className = "itera-animate-fade";
    Object.assign(toast.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "0.75rem",
      padding: "0.5rem 0.75rem",
      borderRadius: "0.25rem",
      background: "rgb(var(--c-bg-panel))",
      color: "rgb(var(--c-text-main))",
      border: `1px solid rgb(var(--c-border-main))`,
      boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
      fontSize: "0.75rem",
      pointerEvents: "auto",
      minWidth: "240px",
      maxWidth: "400px",
      wordBreak: "break-word",
      transition: "opacity 0.2s ease, transform 0.2s ease",
    });

    toast.innerHTML = `
      <div style="display: flex; align-items: center; gap: 0.5rem; flex: 1;">
        <div style="width:3px; height:100%; min-height:1.25rem; background:${color}; border-radius:1px; flex-shrink:0;"></div>
        <span>${message}</span>
      </div>
      <button class="text-text-muted hover:text-text-main transition flex-shrink-0" style="padding: 2px; line-height: 1;">✕</button>
    `;
    
    const closeBtn = toast.querySelector("button");
    const closeToast = () => {
      if (document.body.contains(toast)) {
        toast.style.opacity = "0";
        toast.style.transform = "translateY(-10px)";
        // transitionendは不安定なため、setTimeoutで確実にDOMから破棄する
        setTimeout(() => toast.remove(), 200);
      }
    };

    if (closeBtn) {
      closeBtn.onclick = closeToast;
    }

    container.appendChild(toast);

    // durationが明示されているか、info/successの場合は自動で消去する
    const shouldAutoDismiss = duration !== undefined ? duration > 0 : (type === "info" || type === "success");
    const timeoutMs = (duration && duration > 0) ? duration : 3000;

    if (shouldAutoDismiss) {
      setTimeout(closeToast, timeoutMs);
    }
  }

  public showLoading(message: string = "Processing..."): void {
    this.hideLoading();
    const overlay = document.createElement("div");
    overlay.id = "__itera-loading-overlay";
    overlay.className =
      "fixed inset-0 bg-app/80 backdrop-blur-sm z-[99999] flex flex-col items-center justify-center itera-animate-fade";
    overlay.innerHTML = `
      <div class="loader mb-4"></div>
      <div class="text-sm font-bold text-text-muted tracking-wider uppercase animate-pulse">${message}</div>
    `;
    document.body.appendChild(overlay);
  }

  public hideLoading(): void {
    const overlay = document.getElementById("__itera-loading-overlay");
    if (overlay) overlay.remove();
  }

  public alert(message: string, title: string = "System Alert"): Promise<void> {
    return this._createDialog({ type: "alert", message, title }) as Promise<void>;
  }

  public confirm(message: string, title: string = "Confirmation"): Promise<boolean> {
    return this._createDialog({ type: "confirm", message, title }) as Promise<boolean>;
  }

  public prompt(message: string, defaultValue: string = "", title: string = "Input Required"): Promise<string | null> {
    return this._createDialog({ type: "prompt", message, title, defaultValue }) as Promise<string | null>;
  }

  private _createDialog(options: { type: string; message: string; title: string; defaultValue?: string }): Promise<any> {
    const { type, message, title, defaultValue } = options;

    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className =
        "fixed inset-0 bg-black/60 backdrop-blur-sm z-[99999] flex items-center justify-center p-4 itera-animate-fade select-none";

      const box = document.createElement("div");
      box.className =
        "bg-panel border border-border-main rounded shadow-lg w-full max-w-sm flex flex-col overflow-hidden itera-animate-modal";

      // Header
      const header = document.createElement("div");
      header.className = "px-4 py-3 border-b border-border-main bg-panel flex items-center";
      header.innerHTML = `<span class="font-bold text-sm text-text-main">${title}</span>`;

      // Body
      const body = document.createElement("div");
      body.className = "p-4 text-sm text-text-main whitespace-pre-wrap leading-relaxed";
      body.textContent = message;

      let input: HTMLInputElement | null = null;
      if (type === "prompt") {
        input = document.createElement("input");
        input.type = "text";
        input.value = defaultValue || "";
        input.className =
          "w-full mt-3 bg-app border border-border-main rounded p-2 text-sm text-text-main focus:outline-none focus:border-primary transition";
        input.setAttribute("autocomplete", "off");
        input.setAttribute("spellcheck", "false");
        body.appendChild(input);
      }

      // Footer
      const footer = document.createElement("div");
      footer.className = "px-4 py-3 border-t border-border-main bg-panel flex justify-end gap-2";

      const closeDialog = (val: any) => {
        overlay.style.opacity = "0";
        setTimeout(() => overlay.remove(), 200);
        resolve(val);
      };

      const btnCancel = document.createElement("button");
      btnCancel.className =
        "px-4 py-1.5 rounded text-xs font-bold text-text-muted hover:text-text-main hover:bg-hover transition";
      btnCancel.textContent = "Cancel";
      btnCancel.onclick = () => closeDialog(type === "prompt" ? null : false);

      const btnOk = document.createElement("button");
      btnOk.className =
        "px-4 py-1.5 rounded text-xs font-bold bg-primary text-white hover:bg-primary/90 transition";
      btnOk.textContent = "OK";
      btnOk.onclick = () => closeDialog(type === "prompt" ? (input ? input.value : "") : true);

      if (type !== "alert") {
        footer.appendChild(btnCancel);
      }
      footer.appendChild(btnOk);

      box.appendChild(header);
      box.appendChild(body);
      box.appendChild(footer);
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      // Focus & Keyboard Navigation
      if (input) {
        setTimeout(() => {
          input!.focus();
          input!.select();
        }, 50);
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") btnOk.click();
          if (e.key === "Escape") btnCancel.click();
        });
      } else {
        setTimeout(() => btnOk.focus(), 50);
        overlay.addEventListener("keydown", (e) => {
          if (e.key === "Escape") {
            if (type === "alert") btnOk.click();
            else btnCancel.click();
          }
        });
      }
    });
  }
}