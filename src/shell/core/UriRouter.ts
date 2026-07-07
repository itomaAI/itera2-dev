/**
 * src/shell/core/UriRouter.ts
 * Itera OS v2: Custom URI Router
 */

export interface ParsedUri {
  intent: string;
  path: string;
  searchAndHash: string;
  queryArgs: Record<string, string>;
}

export class UriRouter {
  private routes: Map<string, Function> = new Map();
  private defaultIntent: string;

  constructor(defaultIntent: string = "open") {
    this.defaultIntent = defaultIntent;
  }

  register(intent: string, handler: Function): void {
    this.routes.set(intent.toLowerCase(), handler);
  }

  hasIntent(intent: string): boolean {
    return this.routes.has(intent.toLowerCase());
  }

  dispatch(uriString: string): boolean {
    if (!uriString || typeof uriString !== "string") return false;

    const parsed = this._parse(uriString.trim());
    if (!parsed) {
      throw new Error(`Invalid URI format: ${uriString}`);
    }

    const handler = this.routes.get(parsed.intent);
    if (!handler) {
      throw new Error(`Unknown action intent: '${parsed.intent}'`);
    }

    // 第2引数としてパース済みのクエリオブジェクトを追加で渡す
    handler(parsed.path, parsed.queryArgs, parsed.searchAndHash);
    return true;
  }

  private _parse(uri: string): ParsedUri | null {
    let normalized = uri;

    // metaos:// プレフィックスがない場合は補完
    if (!normalized.startsWith("metaos://")) {
      normalized = `metaos://${normalized}`;
    }

    // 正規表現で metaos://[fullPath][?query#hash] を分解
    const match = normalized.match(/^metaos:\/\/([^\?#]+)(.*)$/);
    if (!match) return null;

    const fullPath = match[1]; // 例: "open/data/notes.md" または "data/notes.md"
    const searchAndHash = match[2] || "";

    const segments = fullPath.split("/");
    const firstSegment = segments[0].toLowerCase();

    let intent = this.defaultIntent;
    let pathSegments = segments;

    // 最初のセグメントが登録済みのIntentであれば、それを採用する
    if (this.hasIntent(firstSegment)) {
      intent = firstSegment;
      pathSegments = segments.slice(1);
    }

    const path = decodeURIComponent(pathSegments.join("/"));

    // クエリパラメータの抽出
    const queryArgs: Record<string, string> = {};
    const hashIndex = searchAndHash.indexOf("#");
    const searchString = hashIndex !== -1 ? searchAndHash.substring(0, hashIndex) : searchAndHash;
    
    if (searchString.startsWith("?")) {
      const params = new URLSearchParams(searchString.substring(1));
      params.forEach((value, key) => {
        queryArgs[key] = value;
      });
    }

    return {
      intent,
      path,
      searchAndHash,
      queryArgs,
    };
  }
}
