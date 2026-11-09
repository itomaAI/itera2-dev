/**
 * src/utils/jsLiteral.ts
 * インラインの `<script>` に埋めても安全な JSON リテラル。
 * `</script>` などの閉じタグが値の中に在ってもスクリプトが途中で終わらないように、`<` `>` を \u エスケープにする。
 */
export function jsLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}
