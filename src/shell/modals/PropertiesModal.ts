/**
 * src/shell/modals/PropertiesModal.ts
 * Itera OS v2: Properties and Permissions Modal
 */

import type { VfsService } from "../../core/vfs/VfsService";
import {
  USER_PRINCIPAL,
  type AccessControlList,
  type VfsStat,
} from "../../core/vfs/types";

export class PropertiesModal {
  private vfs: VfsService;
  private overlay: HTMLElement | null = null;
  private currentPath: string | null = null;
  private currentAcl: AccessControlList | null = null;
  private currentStat: VfsStat | null = null;
  private isOpen: boolean = false;

  constructor(vfs: VfsService) {
    this.vfs = vfs;
  }

  private _createDOM() {
    if (this.overlay) return;

    this.overlay = document.createElement("div");
    this.overlay.className =
      "fixed inset-0 bg-black/60 backdrop-blur-sm z-[10000] flex items-center justify-center p-4 itera-animate-fade select-none";

    this.overlay.onclick = (e) => {
      if (e.target === this.overlay) this.close();
    };

    const box = document.createElement("div");
    box.className =
      "bg-panel border border-border-main rounded-2xl shadow-2xl w-full max-w-sm flex flex-col overflow-hidden itera-animate-modal";

    // Header
    const header = document.createElement("div");
    header.className =
      "px-5 py-4 border-b border-border-main bg-card/50 flex items-center justify-between shrink-0";

    const titleContainer = document.createElement("div");
    titleContainer.className = "flex items-center gap-3 overflow-hidden";
    titleContainer.innerHTML = `
      <div id="prop-icon" class="text-2xl shrink-0">📄</div>
      <div class="min-w-0">
        <h2 id="prop-title" class="font-bold text-text-main text-base leading-tight truncate">File.txt</h2>
        <div class="text-[10px] text-text-muted font-mono uppercase tracking-widest mt-0.5">Properties</div>
      </div>
    `;

    const btnClose = document.createElement("button");
    btnClose.className =
      "shrink-0 w-8 h-8 flex items-center justify-center rounded-full bg-card hover:bg-hover border border-border-main text-text-muted hover:text-text-main transition";
    btnClose.innerHTML = "✕";
    btnClose.onclick = () => this.close();

    header.appendChild(titleContainer);
    header.appendChild(btnClose);

    // Tabs Header
    const tabsHeader = document.createElement("div");
    tabsHeader.className = "flex border-b border-border-main bg-panel shrink-0";
    tabsHeader.innerHTML = `
      <button id="tab-btn-general" class="flex-1 py-2 text-xs font-bold text-primary border-b-2 border-primary transition">General</button>
      <button id="tab-btn-permissions" class="flex-1 py-2 text-xs font-bold text-text-muted hover:text-text-main border-b-2 border-transparent transition">Permissions</button>
    `;

    // Content Area
    const contentArea = document.createElement("div");
    contentArea.className =
      "p-5 bg-app text-sm text-text-main relative overflow-hidden min-h-[250px]";

    // Tab: General
    const tabGeneral = document.createElement("div");
    tabGeneral.id = "tab-general";
    tabGeneral.className = "space-y-4";

    // Tab: Permissions
    const tabPermissions = document.createElement("div");
    tabPermissions.id = "tab-permissions";
    tabPermissions.className = "hidden space-y-5 flex flex-col h-full";

    contentArea.appendChild(tabGeneral);
    contentArea.appendChild(tabPermissions);

    // Footer
    const footer = document.createElement("div");
    footer.className =
      "px-5 py-3 border-t border-border-main bg-card flex justify-end gap-2 shrink-0 hidden";
    footer.id = "prop-footer";

    const btnCancel = document.createElement("button");
    btnCancel.className =
      "px-4 py-2 rounded-lg text-xs font-bold text-text-muted hover:text-text-main hover:bg-hover transition";
    btnCancel.textContent = "Cancel";
    btnCancel.onclick = () => this.close();

    const btnSave = document.createElement("button");
    btnSave.className =
      "px-4 py-2 rounded-lg text-xs font-bold bg-primary text-white hover:bg-primary/90 shadow transition";
    btnSave.textContent = "Apply Changes";
    btnSave.onclick = () => this._savePermissions();

    footer.appendChild(btnCancel);
    footer.appendChild(btnSave);

    box.appendChild(header);
    box.appendChild(tabsHeader);
    box.appendChild(contentArea);
    box.appendChild(footer);
    this.overlay.appendChild(box);
    document.body.appendChild(this.overlay);

    // Tab logic
    const btnGen = document.getElementById("tab-btn-general")!;
    const btnPerm = document.getElementById("tab-btn-permissions")!;
    const tGen = document.getElementById("tab-general")!;
    const tPerm = document.getElementById("tab-permissions")!;
    const foot = document.getElementById("prop-footer")!;

    btnGen.onclick = () => {
      btnGen.className =
        "flex-1 py-2 text-xs font-bold text-primary border-b-2 border-primary transition";
      btnPerm.className =
        "flex-1 py-2 text-xs font-bold text-text-muted hover:text-text-main border-b-2 border-transparent transition";
      tGen.classList.remove("hidden");
      tPerm.classList.add("hidden");
      foot.classList.add("hidden");
    };

    btnPerm.onclick = () => {
      btnPerm.className =
        "flex-1 py-2 text-xs font-bold text-primary border-b-2 border-primary transition";
      btnGen.className =
        "flex-1 py-2 text-xs font-bold text-text-muted hover:text-text-main border-b-2 border-transparent transition";
      tPerm.classList.remove("hidden");
      tGen.classList.add("hidden");
      foot.classList.remove("hidden");
    };
  }

