/**
 * src/api/GuestBridgeBuilder.ts
 * Itera OS v2: Guest Bridge Code Generator
 */

import guestBridgeSource from './guest_bridge.js?raw';

export class GuestBridgeBuilder {
  private static cachedUrl: string | null = null;

  /**
   * Guest環境に注入するAPIコードを Blob URL として生成する。
   * メモリ効率化のため、生成済みのURLはキャッシュされる。
   */
  static getBlobUrl(): string {
    if (this.cachedUrl) return this.cachedUrl;

    const bundleCode = guestBridgeSource.trim();
    const blob = new Blob([bundleCode], { type: 'application/javascript' });
    this.cachedUrl = URL.createObjectURL(blob);
    return this.cachedUrl;
  }
}
