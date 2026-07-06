/**
 * src/shell/modals/SyncModal.ts
 * Itera OS v2: Cloud Sync Modal (Mock for now)
 */

const DOM_IDS = {
  MODAL: "sync-modal",
  BTN_OPEN: "btn-sync",
  BTN_CLOSE: "btn-close-sync",
};

export class SyncModal {
  private els: Record<string, HTMLElement | null> = {};

  constructor() {
    this._initElements();
    this._bindEvents();
  }

  private _initElements(): void {
    for (const [key, id] of Object.entries(DOM_IDS)) {
      this.els[key] = document.getElementById(id);
    }
  }

  private _bindEvents(): void {
    if (this.els.BTN_OPEN) {
      this.els.BTN_OPEN.onclick = () => this.open();
    }
    if (this.els.BTN_CLOSE) {
      this.els.BTN_CLOSE.onclick = () => this.close();
    }
  }

  open(): void {
    if (this.els.MODAL) {
      this.els.MODAL.classList.remove("hidden");
    }
  }

  close(): void {
    if (this.els.MODAL) {
      this.els.MODAL.classList.add("hidden");
    }
  }
}
