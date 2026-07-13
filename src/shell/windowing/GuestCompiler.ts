/**
 * src/shell/windowing/GuestCompiler.ts
 * Itera OS v2: Guest Process Compiler (VFS to Blob URL)
 */

import type { VfsService } from "../../core/vfs/VfsService";
import { USER_PRINCIPAL } from "../../core/vfs/types";
import { GuestBridgeBuilder } from "../../api/GuestBridgeBuilder";

interface CachedAsset {
  url: string;
  version: number;
}

export class GuestCompiler {
  private assetCache: Map<string, CachedAsset> = new Map();

  constructor() {}

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

  private _resolveRelativePath(baseDir: string, relPath: string): string {
    if (relPath.startsWith("/")) {
      baseDir = "";
      relPath = relPath.substring(1);
    }
    const stack = baseDir ? baseDir.split("/") : [];
    const parts = relPath.split("/");

    for (const part of parts) {
      if (part === "." || part === "") continue;
      if (part === "..") {
        if (stack.length > 0) stack.pop();
      } else {
        stack.push(part);
      }
    }
    return stack.join("/");
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
    args?: Record<string, string>,
  ): Promise<{ entryUrl: string | null; blobUrls: string[] }> {
    const blobUrls: string[] = [];
    const visited = new Map<string, string>(); // path + search + hash -> blobUrl

    // 再帰的に依存を解決してエントリーポイントのURLを生成する
    const entryUrl = await this._processFile(
      vfs,
      entryPath,
      pid,
      blobUrls,
      visited,
      "",
      args,
    );

    return { entryUrl, blobUrls };
  }

  /**
   * ファイルをパースし、再帰的に依存を解決して Blob URL を返す。
   */
  private async _processFile(
    vfs: VfsService,
    requestPath: string,
    pid: string,
    blobUrls: string[],
    visited: Map<string, string>,
    currentDir: string,
    args?: Record<string, string>,
  ): Promise<string | null> {
    const { basePath, search, hash } = this._parsePath(requestPath);

    // 外部URLや Data URI はそのまま返す
    if (
      !basePath ||
      basePath.match(/^https?:\/\//) ||
      basePath.startsWith("data:")
    ) {
      return requestPath;
    }

    const absPath = this._resolveRelativePath(currentDir, basePath);
    const visitKey = absPath + search + hash;

    // 循環参照防止（すでにコンパイル済みのファイルはキャッシュのURLを返す）
    if (visited.has(visitKey)) {
      return visited.get(visitKey)!;
    }

    if (!vfs.exists(USER_PRINCIPAL, absPath)) {
      console.warn(`[GuestCompiler] File not found: ${absPath}`);
      return requestPath;
    }

    const stat = vfs.stat(USER_PRINCIPAL, absPath);
    if (stat.kind !== "file") return requestPath;

    const mimeType = stat.mimeType || this.getMimeType(absPath);
    const isHtml = absPath.endsWith(".html");
    const isCss = absPath.endsWith(".css");

    // HTML/CSS以外の静的アセットはグローバルキャッシュ(assetCache)を確認
    if (!isHtml && !isCss) {
      const cached = this.assetCache.get(absPath);
      if (cached && cached.version === stat.updatedAt) {
        const urlWithQuery = cached.url + search + hash;
        visited.set(visitKey, urlWithQuery);
        return urlWithQuery;
      }
    }

    let fileUrl: string;

    if (isHtml) {
      let htmlContent = await vfs.readFile(USER_PRINCIPAL, absPath);
      htmlContent = await this._processHtmlDependencies(
        htmlContent,
        vfs,
        pid,
        blobUrls,
        visited,
        absPath,
      );
      htmlContent = this._injectHtmlScripts(
        htmlContent,
        pid,
        search,
        hash,
        args,
      );

      const blob = new Blob([htmlContent], { type: "text/html" });
      fileUrl = URL.createObjectURL(blob);
      blobUrls.push(fileUrl);
    } else if (isCss) {
      let cssContent = await vfs.readFile(USER_PRINCIPAL, absPath);
      cssContent = await this._processCssDependencies(
        cssContent,
        vfs,
        pid,
        blobUrls,
        visited,
        absPath,
      );

      const blob = new Blob([cssContent], { type: "text/css" });
      fileUrl = URL.createObjectURL(blob);
      blobUrls.push(fileUrl);
    } else {
      // 静的アセットの Blob 生成とグローバルキャッシュ保存
      const rawBlob = await vfs.readBlob(USER_PRINCIPAL, absPath);
      const typedBlob = new Blob([rawBlob], { type: mimeType });
      fileUrl = URL.createObjectURL(typedBlob);

      const oldCache = this.assetCache.get(absPath);
      if (oldCache) URL.revokeObjectURL(oldCache.url);

      this.assetCache.set(absPath, { url: fileUrl, version: stat.updatedAt });
    }

    const finalUrl = fileUrl + search + hash;
    visited.set(visitKey, finalUrl);
    return finalUrl;
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
      "--font-sans",
      "--font-mono",
    ];

    let css = ":root {\n";
    vars.forEach((v) => {
      const val = styles.getPropertyValue(v).trim();
      if (val) css += `  ${v}: ${val};\n`;
    });

    const fontSize = root.style.fontSize || '16px';
    css += `  font-size: ${fontSize};\n`;
    css += "}";

    if (root.getAttribute('data-animations') === 'false') {
      css += "\n* { animation-duration: 0.001ms !important; transition-duration: 0.001ms !important; scroll-behavior: auto !important; }";
    }

    return `<style id="itera-guest-theme">${css}</style>`;
  }

