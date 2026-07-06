/**
 * src/shell/core/UriRouter.ts
 * Itera OS v2: Custom URI Router
 */

export class UriRouter {
  private routes: Map<string, Function> = new Map();
  private defaultScheme: string;

  constructor(defaultScheme: string = "view") {
    this.defaultScheme = defaultScheme;
  }

  register(scheme: string, handler: Function): void {
    this.routes.set(scheme, handler);
  }

  dispatch(uriString: string): boolean {
    if (!uriString || typeof uriString !== "string") return false;

    let normalizedUri = uriString.trim();
    if (!normalizedUri.startsWith("metaos://")) {
      // スキームが省略された場合はデフォルト(view)を補完する
      normalizedUri = `metaos://${this.defaultScheme}/${normalizedUri}`;
    }

    const match = normalizedUri.match(/^metaos:\/\/([^\/]+)\/?([^?#]*)(.*)$/);
    if (!match) {
      throw new Error(`Invalid URI format: ${uriString}`);
    }

    const scheme = match[1];
    const path = decodeURIComponent(match[2] || "");
    const searchAndHash = match[3] || "";

    const handler = this.routes.get(scheme);
    if (!handler) {
      throw new Error(`Unknown action scheme: '${scheme}'`);
    }

    handler(path, searchAndHash);
    return true;
  }
}
