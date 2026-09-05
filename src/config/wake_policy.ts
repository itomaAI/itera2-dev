/**
 * src/config/wake_policy.ts
 * 起床の方針 —— 配布物ごとに 1 か所で決める（Engine には書かない）。
 *
 * 自分が投げたツールがまだ返っていないあいだに、履歴が変わった（利用者が発言した・
 * デーモンが通知した・別のツールが先に返った）とき、起きてよいか。
 *
 *   'realtime' … 起きる。ツールを待たずに実時間で動く。残りの結果は [Pending] として見え、
 *                返ってきたときにもう一度起きる。（Itera: 個人利用の好み）
 *   'batch'    … 自分のツールが全部返るまで起きない。ただし**利用者の発言だけは追い越せる**。
 *                履歴に [Pending] が残るのは、利用者が自分で割り込んだときだけになる。
 *                （ミャク楽: 利用者に個人の好みを強いない）
 *
 * ここは Itera とミャク楽で値が違う唯一の行である。`Engine.ts` は両者で同一に保つ。
 */
export type WakePolicy = 'realtime' | 'batch';

export const WAKE_POLICY: WakePolicy = 'realtime';
