/**
 * src/shell/modals/ApiSettingsModal.ts
 * Itera OS v2: API Keys Management
 */

const DOM_IDS = {
  MODAL: "api-settings-modal",
  CONTAINER: "api-settings-container",
  BTN_OPEN: "btn-api-keys",
  BTN_CLOSE: "btn-close-api-modal",
  BTN_CANCEL: "btn-cancel-api-modal",
  BTN_SAVE: "btn-save-api-modal",
};

export class ApiSettingsModal {
  private shell: any;
  private els: Record<string, HTMLElement | null> = {};
  private events: Record<string, Function> = {};
  private hasRendered = false;
  private providers: any[] = [];

  constructor(shell: any) {
    this.shell = shell;
    this._initElements();
    this._bindEvents();
  }

  on(event: string, callback: Function) {
    this.events[event] = callback;
  }

  private _initElements() {
    for (const [key, id] of Object.entries(DOM_IDS)) {
      this.els[key] = document.getElementById(id);
    }
  }

  private async _ensureInit() {
    if (!this.hasRendered && this.els.CONTAINER) {
      this.els.CONTAINER.innerHTML =
        '<div class="text-center text-text-muted text-xs p-4">Loading providers...</div>';

      try {
        this.providers = await this.shell.getMergedProviders();
      } catch (e) {
        console.warn("[ApiSettingsModal] Failed to get providers", e);
        this.providers = [];
      }

      // フォールバック
      if (!this.providers || this.providers.length === 0) {
        this.providers = [
          { id: "google", name: "Google (Gemini)", placeholder: "AIzaSy..." },
          { id: "openai", name: "OpenAI", placeholder: "sk-proj-..." },
          { id: "anthropic", name: "Anthropic", placeholder: "sk-ant-..." },
        ];
      }

      this.els.CONTAINER.innerHTML = "";

      this.providers.forEach((provider) => {
        const wrapper = document.createElement("div");
        wrapper.className =
          "flex flex-col gap-1.5 p-3 rounded-lg bg-card/50 border border-border-main/50";

        const label = document.createElement("label");
        label.className =
          "block text-[10px] font-bold text-text-muted uppercase tracking-wider mb-1";
        label.textContent = provider.name;
        wrapper.appendChild(label);

        if (provider.requiresUrl) {
          const urlInput = document.createElement("input");
          urlInput.type = "text";
          urlInput.id = `api-url-${provider.id}`;
          urlInput.placeholder = provider.urlPlaceholder || "";
          urlInput.className =
            "w-full bg-app border border-border-main rounded-md p-2 focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none text-text-main text-xs font-mono transition shadow-inner mb-2";
          wrapper.appendChild(urlInput);
        }

        const keyInput = document.createElement("input");
        keyInput.type = "password";
        keyInput.id = `api-key-${provider.id}`;
        keyInput.placeholder = provider.placeholder || "";
        keyInput.className =
          "w-full bg-app border border-border-main rounded-md p-2 focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none text-text-main text-xs font-mono transition shadow-inner";
        wrapper.appendChild(keyInput);

        this.els.CONTAINER!.appendChild(wrapper);
      });
      this.hasRendered = true;
    }
  }

  private _loadValues() {
    let secrets: any = {};
    try {
      secrets = JSON.parse(localStorage.getItem("itera_llm_secrets") || "{}");
    } catch (e) {}

    this.providers.forEach((provider) => {
      const keyInput = document.getElementById(
        `api-key-${provider.id}`,
      ) as HTMLInputElement;
      if (keyInput) keyInput.value = secrets[provider.id] || "";

      if (provider.requiresUrl) {
        const urlInput = document.getElementById(
          `api-url-${provider.id}`,
        ) as HTMLInputElement;
        if (urlInput) urlInput.value = secrets[`${provider.id}_url`] || "";
      }
    });
  }

  private _saveValues() {
    let secrets: any = {};
    this.providers.forEach((provider) => {
      const keyInput = document.getElementById(
        `api-key-${provider.id}`,
      ) as HTMLInputElement;
      if (keyInput) secrets[provider.id] = keyInput.value.trim();

      if (provider.requiresUrl) {
        const urlInput = document.getElementById(
          `api-url-${provider.id}`,
        ) as HTMLInputElement;
        if (urlInput) secrets[`${provider.id}_url`] = urlInput.value.trim();
      }
    });

    localStorage.setItem("itera_llm_secrets", JSON.stringify(secrets));
    if (this.events["secrets_updated"]) this.events["secrets_updated"](secrets);
    if (window.AppUI) window.AppUI.notify("API Keys saved.", "success");
  }

  async open() {
    if (this.els.MODAL) {
      await this._ensureInit();
      this._loadValues();
      this.els.MODAL.classList.remove("hidden");
    }
  }

  close() {
    if (this.els.MODAL) this.els.MODAL.classList.add("hidden");
  }

  private _bindEvents() {
    if (this.els.BTN_OPEN) this.els.BTN_OPEN.onclick = () => this.open();
    if (this.els.BTN_CLOSE) this.els.BTN_CLOSE.onclick = () => this.close();
    if (this.els.BTN_CANCEL) this.els.BTN_CANCEL.onclick = () => this.close();
    if (this.els.BTN_SAVE) {
      this.els.BTN_SAVE.onclick = () => {
        this._saveValues();
        this.close();
      };
    }
  }
}
