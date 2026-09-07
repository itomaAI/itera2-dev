/**
 * src/core/sys/InstanceGuard.ts
 * 同じオリジンで OS を 1 つしか動かさない（T-0384）。
 *
 * ■ なぜ
 * タブごとにメタデータをメモリに読み込み（NodeStore.loadAll は起動時 1 回）、それぞれが同期デーモン・
 * スケジューラ・AI を持つ。同じ IndexedDB / OPFS の上に独立した VFS が 2 つ乗る形で、後勝ち・二重 push が
 * 起きる。状態を共有する改修（SharedWorker）は大きいので、ここでは排他だけにする。
 *
 * ■ 仕組み
 * - 鍵 = Web Locks の 'itera-instance'。取れたタブが OS。コールバックを終わらせないことで持ち続け、
 *   タブが閉じる・落ちるとブラウザが返す（後始末は要らない）
 * - 取れなかったタブは起動しない。待機画面は main.ts が出す
 * - 引き継ぎ = BroadcastChannel。待機中のタブが「このタブで使う」で持ち主に頼み、持ち主は止めて（登録された
 *   halt = 全プロセス停止）覆いを出して鍵を返す。持ち主が返事をしなければ N 秒で奪う（steal）。奪われた側は
 *   request が AbortError で終わるので、そこで自分を止める（固まったタブが裏で同期を続ける穴を塞ぐ）
 * - 引き継ぎで同期を流し直す必要は無い。2 つのタブは同じ端末の同じ IndexedDB / OPFS を見ているので、
 *   新しいタブが起動すれば手元の変更はそのまま引き継がれる
 * - 手放した側は鍵を返したあと読み込み直す。ゲストのプロセスを止めるだけではホスト側（AI の一巡・保守の
 *   タイマー）が残るので、ページごと作り直して「待機中のタブ」になる。受け取った側はその場で起動する
 *   （読み込み直すと鍵が一瞬離れ、作り直し中の旧タブと取り合いになる）
 * - Web Locks が無いブラウザでは何もしない（従来どおり）
 *
 * この部品は Itera とミャク楽で同じ中身。文言は呼び出し側が差し込む。
 */

const LOCK_NAME = 'itera-instance';
const CHANNEL_NAME = 'itera-instance';

type Halt = () => void | Promise<void>;
export type ClaimResult = 'acquired' | 'held' | 'unsupported';
export type TakeOverResult = 'handed' | 'stolen';

/** navigator.locks の使う範囲だけ。試験で偽物に差し替える。 */
export interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal },
    callback: (lock: unknown) => unknown,
  ): Promise<unknown>;
}

/** BroadcastChannel の使う範囲だけ。 */
export interface ChannelLike {
  postMessage(message: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  close(): void;
}

export interface InstanceGuardDeps {
  locks?: LockManagerLike | null;
  openChannel?: () => ChannelLike | null;
  /** 手放したあとの読み込み直し。試験で差し替える。 */
  reload?: () => void;
  reloadDelayMs?: number;
}

function isAbortError(e: unknown): boolean {
  return (e as { name?: unknown } | null | undefined)?.name === 'AbortError';
}

function defaultLocks(): LockManagerLike | null {
  return (typeof navigator !== 'undefined' && (navigator as { locks?: LockManagerLike }).locks) || null;
}

function defaultChannel(): ChannelLike | null {
  return typeof BroadcastChannel === 'undefined'
    ? null
    : (new BroadcastChannel(CHANNEL_NAME) as unknown as ChannelLike);
}

export class InstanceGuard {
  private readonly locks: LockManagerLike | null;
  private readonly openChannel: () => ChannelLike | null;
  private readonly reload: () => void;
  private readonly reloadDelayMs: number;
  private halts: Halt[] = [];
  private release: (() => void) | null = null;
  private channel: ChannelLike | null = null;
  private holding = false;

  /** 鍵を手放したときに画面を覆う文。既定は英語（Itera）。ミャク楽は起動時に日本語を入れる。 */
  overlayText: { title: string; body: string } = {
    title: 'Moved to another tab',
    body: 'Itera is now running in another tab. You can close this one.',
  };

  constructor(deps: InstanceGuardDeps = {}) {
    this.locks = deps.locks === undefined ? defaultLocks() : deps.locks;
    this.openChannel = deps.openChannel ?? defaultChannel;
    this.reload = deps.reload ?? (() => window.location.reload());
    this.reloadDelayMs = deps.reloadDelayMs ?? 800;
  }

  /** 鍵を手放す前に走らせるもの（全プロセスの停止など）。登録順に待つ。 */
  onHandover(halt: Halt): void {
    this.halts.push(halt);
  }

  isHolding(): boolean {
    return this.holding;
  }

