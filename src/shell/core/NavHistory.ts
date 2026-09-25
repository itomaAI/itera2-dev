/**
 * src/shell/core/NavHistory.ts
 * Itera OS v2: アプリをまたぐ「戻る／進む」の履歴（T-0453）
 *
 * ブラウザのセッション履歴に倣った 3 層のうち、シェル側の「③記録」。
 *   ① 現在の場所（{ pid, uri }）は OS＝ProcessManager が持つ唯一の正（setCurrentRoute / 'current_route_changed'）
 *   ② アドレスバーはその表示
 *   ③ ここは ① の変化を購読して積み、戻る・進むは記録した URI を UriRouter.dispatch に渡すだけ
 *
 * 単位は「場所の変化 1 回」。前面切替（spawn / kill 後）も、同じアプリの中の申告（nav.declare）も同じ単位。
 * 死んだアプリの段も消さない（URI から起動し直せる）。段ごとの状態（スクロール・フォーム）は持たない（アプリの持ち物）。
 *
 * ブラウザの「戻る」との連動（任意）: 1 段ごとに window.history.pushState({ iteraNav: index })、popstate で同じ index へ跳ぶ。
 * ゲストの iframe は blob を 1 回読むだけで履歴に段を足さないので、popstate に来るのは自分が積んだものだけ。
 * 妙なら preferences の navBrowserSync: false で切る。
 */

export interface NavEntry {
  uri: string;
  pid: string;
  at: number;
}

export interface NavState {
  canBack: boolean;
  canForward: boolean;
  current: { uri: string; pid: string } | null;
  index: number;
  length: number;
}

/** window.history の必要な部分だけ（試験で差し替える） */
export interface BrowserHistoryLike {
  pushState(state: any, title: string): void;
  replaceState(state: any, title: string): void;
  go(delta: number): void;
}

export interface NavHistoryOptions {
  /** 記録した URI を開く（UriRouter.dispatch）。戻る・進むはこれを呼ぶだけ */
  navigate: (uri: string) => void | Promise<void>;
  /** 上限。古いほうから落とす */
  max?: number;
  /** ブラウザの履歴と連動するなら渡す（省略で連動しない） */
  browser?: BrowserHistoryLike | null;
  now?: () => number;
}

const STATE_KEY = 'iteraNav';

export class NavHistory {
  public entries: NavEntry[] = [];
  public index = -1;
  private navigating = false;
  private listeners: Array<(s: NavState) => void> = [];
  private readonly opts: Required<Pick<NavHistoryOptions, 'max' | 'now'>> & NavHistoryOptions;

  constructor(opts: NavHistoryOptions) {
    this.opts = { max: 100, now: () => Date.now(), browser: null, ...opts };
    if (this.opts.browser) {
      try {
        this.opts.browser.replaceState({ [STATE_KEY]: -1 }, '');
      } catch (e) {
        /* 連動できなくても本体は動く */
      }
    }
  }

  /** 戻り値を呼ぶと外れる */
  onChange(cb: (s: NavState) => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== cb);
    };
  }

  state(): NavState {
    const cur = this.index >= 0 && this.index < this.entries.length ? this.entries[this.index] : null;
    return {
      canBack: this.index > 0,
      canForward: this.index >= 0 && this.index < this.entries.length - 1,
      current: cur ? { uri: cur.uri, pid: cur.pid } : null,
      index: this.index,
      length: this.entries.length,
    };
  }

  /** ① が変わったら呼ぶ（'current_route_changed' の購読先）。戻る・進むで到達した変化は積まない */
  record(route: { pid: string; uri: string } | null): void {
    if (!route || !route.uri) return;
    if (this.navigating) return;
    const cur = this.index >= 0 ? this.entries[this.index] : null;
    if (cur && cur.uri === route.uri) {
      // 同じ URI に別の pid で来た（再起動）なら pid だけ更新する。段は増やさない
      if (cur.pid !== route.pid) this.entries[this.index] = { ...cur, pid: route.pid };
      return;
    }
    // index より後ろは捨てる（ブラウザと同じ）
    this.entries.splice(this.index + 1);
    this.entries.push({ uri: route.uri, pid: route.pid, at: this.opts.now() });
    while (this.entries.length > this.opts.max) this.entries.shift();
    this.index = this.entries.length - 1;
    if (this.opts.browser) {
      try {
        this.opts.browser.pushState({ [STATE_KEY]: this.index }, '');
      } catch (e) {
        /* 連動できなくても本体は動く */
      }
    }
    this.emit();
  }

  /** 指定の段へ跳ぶ。範囲外なら false。到達中の変化は積まない */
  async go(target: number): Promise<boolean> {
    if (target < 0 || target >= this.entries.length || target === this.index) return false;
    const entry = this.entries[target];
    this.index = target;
    this.navigating = true;
    try {
      await this.opts.navigate(entry.uri);
    } catch (e) {
      console.warn('[NavHistory] navigate failed: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      this.navigating = false;
    }
    this.emit();
    return true;
  }

  /** 戻る。ブラウザと連動しているときは、ブラウザの履歴を動かし popstate 側で go する（経路を 1 本にする） */
  async back(): Promise<boolean> {
    if (!this.state().canBack) return false;
    if (this.opts.browser) {
      this.opts.browser.go(-1);
      return true;
    }
    return this.go(this.index - 1);
  }

  async forward(): Promise<boolean> {
    if (!this.state().canForward) return false;
    if (this.opts.browser) {
      this.opts.browser.go(1);
      return true;
    }
    return this.go(this.index + 1);
  }

  /**
   * popstate の受け口。自分が積んだ state（iteraNav）だけを見る。
   * state が無い・知らない値なら何もしない（Firebase Auth のリダイレクトなど、外から来た履歴の動きを無視する）
   */
  async onPopState(state: any): Promise<boolean> {
    if (!state || typeof state !== 'object' || typeof state[STATE_KEY] !== 'number') return false;
    const target = state[STATE_KEY];
    if (target < 0) return false;
    return this.go(target);
  }

  private emit(): void {
    const s = this.state();
    for (const cb of this.listeners) {
      try {
        cb(s);
      } catch (e) {
        /* 購読側の失敗で本体を止めない */
      }
    }
  }
}
