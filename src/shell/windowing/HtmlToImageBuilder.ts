/**
 * src/shell/windowing/HtmlToImageBuilder.ts
 * Itera OS v2: html-to-image Library Injector
 *
 * ゲスト(iframe)はVFS上のファイルをBlob URLとしてコンパイルして実行されるため、
 * 相対パスやVFSパスによるライブラリ参照ができない。
 * また、スクリーンショット補助コードは GuestCompiler._injectHtmlScripts で
 * 「依存解決(_processHtmlDependencies)が終わった後」に追加されるため、
 * そこにVFSパスを書いてもBlob URLへ書き換えられない。
 *
 * そのため GuestBridgeBuilder と同じく、バンドル済みのライブラリ本体を
 * Blob URL として公開し、その URL をゲストへ注入する。
 */

import htmlToImageSource from 'html-to-image/dist/html-to-image.js?raw';

export class HtmlToImageBuilder {
  private static cachedUrl: string | null = null;

  /**
   * html-to-image (UMD) を Blob URL として生成する。
   * 生成済みのURLはキャッシュして使い回す。
   */
  static getBlobUrl(): string {
    if (this.cachedUrl) return this.cachedUrl;

    const blob = new Blob([htmlToImageSource], { type: 'application/javascript' });
    this.cachedUrl = URL.createObjectURL(blob);
    return this.cachedUrl;
  }
}