  /**
   * 起動の最初に呼ぶ。'acquired' なら起動を続ける。'held' なら起動せず待機画面を出す。
   */
  async claim(): Promise<ClaimResult> {
    const locks = this.locks;
    if (!locks) {
      console.info('[InstanceGuard] unsupported (no Web Locks). Running without the single-instance guard.');
      return 'unsupported';
    }
    return new Promise<ClaimResult>((resolve) => {
      locks
        .request(LOCK_NAME, { ifAvailable: true }, (lock) => {
          if (!lock) {
            console.info('[InstanceGuard] held by another tab. Not booting.');
            resolve('held');
            return;
          }
          this.startHolding();
          console.info('[InstanceGuard] acquired. This tab is the instance.');
          resolve('acquired');
          return this.holdUntilReleased();
        })
        .catch((e) => this.onRequestRejected(e));
    });
  }

  /**
   * 待機中のタブが呼ぶ。持ち主に引き継ぎを頼み、鍵が回ってくるのを待つ。
   * timeoutMs 待っても回ってこなければ奪う。取れたら resolve（呼び出し側が読み込み直して普通に起動する）。
   */
  async takeOver(timeoutMs = 8000): Promise<TakeOverResult> {
    const locks = this.locks;
    if (!locks) return 'handed';
    const channel = this.openChannel();
    channel?.postMessage({ type: 'handover' });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await this.acquire(locks, { signal: controller.signal });
      return 'handed';
    } catch (e) {
      if (!isAbortError(e)) throw e;
      await this.acquire(locks, { steal: true });
      return 'stolen';
    } finally {
      clearTimeout(timer);
      channel?.close();
    }
  }

  /** 待機中のタブから「そちらへ移動」。ブラウザが他タブの focus を許すとは限らない。 */
  requestFocus(): void {
    const channel = this.openChannel();
    if (!channel) return;
    channel.postMessage({ type: 'focus' });
    setTimeout(() => channel.close(), 100);
  }

  /**
   * 持ち主が鍵を手放す。halts → 覆い → release → 読み込み直し（待機中のタブになる）。2 度は動かない。
   * reason: 'handover' = 頼まれて渡した ／ 'stolen' = 奪われた（request が AbortError で終わった）
   */
  async handOver(reason: 'handover' | 'stolen'): Promise<void> {
    if (!this.holding) return;
    this.holding = false;
    console.warn(`[InstanceGuard] Giving up the instance lock (${reason}).`);
    for (const halt of this.halts) {
      try {
        await halt();
      } catch (e) {
        console.warn('[InstanceGuard] A halt handler failed. Continuing.', e);
      }
    }
    this.showOverlay();
    const release = this.release;
    this.release = null;
    if (release) release();
    this.channel?.close();
    this.channel = null;
    setTimeout(() => this.reload(), this.reloadDelayMs);
  }

  // ---- 内部 ----

  private acquire(locks: LockManagerLike, options: { steal?: boolean; signal?: AbortSignal }): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      locks
        .request(LOCK_NAME, options, (lock) => {
          if (!lock) {
            reject(new Error('Instance lock was not granted.'));
            return;
          }
          this.startHolding();
          resolve();
          return this.holdUntilReleased();
        })
        .catch((e) => {
          // 待っている間の失敗（signal の abort）は呼び出し側へ。持ってからの失敗（奪われた）は手放す
          if (this.holding) this.onRequestRejected(e);
          else reject(e);
        });
    });
  }

  private holdUntilReleased(): Promise<void> {
    return new Promise<void>((release) => {
      this.release = release;
    });
  }

  private startHolding(): void {
    this.holding = true;
    this.channel = this.openChannel();
    if (this.channel) {
      this.channel.onmessage = (ev) => {
        const type = (ev?.data as { type?: unknown } | null)?.type;
        if (type === 'handover') void this.handOver('handover');
        else if (type === 'focus') {
          try {
            window.focus();
          } catch {
            /* noop */
          }
        }
      };
    }
  }

  private onRequestRejected(e: unknown): void {
    if (this.holding) void this.handOver('stolen');
    else console.warn('[InstanceGuard] Lock request failed:', e);
  }

  private showOverlay(): void {
    if (typeof document === 'undefined' || !document.body) return;
    const el = document.createElement('div');
    el.className =
      'instance-handover-overlay fixed inset-0 z-[10000] bg-app flex flex-col items-center justify-center p-8 text-center';
    const title = document.createElement('div');
    title.className = 'text-lg font-bold mb-2';
    title.textContent = this.overlayText.title;
    const desc = document.createElement('div');
    desc.className = 'text-sm text-text-muted';
    desc.textContent = this.overlayText.body;
    el.append(title, desc);
    document.body.appendChild(el);
  }
}

/** アプリが使う 1 つ。main.ts が claim し、SystemBootstrapper が halt と文言を付ける。 */
export const instanceGuard = new InstanceGuard();
