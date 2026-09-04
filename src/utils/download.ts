/**
 * src/utils/download.ts
 * Blob をブラウザのダウンロードとして保存させる（T-0344 で Explorer から切り出した）。
 * Explorer のコンテキストメニューと、チャットの files 枠が同じ経路を使う。
 */
export function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
}
