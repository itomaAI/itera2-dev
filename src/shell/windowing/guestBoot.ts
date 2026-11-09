/**
 * src/shell/windowing/guestBoot.ts
 * Itera OS v2: ゲストの二段起動のホスト側（T-0770 / T-0784）
 *
 * 1 段目: {@link bootstrapHtml} を iframe の srcdoc に置く。中の `guest_bootstrap.js` がホストに `sys:boot` を頼む。
 * 2 段目: ホストは {@link GuestBoot.body}（compile の結果）を返し、ゲストが自分の窓で object URL を作って本体を書く。
 * 本体のブリッジは文書の load で `sys:ready` を送り、{@link GuestBoot.ready} が解ける。spawn はそれを待つ
 * （以前の「入口の文書の load を待つ」と同じ時点。失敗・kill・時間切れでも待ちは解ける）。
 */

import bootstrapSource from './guest_bootstrap.js?raw';
import { jsLiteral } from '../../utils/jsLiteral';
import type { CompiledGuest } from './GuestCompiler';

/** 1 段目の文書。PID だけを別の `<script>` で渡し、ブートストラップ本体は文字列の補間をしない */
export function bootstrapHtml(pid: string): string {
  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8">` +
    `<script>window.__ITERA_PID__ = ${jsLiteral(pid)};</script></head>` +
    `<body><script>${bootstrapSource}</script></body></html>`
  );
}

/**
 * 1 プロセスの起動の記録。compile は spawn が iframe を作るのと並行に始め、ゲストの `sys:boot` がその結果を待つ
 * （直列にすると起動が +50〜100 ms 遅れる。T-0770 E4）。
 */
export class GuestBoot {
  /** 本体。compile が失敗すれば reject（ゲストはその文を表示する） */
  readonly body: Promise<CompiledGuest>;
  /** 本体の文書が load した（または起動が失敗した・捨てられた）。spawn の待ち合わせ */
  readonly ready: Promise<void>;
  private settle!: () => void;

  constructor(body: Promise<CompiledGuest>) {
    this.body = body;
    this.ready = new Promise<void>((resolve) => (this.settle = resolve));
    // 失敗も「終わった」。spawn を待たせない（失敗の中身は spawn が body を見て知る）
    body.catch(() => this.settle());
  }

  /** ゲストの `sys:ready`（本体の文書の load） */
  markReady(): void {
    this.settle();
  }

  /** kill などで起動を捨てる。待っている spawn を解く */
  abandon(): void {
    this.settle();
  }
}