  async open(path: string) {
    this.currentPath = path;
    this._createDOM();

    try {
      this.currentStat = this.vfs.stat(USER_PRINCIPAL, path);
      this.currentAcl = this.vfs.getAcl(USER_PRINCIPAL, path);

      this._renderGeneral();
      this._renderPermissions();

      // Reset to General tab on open
      document.getElementById("tab-btn-general")?.click();
      this.overlay?.classList.remove("hidden");
      this.isOpen = true;
    } catch (e: any) {
      if (window.AppUI)
        window.AppUI.notify(`Cannot open properties: ${e.message}`, "error");
    }
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.overlay?.classList.add("hidden");
  }

  private _getFileIcon(filename: string, kind: string): string {
    if (kind === "directory") return "📁";
    if (filename.endsWith(".js") || filename.endsWith(".ts")) return "📜";
    if (filename.endsWith(".html")) return "🌐";
    if (filename.endsWith(".css")) return "🎨";
    if (filename.endsWith(".json")) return "🔧";
    if (filename.match(/\.(png|jpg|jpeg|svg|gif|webp|ico)$/i)) return "🖼️";
    if (filename.endsWith(".pdf")) return "📕";
    if (filename.endsWith(".zip")) return "📦";
    if (filename.endsWith(".md")) return "📝";
    return "📄";
  }

  private _renderGeneral() {
    const s = this.currentStat;
    if (!s) return;

    document.getElementById("prop-icon")!.textContent = this._getFileIcon(
      s.name,
      s.kind,
    );
    document.getElementById("prop-title")!.textContent = s.name;

    const sizeStr =
      s.kind === "directory"
        ? "--"
        : s.size < 1024
          ? `${s.size} B`
          : `${(s.size / 1024).toFixed(2)} KB`;
    const cDate = new Date(s.createdAt).toLocaleString();
    const uDate = new Date(s.updatedAt).toLocaleString();

    const tGen = document.getElementById("tab-general")!;
    tGen.innerHTML = `
      <div class="grid grid-cols-[100px_1fr] gap-y-3 gap-x-2 text-xs">
        <div class="text-text-muted font-bold">Kind:</div>
        <div class="truncate capitalize">${s.kind} ${s.mimeType ? `(${s.mimeType})` : ""}</div>

        <div class="text-text-muted font-bold">Size:</div>
        <div class="truncate">${sizeStr}</div>

        <div class="text-text-muted font-bold">Where:</div>
        <div class="truncate font-mono bg-card px-2 py-0.5 rounded border border-border-main" title="/${s.path}">/${s.path}</div>

        <div class="text-text-muted font-bold">Created:</div>
        <div class="truncate">${cDate}</div>

        <div class="text-text-muted font-bold">Modified:</div>
        <div class="truncate">${uDate}</div>
      </div>
    `;
  }

