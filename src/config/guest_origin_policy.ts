/**
 * src/config/guest_origin_policy.ts
 * ゲストを一時的にホストと同一オリジンで動かすスイッチ（T-0838）を、この配布物に置くか。
 *
 * 既定ではゲストはホストと同一オリジンではない（`guestSandbox.ts`・T-0785）。Itera では、作ったウェブアプリを
 * ブラウザ本来の挙動（IndexedDB など）で動かしたいときに、人がホストの画面のボタンで境界を外せる。
 * 外している間、ゲストはホストそのものになる（VFS・資格情報・ホストの文書に届く）。
 *
 *   true  … ボタンを出す。（Itera: itera2-dev・itera2。使うのは身内だけ）
 *   false … ボタンを出さず、ゲストを同一オリジンで起動することは決して無い。（ミャク楽: 商用で境界は必須）
 *
 * ここは配布物ごとに値が違う行である。`ProcessManager.ts`・`DesktopEnvironment.ts` は同一に保つ。
 */
export const GUEST_SAME_ORIGIN_SWITCH: boolean = true;
