/**
 * src/shell/windowing/GuestCompiler.ts
 * Itera OS v2: Guest Process Compiler (VFS to Blob URL)
 */

import type { VfsService } from "../../core/vfs/VfsService";
import { SYSTEM_PRINCIPAL, type VfsStat } from "../../core/vfs/types";
import { GuestBridgeBuilder } from "../../api/GuestBridgeBuilder";

interface CachedAsset {
  url: string;
  version: number;
}

export class GuestCompiler {
  private assetCache: Map<string, CachedAsset>;

  constructor() {
    this.assetCache = new Map();
  }

  private _parsePath(path: string): {
    basePath: string;
    search: string;
    hash: string;
  } {
    if (!path) return { basePath: "", search: "", hash: "" };

    let basePath = path;
    let search = "";
    let hash = "";

    const hashIdx = basePath.indexOf("#");
    if (hashIdx !== -1) {
      hash = basePath.substring(hashIdx);
      basePath = basePath.substring(0, hashIdx);
    }

    const queryIdx = basePath.indexOf("?");
    if (queryIdx !== -1) {
      search = basePath.substring(queryIdx);
      basePath = basePath.substring(0, queryIdx);
    }

    return { basePath, search, hash };
  }

  private _getScreenshotHelperCode(pid: string): string {
    return `
<script src="https://cdnjs.cloudflare.com/ajax/libs/html-to-image/1.11.11/html-to-image.min.js"></script>
<script>
window.addEventListener('message', async (e) => {
    if (e.data.action === 'CAPTURE') {
        try {
            let attempts = 0;
            while (typeof window.htmlToImage === 'undefined' && attempts < 20) {
                await new Promise(r => setTimeout(r, 100));
                attempts++;
            }
            if (typeof window.htmlToImage === 'undefined') throw new Error('html-to-image failed to load');
            
            const data = await window.htmlToImage.toPng(document.body, { 
                backgroundColor: null, 
                skipOnError: true, 
                preferredFontFormat: 'woff2',
                filter: (node) => {
                    if (node.tagName === 'IMG' && (!node.src || node.src === '' || node.src === window.location.href)) return false;
                    return true;
                }
            });
            parent.postMessage({ type: 'SCREENSHOT_RESULT', pid: '${pid}', data }, '*');
        } catch (err) {
            parent.postMessage({ type: 'SCREENSHOT_ERROR', pid: '${pid}', message: String(err) }, '*');
        }
    }
});
</script>
`;
  }

  getMimeType(filename: string): string {
    const ext = filename.split(".").pop()?.toLowerCase() || "";
    const map: Record<string, string> = {
      js: "application/javascript",
      ts: "application/javascript",
      css: "text/css",
      json: "application/json",
      svg: "image/svg+xml",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      html: "text/html",
    };
    return map[ext] || "text/plain";
  }

