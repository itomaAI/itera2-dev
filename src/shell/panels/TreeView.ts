/**
 * src/shell/panels/TreeView.ts
 * Itera OS v2: Surgical DOM Update Tree View
 */

import type { VfsEvent, TreeNode } from "../../core/vfs/types";

export class TreeView {
  private container: HTMLElement;
  private contextMenu: HTMLElement | null;
  private events: Record<string, Function> = {};

  private expandedPaths: Set<string> = new Set();
  private selectedPath: string | null = null;

  constructor(containerEl: HTMLElement, contextMenuEl: HTMLElement | null) {
    this.container = containerEl;
    this.contextMenu = contextMenuEl;

    this._initGlobalEvents();
    this._initRootDropZone();
  }

  on(event: string, callback: Function) {
    this.events[event] = callback;
  }

  // ==========================================
  // 1. Initial Render (全描画)
  // ==========================================

  render(treeData: TreeNode[]) {
    if (!this.container) return;

    this.container.classList.remove(
      "bg-hover",
      "border-2",
      "border-dashed",
      "border-primary",
      "bg-card",
      "ring-2",
      "ring-primary",
      "ring-inset",
    );
    this.container.innerHTML = "";

    const rootUl = document.createElement("ul");
    rootUl.id = "vfs-tree-root";
    rootUl.className =
      "tree-root text-sm font-mono text-text-main min-h-full pb-4";

    const fragment = document.createDocumentFragment();
    this._buildInitialTree(fragment, treeData, 0);

    rootUl.appendChild(fragment);
    this.container.appendChild(rootUl);
  }

  private _buildInitialTree(
    parentElement: DocumentFragment | HTMLElement,
    nodes: TreeNode[],
    indentLevel: number,
  ) {
    for (const node of nodes) {
      if (node.name === ".keep") continue;

      const li = this._createNodeElement(
        node.id,
        node.name,
        node.path,
        node.kind,
        node.meta,
        indentLevel,
      );
      parentElement.appendChild(li);

      if (
        node.kind === "directory" &&
        node.children &&
        node.children.length > 0
      ) {
        const childUl = li.querySelector(
          `#vfs-children-${node.id}`,
        ) as HTMLUListElement;
        if (childUl) {
          this._buildInitialTree(childUl, node.children, indentLevel + 1);
        }
      }
    }
  }

  // ==========================================
  // 2. Surgical DOM Update (差分更新)
  // ==========================================

  applyEvents(events: VfsEvent[]) {
    if (!this.container) return;

    for (const event of events) {
      switch (event.type) {
        case "create":
          this._handleNodeCreated(event);
          break;
        case "delete":
          this._handleNodeDeleted(event);
          break;
        case "rename":
        case "move":
        case "trash":
        case "restore":
          // これらはすべて「別の場所への移動」なので、一度消して新しい場所に作る
          this._handleNodeDeleted(event);
          this._handleNodeCreated(event);
          break;
        case "update":
          this._handleNodeUpdated(event);
          break;
      }
    }
  }

  private _handleNodeCreated(event: VfsEvent) {
    if (!event.node) return;
    if (event.node.name === ".keep" || event.node.flags.isHidden) return;

    if (document.getElementById(`vfs-node-${event.nodeId}`)) return;

    let parentUl: HTMLElement | null = null;
    let indentLevel = 0;

    if (event.node.parentId === null) {
      parentUl = document.getElementById("vfs-tree-root");
    } else {
      parentUl = document.getElementById(`vfs-children-${event.node.parentId}`);
      const parentDiv = document.querySelector(
        `div[data-node-id="${event.node.parentId}"]`,
      ) as HTMLElement;
      if (parentDiv) {
        const paddingRaw = parentDiv.style.paddingLeft || "8px";
        const parentPadding = parseInt(paddingRaw.replace("px", ""), 10);
        indentLevel = (parentPadding - 8) / 12 + 1;
      }
    }

    if (!parentUl) return;

    const newLi = this._createNodeElement(
      event.node.id,
      event.node.name,
      event.path,
      event.node.kind,
      event.node.meta,
      indentLevel,
    );

    parentUl.appendChild(newLi);
    this._sortChildren(parentUl);
  }

