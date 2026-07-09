/**
 * src/shell/modals/MediaViewer.ts
 * Itera OS v2: Host Media Viewer Modal (Fallback UI)
 */

const DOM_IDS = {
  OVERLAY: "media-overlay",
  IMAGE: "media-image",
  FILENAME: "media-filename",
  BTN_CLOSE: "btn-close-media",
};

export class MediaViewer {
  private els: Record<string, HTMLElement | null> = {};
  private currentObjectUrl: string | null = null;
  private events: Record<string, Function> = {};

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
    if (this.els.BTN_CLOSE) {
      this.els.BTN_CLOSE.onclick = () => this.close();
    }
    if (this.els.OVERLAY) {
      this.els.OVERLAY.onclick = (e) => {
        if (e.target === this.els.OVERLAY) this.close();
      };
    }
  }

  /**
   * OPFSから読み出したBlobを直接受け取り、ビューワを開く (V2仕様)
   * @param path ファイルパス
   * @param blob 表示するBlobオブジェクト
   * @param mimeType MIMEタイプ (省略時はBlobまたは拡張子から推測)
   */
  open(path: string, blob: Blob, mimeType: string | null = null): void {
    if (this.els.FILENAME) this.els.FILENAME.textContent = path;
    if (!this.els.OVERLAY) return;

    this._closeResource();

    const mime = mimeType || blob.type || this._guessMime(path);

    if (this.els.IMAGE) {
      this.els.IMAGE.classList.add("hidden");
      (this.els.IMAGE as HTMLImageElement).src = "";
    }

    // 動的に生成したiframe等の要素をクリーンアップ
    this.els.OVERLAY.querySelectorAll(".dynamic-content").forEach((el) =>
      el.remove(),
    );

    if (mime === "application/pdf") {
      this._renderPdf(blob);
    } else if (mime.startsWith("image/")) {
      this._renderImage(blob);
    } else {
      this._renderFallback(path, blob, mime);
    }

    this.els.OVERLAY.classList.remove("hidden");
  }

  close(): void {
    if (this.els.OVERLAY) {
      this.els.OVERLAY.classList.add("hidden");
      this.els.OVERLAY.querySelectorAll(".dynamic-content").forEach((el) =>
        el.remove(),
      );
    }
    if (this.els.IMAGE) {
      (this.els.IMAGE as HTMLImageElement).src = "";
      this.els.IMAGE.classList.add("hidden");
    }
    this._closeResource();
  }

  private _closeResource(): void {
    if (this.currentObjectUrl) {
      URL.revokeObjectURL(this.currentObjectUrl);
      this.currentObjectUrl = null;
    }
  }

  private _renderPdf(blob: Blob): void {
    this.currentObjectUrl = URL.createObjectURL(blob);

    const iframe = document.createElement("iframe");
    iframe.src = this.currentObjectUrl;
    iframe.className =
      "dynamic-content w-[90%] h-[80%] rounded shadow-lg border border-border-main bg-card";
    this.els.OVERLAY!.appendChild(iframe);
  }

  private _renderImage(blob: Blob): void {
    this.currentObjectUrl = URL.createObjectURL(blob);

    if (this.els.IMAGE) {
      (this.els.IMAGE as HTMLImageElement).src = this.currentObjectUrl;
      this.els.IMAGE.classList.remove("hidden");
    }
  }

  private _renderFallback(path: string, blob: Blob, mime: string): void {
    const div = document.createElement("div");
    div.className =
      "dynamic-content bg-card p-8 rounded-lg border border-border-main flex flex-col items-center text-center shadow-xl";

    div.innerHTML = `
      <div class="text-4xl mb-4">📦</div>
      <div class="text-lg font-bold text-text-main mb-2">Preview Not Available</div>
      <div class="text-sm text-text-muted mb-6 font-mono">${mime || "Unknown Type"}</div>
    `;

    const btn = document.createElement("button");
    btn.className =
      "bg-primary hover:bg-primary/80 text-white px-4 py-2 rounded text-sm transition flex items-center gap-2";
    btn.innerHTML = "Download File";
    btn.onclick = () => {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = path.split("/").pop() || "download";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      // ダウンロードが発火するまでの猶予を見てからURLを破棄
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    div.appendChild(btn);
    this.els.OVERLAY!.appendChild(div);
  }

  private _guessMime(path: string): string {
    const lowerPath = path.toLowerCase();
    if (lowerPath.endsWith(".svg")) return "image/svg+xml";
    if (lowerPath.endsWith(".jpg") || lowerPath.endsWith(".jpeg"))
      return "image/jpeg";
    if (lowerPath.endsWith(".gif")) return "image/gif";
    if (lowerPath.endsWith(".webp")) return "image/webp";
    if (lowerPath.endsWith(".png")) return "image/png";
    if (lowerPath.endsWith(".pdf")) return "application/pdf";
    if (lowerPath.endsWith(".mp3")) return "audio/mpeg";
    if (lowerPath.endsWith(".mp4")) return "video/mp4";
    return "";
  }
}
