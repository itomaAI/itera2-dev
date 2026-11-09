/**
 * src/shell/services/CloudSignInPrompt.ts
 * 起動時、クラウドに繋がっていなければ同期の画面（SyncModal）を開く（T-0778）。
 *
 * 動機: 認証の仕組みを作り変えるとセッションが途切れうる。そのとき利用者は気づかないまま
 * ローカルだけで作業し、同期が止まっていることに半日気づかない（2026-09-11 / T-0420 の形）。
 * 未ログインで起きたら最初から画面を出しておけば一目で分かる。
 *
 * 形:
 *   - 出す画面は既存の SyncModal。アダプタが自分の Sign In を描くので、ホストは開くだけ
 *   - `preferences.promptCloudSignIn` が true のときだけ。キーが無ければ出さない
 *     （itera2-dev は置かない＝出ない。itera2 は配布既定で true。同期を要らない人は画面のチェックで切る）
 *   - 🔴 開くのは「未ログインが確定した」あと。認証の復元は非同期で、起動直後は「まだ分からない」。
 *     アダプタは init で `connecting` を報告し、ここは全アダプタが `connecting` を抜けるのを待つ（上限あり）。
 *     待たずに開くと、ログイン済みの人にも毎回画面が出てすぐ閉じる
 *   - アダプタが 1 つも無ければ開かない（開いても何もできない）。1 つでも `connected` なら開かない
 */

import type { LoadedAdapter, SyncAdapterState, SyncAdapterStatus } from './SyncAdapterHost';

/** 「未ログインが確定した」と見なすまでの上限。復元は普通 1 秒以内に終わる */
export const SETTLE_TIMEOUT_MS = 5000;

/** 設定の値そのものを受ける。true のときだけ出す（未設定・不正は false） */
export function promptEnabled(pref: unknown): boolean {
  return pref === true;
}

/** 開くかどうか。純粋な判定 */
export function shouldPromptCloudSignIn(enabled: boolean, states: SyncAdapterState[]): boolean {
  if (!enabled) return false;
  if (states.length === 0) return false;
  return !states.includes('connected');
}

/** 待つ相手に要る口だけ（SyncAdapterHost の一部） */
export interface AdapterStatusSource {
  getAdapters(): LoadedAdapter[];
  onStatusChange(listener: (summary: SyncAdapterStatus, all: LoadedAdapter[]) => void): void;
}

/**
 * `connecting` のアダプタが無くなるまで待つ（上限 timeoutMs）。解決値はそのときのアダプタ一覧。
 * 上限に達したときはその時点の一覧（connecting を含みうる）を返す —— connecting は connected ではないので、
 * 判定の側では「繋がっていない」に数えられる
 */
export function waitForAdaptersSettled(
  source: AdapterStatusSource,
  timeoutMs: number = SETTLE_TIMEOUT_MS,
): Promise<LoadedAdapter[]> {
  const settled = (all: LoadedAdapter[]) => !all.some((a) => a.status.state === 'connecting');
  const now = source.getAdapters();
  if (settled(now)) return Promise.resolve(now);

  return new Promise((resolve) => {
    let done = false;
    const finish = (all: LoadedAdapter[]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(all);
    };
    const timer = setTimeout(() => finish(source.getAdapters()), timeoutMs);
    // onStatusChange に off は無い。done のあとは何もしない
    source.onStatusChange((_summary, all) => {
      if (settled(all)) finish(all);
    });
  });
}

export interface PromptCloudSignInOptions {
  /** `preferences.promptCloudSignIn` の値をそのまま返す */
  readPref: () => unknown;
  /** 画面を開く */
  open: () => void;
  /** 開いたときに呼ばれる（記録用） */
  onPrompt?: (states: SyncAdapterState[]) => void;
  timeoutMs?: number;
}

/**
 * 起動の最後に 1 回呼ぶ。SyncAdapterHost.loadAll() の後で、ホームの起動を止めずに（await しない）。
 * 戻り値は開いたかどうか（試験のため）
 */
export async function promptCloudSignInAtBoot(
  source: AdapterStatusSource,
  options: PromptCloudSignInOptions,
): Promise<boolean> {
  if (!promptEnabled(options.readPref())) return false;
  const all = await waitForAdaptersSettled(source, options.timeoutMs ?? SETTLE_TIMEOUT_MS);
  const states = all.map((a) => a.status.state);
  if (!shouldPromptCloudSignIn(true, states)) return false;
  options.open();
  options.onPrompt?.(states);
  return true;
}