  private _handleNodeDeleted(event: VfsEvent) {
    const targetLi = document.getElementById(`vfs-node-${event.nodeId}`);
    if (targetLi) {
      targetLi.remove();
    }
  }

  private _handleNodeUpdated(event: VfsEvent) {
    if (!event.node) return;
    const targetDiv = document.querySelector(
      `div[data-node-id="${event.nodeId}"]`,
    ) as HTMLElement;

    if (targetDiv) {
      const sizeKB = (event.node.meta.size / 1024).toFixed(1) + " KB";
      const updated = new Date(event.node.meta.updatedAt).toLocaleString();
      targetDiv.title = `Size: ${sizeKB}\nUpdated: ${updated}`;
    }
  }

  private _sortChildren(ul: HTMLElement) {
    const items = Array.from(ul.children) as HTMLElement[];
    items.sort((a, b) => {
      const aKind = a.dataset.kind || "file";
      const bKind = b.dataset.kind || "file";
      if (aKind !== bKind) return aKind === "directory" ? -1 : 1;

      const aName = a.dataset.name || "";
      const bName = b.dataset.name || "";
      return aName.localeCompare(bName);
    });

    for (const item of items) {
      ul.appendChild(item);
    }
  }

  // ==========================================
  // 3. DOM Element Construction
  // ==========================================

  private _createNodeElement(
    id: string,
    name: string,
    path: string,
    kind: "file" | "directory",
    meta: any,
    indentLevel: number,
  ): HTMLElement {
    const li = document.createElement("li");
    li.id = `vfs-node-${id}`;
    li.className = "tree-node select-none";
    li.dataset.kind = kind;
    li.dataset.name = name;

    const div = document.createElement("div");
    const isSelected = this.selectedPath === path;

    div.className = `tree-content group hover:bg-hover cursor-pointer flex items-center py-0.5 px-2 border-l-2 border-transparent transition ${isSelected ? "bg-hover border-primary" : ""}`;
    div.style.paddingLeft = `${indentLevel * 12 + 8}px`;

    div.dataset.nodeId = id;
    div.dataset.path = path;
    div.dataset.kind = kind;
    div.dataset.name = name;

    const sizeKB = meta ? (meta.size / 1024).toFixed(1) + " KB" : "0 KB";
    const updated = meta
      ? new Date(meta.updatedAt || meta.updated_at).toLocaleString()
      : "";
    div.title = `Size: ${sizeKB}\nUpdated: ${updated}`;

    div.draggable = true;
    div.addEventListener("dragstart", (e) =>
      this._handleDragStart(e, path, kind),
    );

    if (kind === "directory") {
      div.addEventListener("dragover", (e) => this._handleDragOver(e, div));
      div.addEventListener("dragleave", (e) => this._handleDragLeave(e, div));
      div.addEventListener("drop", (e) => this._handleDrop(e, path, div));
    }

    const isExpanded = this.expandedPaths.has(path);
    let icon =
      kind === "directory"
        ? isExpanded
          ? "📂"
          : "📁"
        : this._getFileIcon(name);
    if (name === ".trash") icon = "🗑️";

    div.innerHTML = `
      <span class="mr-2 opacity-80 text-xs pointer-events-none flex-shrink-0">${icon}</span>
      <span class="truncate pointer-events-none flex-1">${name}</span>
      <button class="menu-btn w-6 h-6 flex items-center justify-center text-text-muted hover:text-text-main hover:bg-hover rounded ml-1 transition flex-shrink-0 opacity-100 md:opacity-0 group-hover:opacity-100">
        ⋮
      </button>
    `;

    div.onclick = (e) => this._handleClick(e, path, kind);
    div.oncontextmenu = (e) => this._handleContextMenu(e, path, kind, name);

    const menuBtn = div.querySelector(".menu-btn") as HTMLButtonElement;
    if (menuBtn) {
      menuBtn.onclick = (e) => {
        e.stopPropagation();
        e.preventDefault();
        const rect = menuBtn.getBoundingClientRect();
        this.selectedPath = path;
        this._showContextMenu(rect.left, rect.bottom, path, kind, name);
      };
    }

    li.appendChild(div);

    if (kind === "directory") {
      const childUl = document.createElement("ul");
      childUl.id = `vfs-children-${id}`;
      childUl.className = `tree-children ${isExpanded ? "block" : "hidden"}`;
      li.appendChild(childUl);
    }

    return li;
  }