  async compile(
    vfs: VfsService,
    entryPath: string,
    pid: string = "main",
  ): Promise<{ entryUrl: string | null; blobUrls: string[] }> {
    const parsedEntry = this._parsePath(entryPath);
    // OSコンパイラはシステム権限で全ファイルをスキャンする
    const stats = vfs.listFiles(SYSTEM_PRINCIPAL, {
      recursive: true,
      detail: true,
    }) as VfsStat[];
    const currentFiles = new Set(stats.map((s) => s.path));
    const urlMap: Record<string, string> = {};
    const blobUrls: string[] = [];

    // 0. キャッシュのクリーンアップ
    for (const [path, cached] of this.assetCache.entries()) {
      if (!currentFiles.has(path)) {
        URL.revokeObjectURL(cached.url);
        this.assetCache.delete(path);
      }
    }

    // 1. Assets (HTML, CSS以外) の Blob 作成
    for (const stat of stats) {
      if (stat.kind !== "file") continue;
      if (stat.path.endsWith(".html") || stat.path.endsWith(".css")) continue;

      const cached = this.assetCache.get(stat.path);
      if (cached && cached.version === stat.updatedAt) {
        urlMap[stat.path] = cached.url;
        continue;
      }

      if (cached) URL.revokeObjectURL(cached.url);

      const mimeType = stat.mimeType || this.getMimeType(stat.path);
      // V2の恩恵: OPFSから直接Blobを読み出すため超高速
      const blob = await vfs.readBlob(SYSTEM_PRINCIPAL, stat.path);

      // Blob の MIME Type が空になる場合があるため、明示的に指定して再生成
      const typedBlob = new Blob([blob], { type: mimeType });
      const url = URL.createObjectURL(typedBlob);

      this.assetCache.set(stat.path, { url, version: stat.updatedAt });
      urlMap[stat.path] = url;
    }

    // 2. CSS の Blob 作成
    for (const stat of stats) {
      if (stat.kind !== "file") continue;
      if (!stat.path.endsWith(".css")) continue;

      let cssContent = await vfs.readFile(SYSTEM_PRINCIPAL, stat.path);
      cssContent = this._processCssReferences(cssContent, urlMap, stat.path);

      const blob = new Blob([cssContent], { type: "text/css" });
      const url = URL.createObjectURL(blob);
      urlMap[stat.path] = url;
      blobUrls.push(url);
    }

    let entryPointUrl: string | null = null;
    const themeStyleTag = this._generateThemeInjection();

    // 3. HTML (スクリプト/スタイル注入) の Blob 作成
    for (const stat of stats) {
      if (stat.kind !== "file") continue;
      if (!stat.path.endsWith(".html")) continue;

      let htmlContent = await vfs.readFile(SYSTEM_PRINCIPAL, stat.path);
      htmlContent = this._processHtmlReferences(htmlContent, urlMap, stat.path);

      if (!/<!DOCTYPE\s+html>/i.test(htmlContent)) {
        htmlContent = "<!DOCTYPE html>\n" + htmlContent;
      }

      const hostLang = document.documentElement.lang || "en";
      htmlContent = htmlContent.replace(/<html[^>]*>/i, (match) => {
        if (match.includes("lang=")) {
          return match.replace(/lang=(['"]).*?\1/i, `lang="${hostLang}"`);
        } else {
          return match.replace("<html", `<html lang="${hostLang}"`);
        }
      });

      // Guest Bridge (MetaOS API) の注入
      const bridgeUrl = GuestBridgeBuilder.getBlobUrl();
      let headInjections = `\n<script>window.__ITERA_PID__ = '${pid}';</script>\n<script src="${bridgeUrl}"></script>\n`;

      // V1のハックを維持: URLSearchParamsのモンキーパッチ注入 (Blob URLでのクエリパラメータ偽装)
      if (
        stat.path === parsedEntry.basePath &&
        (parsedEntry.search || parsedEntry.hash)
      ) {
        const safeQuery = (parsedEntry.search + parsedEntry.hash).replace(
          /'/g,
          "\\'",
        );
        headInjections += `
<script>
(function() {
    const INJECTED = '${safeQuery}';
    const Original = window.URLSearchParams;
    window.URLSearchParams = class extends Original {
        constructor(init) {
            if (init === undefined || init === '' || init === window.location.search) {
                super(INJECTED);
            } else {
                super(init);
            }
        }
    };
})();
</script>\n`;
      }

      if (htmlContent.includes("<head>")) {
        htmlContent = htmlContent.replace("<head>", "<head>" + headInjections);
      } else {
        htmlContent = htmlContent.replace(
          /(<!DOCTYPE\s+html>)/i,
          `$1${headInjections}`,
        );
      }

      if (htmlContent.includes("</head>")) {
        htmlContent = htmlContent.replace(
          "</head>",
          themeStyleTag + "\n</head>",
        );
      } else {
        htmlContent = htmlContent.replace(
          /(<!DOCTYPE\s+html>)/i,
          `$1\n${themeStyleTag}`,
        );
      }

      htmlContent = htmlContent.replace(
        "</body>",
        this._getScreenshotHelperCode(pid) + "\n</body>",
      );

      const blob = new Blob([htmlContent], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      urlMap[stat.path] = url;
      blobUrls.push(url);

      if (stat.path === parsedEntry.basePath) {
        entryPointUrl = url;
      }
    }

    if (!entryPointUrl) {
      if (urlMap["index.html"]) {
        entryPointUrl = urlMap["index.html"];
      } else {
        const firstHtml = Object.keys(urlMap).find((p) => p.endsWith(".html"));
        if (firstHtml) entryPointUrl = urlMap[firstHtml];
      }
    }

    return { entryUrl: entryPointUrl, blobUrls };
  }

  private _generateThemeInjection(): string {
    const root = document.documentElement;
    const styles = getComputedStyle(root);
    const vars = [
      "--c-bg-app",
      "--c-bg-panel",
      "--c-bg-card",
      "--c-bg-hover",
      "--c-bg-overlay",
      "--c-border-main",
      "--c-border-highlight",
      "--c-text-main",
      "--c-text-muted",
      "--c-text-inverted",
      "--c-text-system",
      "--c-text-tag-attr",
      "--c-text-tag-content",
      "--c-accent-primary",
      "--c-accent-success",
      "--c-accent-warning",
      "--c-accent-error",
      "--c-tag-thinking",
      "--c-tag-plan",
      "--c-tag-report",
      "--c-tag-error",
    ];

    let css = ":root {\n";
    vars.forEach((v) => {
      const val = styles.getPropertyValue(v).trim();
      if (val) css += `  ${v}: ${val};\n`;
    });
    css += "}";

    return `<style id="itera-guest-theme">${css}</style>`;
  }

  private _processHtmlReferences(
    html: string,
    urlMap: Record<string, string>,
    currentFilePath: string,
  ): string {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const currentDir = currentFilePath.includes("/")
      ? currentFilePath.substring(0, currentFilePath.lastIndexOf("/"))
      : "";

    const resolvePath = (relPath: string) => {
      if (relPath.startsWith("/")) return relPath.substring(1);
      if (relPath.match(/^https?:\/\//) || relPath.startsWith("data:"))
        return null;

      const stack = currentDir ? currentDir.split("/") : [];
      const parts = relPath.split("/");
      for (const part of parts) {
        if (part === ".") continue;
        if (part === "..") {
          if (stack.length > 0) stack.pop();
        } else {
          stack.push(part);
        }
      }
      return stack.join("/");
    };

    const replaceAttr = (selector: string, attr: string) => {
      doc.querySelectorAll(selector).forEach((el) => {
        const val = el.getAttribute(attr);
        if (!val) return;

        const { basePath, search, hash } = this._parsePath(val);
        const suffix = search + hash;
        const targetPath = basePath === "" ? currentFilePath : basePath;

        if (urlMap[targetPath]) {
          el.setAttribute(attr, urlMap[targetPath] + suffix);
          return;
        }

        const resolved = resolvePath(basePath);
        if (resolved && urlMap[resolved]) {
          el.setAttribute(attr, urlMap[resolved] + suffix);
        }
      });
    };

    replaceAttr("script[src]", "src");
    replaceAttr("link[href]", "href");
    replaceAttr("img[src]", "src");
    replaceAttr("a[href]", "href");
    replaceAttr("iframe[src]", "src");

    doc.querySelectorAll("[style]").forEach((el) => {
      const styleContent = el.getAttribute("style");
      if (styleContent && styleContent.includes("url(")) {
        const resolvedStyle = this._processCssReferences(
          styleContent,
          urlMap,
          currentFilePath,
        );
        el.setAttribute("style", resolvedStyle);
      }
    });

    return doc.documentElement.outerHTML;
  }

  private _processCssReferences(
    cssContent: string,
    urlMap: Record<string, string>,
    currentFilePath: string,
  ): string {
    const currentDir = currentFilePath.includes("/")
      ? currentFilePath.substring(0, currentFilePath.lastIndexOf("/"))
      : "";

    const resolvePath = (relPath: string) => {
      if (relPath.startsWith("/")) return relPath.substring(1);
      if (relPath.match(/^https?:\/\//) || relPath.startsWith("data:"))
        return null;

      const stack = currentDir ? currentDir.split("/") : [];
      const parts = relPath.split("/");
      for (const part of parts) {
        if (part === ".") continue;
        if (part === "..") {
          if (stack.length > 0) stack.pop();
        } else {
          stack.push(part);
        }
      }
      return stack.join("/");
    };

    const urlRegex = /url\(\s*(['"]?)(.*?)\1\s*\)/g;

    return cssContent.replace(urlRegex, (match, quote, relPath) => {
      if (
        !relPath ||
        relPath.match(/^https?:\/\//) ||
        relPath.startsWith("data:")
      ) {
        return match;
      }

      const { basePath, search, hash } = this._parsePath(relPath);
      const suffix = search + hash;
      const targetPath = basePath === "" ? currentFilePath : basePath;

      if (urlMap[targetPath]) {
        return `url(${quote}${urlMap[targetPath]}${suffix}${quote})`;
      }

      const resolved = resolvePath(basePath);
      if (resolved && urlMap[resolved]) {
        return `url(${quote}${urlMap[resolved]}${suffix}${quote})`;
      }

      return match;
    });
  }
}