  private async _processHtmlDependencies(
    html: string,
    vfs: VfsService,
    pid: string,
    blobUrls: string[],
    visited: Map<string, string>,
    currentFilePath: string,
  ): Promise<string> {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const currentDir = currentFilePath.includes("/")
      ? currentFilePath.substring(0, currentFilePath.lastIndexOf("/"))
      : "";

    const processElements = async (selector: string, attr: string) => {
      const elements = Array.from(doc.querySelectorAll(selector));
      for (const el of elements) {
        const val = el.getAttribute(attr);
        if (!val) continue;

        // <a href="..."> はOSナビゲーションを破壊するため置換から除外
        if (selector === "a[href]") continue;

        const newUrl = await this._processFile(
          vfs,
          val,
          pid,
          blobUrls,
          visited,
          currentDir,
        );
        if (newUrl && newUrl !== val) {
          el.setAttribute(attr, newUrl);
        }
      }
    };

    await processElements("script[src]", "src");
    await processElements("link[href]", "href");
    await processElements("img[src]", "src");
    await processElements("iframe[src]", "src");
    await processElements("video[src]", "src");
    await processElements("audio[src]", "src");
    await processElements("source[src]", "src");
    await processElements("embed[src]", "src");
    await processElements("object[data]", "data");

    const styleElements = Array.from(doc.querySelectorAll("[style]"));
    for (const el of styleElements) {
      const styleContent = el.getAttribute("style");
      if (styleContent && styleContent.includes("url(")) {
        const resolvedStyle = await this._processCssDependencies(
          styleContent,
          vfs,
          pid,
          blobUrls,
          visited,
          currentFilePath,
        );
        el.setAttribute("style", resolvedStyle);
      }
    }

    const styleTags = Array.from(doc.querySelectorAll("style"));
    for (const style of styleTags) {
      if (style.textContent && style.textContent.includes("url(")) {
        style.textContent = await this._processCssDependencies(
          style.textContent,
          vfs,
          pid,
          blobUrls,
          visited,
          currentFilePath,
        );
      }
    }

    return doc.documentElement.outerHTML;
  }

  private async _processCssDependencies(
    cssContent: string,
    vfs: VfsService,
    pid: string,
    blobUrls: string[],
    visited: Map<string, string>,
    currentFilePath: string,
  ): Promise<string> {
    const currentDir = currentFilePath.includes("/")
      ? currentFilePath.substring(0, currentFilePath.lastIndexOf("/"))
      : "";

    const urlRegex = /url\(\s*(['"]?)(.*?)\1\s*\)/g;
    const matches = Array.from(cssContent.matchAll(urlRegex));

    let result = cssContent;

    // 後ろから置換することでインデックスのズレを防ぐ
    for (let i = matches.length - 1; i >= 0; i--) {
      const match = matches[i];
      const quote = match[1];
      const relPath = match[2];

      if (
        !relPath ||
        relPath.match(/^https?:\/\//) ||
        relPath.startsWith("data:")
      ) {
        continue;
      }

      const newUrl = await this._processFile(
        vfs,
        relPath,
        pid,
        blobUrls,
        visited,
        currentDir,
      );
      if (newUrl && newUrl !== relPath) {
        const replacement = `url(${quote}${newUrl}${quote})`;
        result =
          result.substring(0, match.index!) +
          replacement +
          result.substring(match.index! + match[0].length);
      }
    }

    return result;
  }

  private _injectHtmlScripts(
    htmlContent: string,
    pid: string,
    _search: string,
    _hash: string,
    args?: Record<string, string>,
  ): string {
    let html = htmlContent;

    if (!/<!DOCTYPE\s+html>/i.test(html)) {
      html = "<!DOCTYPE html>\n" + html;
    }

    const hostLang = document.documentElement.lang || "en";
    html = html.replace(/<html[^>]*>/i, (match) => {
      if (match.includes("lang=")) {
        return match.replace(/lang=(['"]).*?\1/i, `lang="${hostLang}"`);
      } else {
        return match.replace("<html", `<html lang="${hostLang}"`);
      }
    });

    const bridgeUrl = GuestBridgeBuilder.getBlobUrl();
    let headInjections = `\n<script>window.__ITERA_PID__ = '${pid}';</script>\n`;

    // V1のモンキーパッチハックを廃止し、クリーンなグローバル変数として引数を注入
    if (args) {
      headInjections += `<script>window.__ITERA_ARGS__ = ${JSON.stringify(args)};</script>\n`;
    }

    headInjections += `<script src="${bridgeUrl}"></script>\n`;

    if (html.includes("<head>")) {
      html = html.replace("<head>", "<head>" + headInjections);
    } else {
      html = html.replace(/(<!DOCTYPE\s+html>)/i, `$1${headInjections}`);
    }

    const themeStyleTag = this._generateThemeInjection();
    if (html.includes("</head>")) {
      html = html.replace("</head>", themeStyleTag + "\n</head>");
    } else {
      html = html.replace(/(<!DOCTYPE\s+html>)/i, `$1\n${themeStyleTag}`);
    }

    html = html.replace(
      "</body>",
      this._getScreenshotHelperCode(pid) + "\n</body>",
    );

    return html;
  }
}