  private _getFileIcon(filename: string): string {
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

  // ==========================================
  // 4. Interaction Events (Click, Drag & Drop)
  // ==========================================

  private _handleClick(
    e: MouseEvent,
    path: string,
    kind: "file" | "directory",
  ) {
    e.stopPropagation();
    this.selectedPath = path;

    const allNodes = this.container.querySelectorAll(".tree-content");
    allNodes.forEach((el) => {
      el.classList.remove("bg-hover", "border-primary");
      if ((el as HTMLElement).dataset.path === path) {
        el.classList.add("bg-hover", "border-primary");
      }
    });

    if (kind === "directory") {
      const li = (e.currentTarget as HTMLElement).parentElement;
      if (!li) return;

      const ul = li.querySelector("ul");
      const isExpanded = this.expandedPaths.has(path);

      if (isExpanded) {
        this.expandedPaths.delete(path);
      } else {
        this.expandedPaths.add(path);
      }

      if (ul) {
        ul.classList.toggle("hidden");
        const iconSpan = (e.currentTarget as HTMLElement).querySelector(
          "span:first-child",
        );
        if (iconSpan) {
          const name = (e.currentTarget as HTMLElement).dataset.name;
          if (name === ".trash") {
            iconSpan.textContent = "🗑️";
          } else {
            iconSpan.textContent = this.expandedPaths.has(path) ? "📂" : "📁";
          }
        }
      }
    } else {
      if (this.events["open"]) this.events["open"](path);
    }
  }

  private _handleDragStart(
    e: DragEvent,
    path: string,
    kind: "file" | "directory",
  ) {
    e.stopPropagation();
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData(
        "application/itera-file",
        JSON.stringify({ path, kind }),
      );
    }
    (e.target as HTMLElement).style.opacity = "0.5";
  }

