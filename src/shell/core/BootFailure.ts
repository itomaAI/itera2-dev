/**
 * src/shell/core/BootFailure.ts
 * 起動に失敗したときの画面（T-0380 / T-0381）。
 *
 * 起動が途中で落ちると、この時点では DialogService も VFS も無い。素の DOM で出す。
 * 「再読み込み」だけでは抜けられない状態（この端末の実体が壊れている・別タブと競合している）に
 * 出口を置くため、呼び出し側が行動を差し込める形にしてある。ミャク楽と Itera で行動の中身が違う
 * （クラウドから取り直す／工場出荷状態に戻す）ので、文言と処理はここに持たない。
 * この部品は両方で同じ中身にしてある（横流しできるように）。
 */

export interface BootFailureAction {
  label: string;
  /** ボタンの下に出す 1 行の説明。 */
  description?: string;
  /** 危険な行動（赤いボタン）。 */
  danger?: boolean;
  /**
   * 押したときの確認。文なら window.confirm で出す。関数なら true を返したときだけ実行する
   * （2 段の確認など）。キャンセルなら何もしない。
   */
  confirm?: string | (() => boolean);
  run: () => void | Promise<void>;
}

export interface BootFailureView {
  title: string;
  /** エラー文の下に出す案内。 */
  hint: string;
  actions: BootFailureAction[];
  /** 行動が失敗したときに本文へ足す文。既定は英語（Itera）。ミャク楽は日本語を差し込む。 */
  failedText?: (label: string, reason: string) => string;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || String(error);
  return String(error);
}

function confirmed(action: BootFailureAction): boolean {
  if (!action.confirm) return true;
  if (typeof action.confirm === 'function') return action.confirm();
  return window.confirm(action.confirm);
}

export function renderBootFailure(loader: HTMLElement, error: unknown, view: BootFailureView): void {
  const failedText = view.failedText ?? ((label: string, reason: string) => `[${label}] failed: ${reason}`);
  loader.classList.remove('flex-col', 'items-center', 'justify-center');
  loader.classList.add('p-8', 'overflow-auto');
  loader.replaceChildren();

  const title = document.createElement('div');
  title.className = 'text-error font-bold mb-4 text-xl';
  title.textContent = view.title;

  // エラー文は textContent で置く（innerHTML に差し込むと文の中の < > がそのまま HTML になる）
  const message = document.createElement('div');
  message.className =
    'text-sm text-text-main font-mono bg-card border border-border-main p-4 rounded shadow-inner whitespace-pre-wrap';
  message.textContent = errorText(error);

  const hint = document.createElement('div');
  hint.className = 'text-sm text-text-muted mt-4';
  hint.textContent = view.hint;

  const actions = document.createElement('div');
  actions.className = 'mt-6 flex flex-col gap-4 max-w-xl';

  for (const action of view.actions) {
    const wrap = document.createElement('div');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    button.className = action.danger
      ? 'px-6 py-2 bg-error hover:bg-error/80 rounded text-sm text-white font-bold transition'
      : 'px-6 py-2 bg-primary hover:bg-primary/80 rounded text-sm text-white font-bold transition';
    button.addEventListener('click', async () => {
      if (!confirmed(action)) return;
      button.disabled = true;
      try {
        await action.run();
      } catch (e) {
        button.disabled = false;
        message.textContent = `${errorText(error)}\n\n${failedText(action.label, errorText(e))}`;
      }
    });
    wrap.appendChild(button);
    if (action.description) {
      const desc = document.createElement('div');
      desc.className = 'text-xs text-text-muted mt-1';
      desc.textContent = action.description;
      wrap.appendChild(desc);
    }
    actions.appendChild(wrap);
  }

  loader.append(title, message, hint, actions);
}
