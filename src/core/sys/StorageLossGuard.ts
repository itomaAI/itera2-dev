/**
 * src/core/sys/StorageLossGuard.ts
 * 動作中にブラウザのデータ（IndexedDB / OPFS）が消されたことに気づき、古い在庫のまま走り続けない（T-0382）。
 *
 * ■ 何が起きるか
 * タブを開いたまま「閲覧データの削除」や DevTools の Clear site data をすると、動いているタブは
 * メモリ上のメタデータ（NodeStore）と OPFS のルートハンドルを握ったまま走り続ける。書き込みは
 * InvalidStateError で落ち、同期デーモンは古い在庫を正として動く。利用者には「保存できない」
 * 「リロードしても直らない」に見える（2026-09-07 WB の利用者の起動エラー）。
 *
 * ■ どう気づくか
 * IndexedDB の接続は、外から消されると `close` が、別の接続が消そうとすると `versionchange` が届く。
 * NodeStore / HistoryManager がそれを受けてここを呼ぶ。
 *
 * ■ どうするか
 * 1 度だけ: 止める（デーモンを含む全プロセス）→ 画面を覆う → 読み込み直す。
 * 消去後の起動は同期の「アンカーが空 → クラウドを採る」に乗るので、ファイルはクラウドから戻る。
 * 起動後に 1 度だけ「消去があったので読み込み直した」と伝える（黙って戻すと障害に見える）。
 */

const NOTICE_KEY = 'itera_storage_loss_notice';

type Halt = () => void | Promise<void>;

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* localStorage ごと消えているなら通知は諦める */
  }
}

function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* noop */
  }
}

export class StorageLossGuard {
  private static tripped = false;
  private static halts: Halt[] = [];

  /** 試験用に差し替えられる。 */
  static reload: () => void = () => window.location.reload();
  static reloadDelayMs = 1500;

  /** 画面を覆うときの文。既定は英語（Itera）。ミャク楽は起動時に日本語を入れる。 */
  static overlayText: { title: string; body: string } = {
    title: 'Browser storage was cleared',
    body: 'The data stored on this device was removed while Itera was running. Stopping and reloading.',
  };

  /** 検知したときに読み込み直す前に走らせるもの（プロセスの停止など）。登録順に待つ。 */
  static onTrip(halt: Halt): void {
    this.halts.push(halt);
  }

  static isTripped(): boolean {
    return this.tripped;
  }

  /**
   * 検知の入口。何度呼ばれても 1 度しか動かない（DB が 2 つあり、両方から届く）。
   */
  static async trip(reason: string): Promise<void> {
    if (this.tripped) return;
    this.tripped = true;
    console.error('[StorageLossGuard] Local storage was removed underneath a running session:', reason);
    safeSet(NOTICE_KEY, reason);

    for (const halt of this.halts) {
      try {
        await halt();
      } catch (e) {
        console.warn('[StorageLossGuard] A halt handler failed. Continuing.', e);
      }
    }

    this.showOverlay();
    setTimeout(() => this.reload(), this.reloadDelayMs);
  }

  /** 起動後の通知を 1 度だけ取り出す。 */
  static consumeNotice(): string | null {
    const raw = safeGet(NOTICE_KEY);
    if (!raw) return null;
    safeRemove(NOTICE_KEY);
    return raw;
  }

  private static showOverlay(): void {
    if (typeof document === 'undefined' || !document.body) return;
    const el = document.createElement('div');
    el.id = 'storage-loss-overlay';
    el.className = 'fixed inset-0 z-[10000] bg-app flex flex-col items-center justify-center p-8 text-center';
    const title = document.createElement('div');
    title.className = 'text-lg font-bold mb-2';
    title.textContent = this.overlayText.title;
    const desc = document.createElement('div');
    desc.className = 'text-sm text-text-muted';
    desc.textContent = this.overlayText.body;
    el.append(title, desc);
    document.body.appendChild(el);
  }

  /** 試験用。 */
  static _resetForTest(): void {
    this.tripped = false;
    this.halts = [];
    this.reload = () => window.location.reload();
    this.reloadDelayMs = 1500;
    this.overlayText = {
      title: 'Browser storage was cleared',
      body: 'The data stored on this device was removed while Itera was running. Stopping and reloading.',
    };
    document.getElementById('storage-loss-overlay')?.remove();
  }
}
