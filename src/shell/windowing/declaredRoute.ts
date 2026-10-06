/**
 * src/shell/windowing/declaredRoute.ts
 * ゲストの申告（nav.declare）から、そのプロセスの新しい path と URI を計算する（T-0453 / T-0468 / T-0619）。
 *
 * - '?' / '#' で始まれば、いまの path の base（? # より前）に付け足す
 * - `metaos://<intent>/<path>` の完全な URI なら intent とパスに分けて受ける（そのまま前置すると二重になる。T-0468）
 * - 空なら base に戻る
 * - intent は、いまの URI のものを保つ（完全な URI で申告されたらそちら）。無ければ 'open'
 *
 * 純関数。誰に当てるか（呼び出し元か前面か）は ProcessManager.declareRoute が決める。
 */
export function declaredRoute(
  proc: { path: string; currentUri: string },
  declaredPath: string,
): { path: string; uri: string } {
  const oldBasePath = proc.path.split(/[?#]/)[0];
  const intentMatch = proc.currentUri.match(/^metaos:\/\/([^/]+)/);
  let intent = intentMatch ? intentMatch[1] : 'open';
  let declared = String(declaredPath || '');
  const full = declared.match(/^metaos:\/\/([^/]+)\/(.*)$/);
  if (full) {
    intent = full[1];
    declared = full[2];
  }
  const path = declared.startsWith('?') || declared.startsWith('#') ? oldBasePath + declared : declared || oldBasePath;
  return { path, uri: `metaos://${intent}/${path}` };
}