  private _handleDragOver(e: DragEvent, element: HTMLElement) {
    if (
      e.dataTransfer &&
      e.dataTransfer.types.includes("application/itera-file")
    ) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      element.classList.add("bg-primary", "text-text-inverted");
    }
  }

  private _handleDragLeave(e: DragEvent, element: HTMLElement) {
    if (
      e.dataTransfer &&
      e.dataTransfer.types.includes("application/itera-file")
    ) {
      e.preventDefault();
      e.stopPropagation();
      element.classList.remove("bg-primary", "text-text-inverted");
    }
  }

  private _handleDrop(
    e: DragEvent,
    targetFolderPath: string,
    element: HTMLElement,
  ) {
    element.classList.remove("bg-primary", "text-text-inverted");

    if (
      e.dataTransfer &&
      e.dataTransfer.types.includes("application/itera-file")
    ) {
      e.preventDefault();
      e.stopPropagation();

      const rawData = e.dataTransfer.getData("application/itera-file");
      if (!rawData) return;

      const data = JSON.parse(rawData);
      this._emitMove(data.path, targetFolderPath);
    }
  }

  private _initRootDropZone() {
    if (!this.container) return;

    this.container.addEventListener("dragover", (e) => {
      if (
        e.dataTransfer &&
        e.dataTransfer.types.includes("application/itera-file")
      ) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        this.container.classList.add(
          "bg-card",
          "ring-2",
          "ring-primary",
          "ring-inset",
        );
      }
    });

    this.container.addEventListener("dragleave", (e) => {
      if (
        e.dataTransfer &&
        e.dataTransfer.types.includes("application/itera-file")
      ) {
        e.preventDefault();
        e.stopPropagation();
        if (!this.container.contains(e.relatedTarget as Node)) {
          this.container.classList.remove(
            "bg-card",
            "ring-2",
            "ring-primary",
            "ring-inset",
          );
        }
      }
    });

    this.container.addEventListener("drop", (e) => {
      if (
        e.dataTransfer &&
        e.dataTransfer.types.includes("application/itera-file")
      ) {
        e.preventDefault();
        e.stopPropagation();
        this.container.classList.remove(
          "bg-card",
          "ring-2",
          "ring-primary",
          "ring-inset",
        );

        const rawData = e.dataTransfer.getData("application/itera-file");
        if (rawData) {
          const data = JSON.parse(rawData);
          this._emitMove(data.path, "");
        }
      }
    });

    document.addEventListener("dragend", (e) => {
      if (
        e.target &&
        (e.target as HTMLElement).classList &&
        (e.target as HTMLElement).classList.contains("tree-content")
      ) {
        (e.target as HTMLElement).style.opacity = "1";
      }
      this.container.classList.remove(
        "bg-card",
        "ring-2",
        "ring-primary",
        "ring-inset",
      );
    });
  }

  private _emitMove(srcPath: string, destFolder: string) {
    if (srcPath === destFolder) return;

    const fileName = srcPath.split("/").pop()!;
    const newPath = destFolder ? `${destFolder}/${fileName}` : fileName;

    if (srcPath === newPath) return;
    if (destFolder.startsWith(srcPath + "/")) {
      alert("Cannot move a folder into its own subfolder.");
      return;
    }

    if (this.events["move"]) {
      this.events["move"](srcPath, newPath);
    }
  }

  // ==========================================
  // 5. Context Menu
  // ==========================================

  private _initGlobalEvents() {
    document.addEventListener("click", (e) => {
      if (this.contextMenu && !this.contextMenu.contains(e.target as Node)) {
        this.contextMenu.classList.add("hidden");
      }
    });

    if (this.container) {
      this.container.addEventListener("contextmenu", (e) => {
        if (
          e.target === this.container ||
          (e.target as HTMLElement).classList.contains("tree-root")
        ) {
          e.preventDefault();
          this._showContextMenu(e.pageX, e.pageY, "", "directory", "root");
        }
      });
    }
  }

  private _handleContextMenu(
    e: MouseEvent,
    path: string,
    kind: "file" | "directory",
    name: string,
  ) {
    e.preventDefault();
    e.stopPropagation();
    this.selectedPath = path;
    this._showContextMenu(e.pageX, e.pageY, path, kind, name);
  }

  private _showContextMenu(
    x: number,
    y: number,
    path: string,
    kind: "file" | "directory",
    name: string,
  ) {
    if (!this.contextMenu) return;

    this.contextMenu.innerHTML = "";
    const actions: any[] = [];

    if (kind === "directory") {
      actions.push({
        label: "New File",
        action: () => this._promptCreate(path, "file"),
      });
      actions.push({
        label: "New Folder",
        action: () => this._promptCreate(path, "folder"),
      });
      actions.push({ separator: true });
      actions.push({
        label: "Upload File Here...",
        action: () => {
          if (this.events["upload_file_request"])
            this.events["upload_file_request"](path);
        },
      });
      actions.push({
        label: "Upload Folder Here...",
        action: () => {
          if (this.events["upload_folder_request"])
            this.events["upload_folder_request"](path);
        },
      });
      actions.push({ separator: true });
    } else if (kind === "file") {
      // ファイルの関連付け (Open With...) を動的に取得
      let resolvedApps: any[] = [];
      if (this.events["resolve_apps"]) {
        resolvedApps = this.events["resolve_apps"](path) || [];
      }

      if (resolvedApps.length > 0) {
        // 先頭はデフォルトアプリ
        const defaultApp = resolvedApps[0];
        const defaultLabel =
          defaultApp.appId === "HostRunner"
            ? "▶ Run (Spawn)"
            : `Open in ${defaultApp.appName}`;

        actions.push({
          label: defaultLabel,
          action: () => {
            if (this.events["open_with"])
              this.events["open_with"](path, defaultApp.appId);
          },
        });

        // 2番目以降はフォールバックとして字下げ表示
        resolvedApps.slice(1).forEach((app) => {
          const fallbackLabel =
            app.appId === "HostRunner"
              ? " ↳ ▶ Run (Spawn)"
              : ` ↳ ${app.appName}`;
          actions.push({
            label: fallbackLabel,
            action: () => {
              if (this.events["open_with"])
                this.events["open_with"](path, app.appId);
            },
          });
        });
        actions.push({ separator: true });
      }
    }

    actions.push({
      label: "Add to Context",
      action: () => {
        if (this.events["add_to_context"]) this.events["add_to_context"](path);
      },
    });
    actions.push({
      label: "Copy Path",
      action: () => {
        navigator.clipboard
          .writeText(path)
          .then(() => {
            if (window.AppUI)
              window.AppUI.notify("Path copied to clipboard", "success");
          })
          .catch((err) => {
            if (window.AppUI)
              window.AppUI.notify(`Failed to copy: ${err.message}`, "error");
          });
      },
    });
    actions.push({ separator: true });

    actions.push({
      label: "Duplicate",
      action: () => {
        if (this.events["duplicate"]) this.events["duplicate"](path);
      },
    });
    actions.push({
      label: "Rename (Move)",
      action: () => this._promptRename(path),
    });
    actions.push({
      label: "Download",
      action: () => {
        if (this.events["download"]) this.events["download"](path);
      },
    });
    actions.push({
      label: "Properties",
      action: () => {
        if (this.events["properties_request"])
          this.events["properties_request"](path);
      },
    });
    actions.push({
      label: "Delete",
      action: () => this._confirmDelete(path, name),
      danger: true,
    });

    for (const item of actions) {
      if (item.separator) {
        const hr = document.createElement("hr");
        hr.className = "border-border-main my-1";
        this.contextMenu.appendChild(hr);
        continue;
      }
      const btn = document.createElement("div");
      btn.className = `px-3 py-1 hover:bg-primary hover:text-white cursor-pointer text-xs ${item.danger ? "text-error hover:text-text-main" : "text-text-main"}`;
      btn.textContent = item.label;
      btn.onclick = () => {
        this.contextMenu!.classList.add("hidden");
        item.action();
      };
      this.contextMenu.appendChild(btn);
    }

    this.contextMenu.classList.remove("hidden");
    const rect = this.contextMenu.getBoundingClientRect();
    const winWidth = window.innerWidth;
    const winHeight = window.innerHeight;

    let posX = x;
    let posY = y;

    if (posX + rect.width > winWidth) posX = winWidth - rect.width - 5;
    if (posY + rect.height > winHeight) posY = winHeight - rect.height - 5;
    if (posX < 0) posX = 5;

    this.contextMenu.style.left = `${posX}px`;
    this.contextMenu.style.top = `${posY}px`;
  }

  private _promptCreate(parentPath: string, type: "file" | "folder") {
    const name = prompt(`Enter new ${type} name:`);
    if (!name) return;

    let fullPath = parentPath ? `${parentPath}/${name}` : name;
    fullPath = fullPath.replace(/^\/+/, "");

    if (type === "folder" && this.events["create_folder"]) {
      this.events["create_folder"](fullPath);
      if (parentPath) this.expandedPaths.add(parentPath);
    }
    if (type === "file" && this.events["create_file"]) {
      this.events["create_file"](fullPath);
      if (parentPath) this.expandedPaths.add(parentPath);
    }
  }

  private _promptRename(path: string) {
    const newPath = prompt(`Edit path to rename/move:`, path);
    if (!newPath || newPath === path) return;
    if (this.events["rename"]) this.events["rename"](path, newPath);
  }

  private _confirmDelete(path: string, name: string) {
    if (confirm(`Are you sure you want to delete "${name}"?`)) {
      if (this.events["delete"]) this.events["delete"](path);
    }
  }
}