  private _renderPermissions() {
    const acl = this.currentAcl;
    if (!acl) return;

    const getLevel = (type: string, id: string) => {
      const rule = acl.rules.find(
        (r) => r.principal.type === type && r.principal.id === id,
      );
      if (!rule) return "none";
      if (
        rule.permissions.includes("write") ||
        rule.permissions.includes("manage")
      )
        return "read_write";
      if (rule.permissions.includes("read")) return "read";
      return "none";
    };

    const aiLevel = getLevel("agent", "Itera_AI");
    const guestLevel = getLevel("any", "*");

    const tPerm = document.getElementById("tab-permissions")!;

    let html = `
      <div class="text-xs text-text-muted mb-2">Control who can access or modify this item.</div>
      
      <div class="space-y-4 flex-1">
        <div class="bg-card border border-border-main rounded-lg p-3">
          <label class="flex items-center justify-between w-full">
            <div class="flex items-center gap-2">
              <span class="text-lg">🤖</span>
              <div>
                <div class="font-bold text-text-main">AI Agent</div>
                <div class="text-[10px] text-text-muted">Autonomous modifications</div>
              </div>
            </div>
            <select id="perm-ai" class="bg-panel border border-border-main rounded text-xs p-1 text-text-main focus:outline-none focus:border-primary">
              <option value="read_write" ${aiLevel === "read_write" ? "selected" : ""}>Read & Write</option>
              <option value="read" ${aiLevel === "read" ? "selected" : ""}>Read Only</option>
              <option value="none" ${aiLevel === "none" ? "selected" : ""}>No Access</option>
            </select>
          </label>
        </div>

        <div class="bg-card border border-border-main rounded-lg p-3">
          <label class="flex items-center justify-between w-full">
            <div class="flex items-center gap-2">
              <span class="text-lg">🌐</span>
              <div>
                <div class="font-bold text-text-main">Guest Apps</div>
                <div class="text-[10px] text-text-muted">Any installed application</div>
              </div>
            </div>
            <select id="perm-guest" class="bg-panel border border-border-main rounded text-xs p-1 text-text-main focus:outline-none focus:border-primary">
              <option value="read_write" ${guestLevel === "read_write" ? "selected" : ""}>Read & Write</option>
              <option value="read" ${guestLevel === "read" ? "selected" : ""}>Read Only</option>
              <option value="none" ${guestLevel === "none" ? "selected" : ""}>No Access</option>
            </select>
          </label>
        </div>
      </div>
    `;

    if (this.currentStat?.kind === "directory") {
      html += `
        <div class="mt-4 flex items-center gap-2 bg-warning/10 p-2 rounded border border-warning/30 text-warning">
          <input type="checkbox" id="perm-recursive" class="w-4 h-4 rounded border-warning/50 text-warning focus:ring-warning cursor-pointer">
          <label for="perm-recursive" class="text-xs font-bold cursor-pointer">Apply to enclosed items</label>
        </div>
      `;
    }

    tPerm.innerHTML = html;
  }

  private async _savePermissions() {
    if (!this.currentPath || !this.currentAcl) return;

    const aiVal = (document.getElementById("perm-ai") as HTMLSelectElement)
      .value;
    const guestVal = (
      document.getElementById("perm-guest") as HTMLSelectElement
    ).value;
    const isRecursive =
      (document.getElementById("perm-recursive") as HTMLInputElement)
        ?.checked || false;

    // Build new rules
    const newRules: any[] = [];

    // Safety: User always has full rights
    newRules.push({
      principal: { type: "user", id: "local_user" },
      permissions: ["read", "write", "manage"],
    });

    const addRule = (type: string, id: string, val: string) => {
      // 修正: "none" の場合はルールを除外するのではなく、空配列を設定して Explicit Deny (明示的拒否) とする
      const perms =
        val === "read_write"
          ? ["read", "write"]
          : val === "read"
            ? ["read"]
            : [];
      newRules.push({
        principal: { type, id },
        permissions: perms,
      });
    };

    addRule("agent", "Itera_AI", aiVal);
    addRule("any", "*", guestVal);

    const newAcl: AccessControlList = {
      owner: { type: "user", id: "local_user" },
      rules: newRules,
    };

    try {
      if (window.AppUI) window.AppUI.showLoading("Applying permissions...");

      if (isRecursive) {
        await this.vfs.setAclRecursive(
          USER_PRINCIPAL,
          this.currentPath,
          newAcl,
        );
      } else {
        await this.vfs.setAcl(USER_PRINCIPAL, this.currentPath, newAcl);
      }

      if (window.AppUI) window.AppUI.notify("Permissions updated", "success");
      this.close();
    } catch (e: any) {
      if (window.AppUI)
        window.AppUI.notify(`Failed to save: ${e.message}`, "error");
    } finally {
      if (window.AppUI) window.AppUI.hideLoading();
    }
  }
}
