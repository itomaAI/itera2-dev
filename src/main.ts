/**
 * src/main.ts
 * Itera OS v2: Vite Entry Point
 */

import { SystemBootstrapper } from './shell/core/SystemBootstrapper';
import { renderBootFailure } from './shell/core/BootFailure';
import { LocalReset } from './core/sys/LocalReset';
import { instanceGuard } from './core/sys/InstanceGuard';
import './style.css';
import { t } from './i18n/i18n';
import { startStaticTexts } from './i18n/staticTexts';

/**
 * 起動して、終わったらローダーを消す。落ちたら起動失敗画面（T-0381）。
 * 画面の文は UI の言語で出す（T-0545）。起動に落ちた時点では VFS が読めないので、前回の控え（localStorage）の言語になる。無ければ英語。
 */
async function runBoot(loader: HTMLElement | null): Promise<void> {
  try {
    await SystemBootstrapper.boot();
    if (loader) {
      loader.classList.add('animate-fade-out');
      setTimeout(() => {
        loader.remove();
      }, 500);
    }
  } catch (e: any) {
    console.error('System Boot Failed:', e);
    if (!loader) return;
    // Itera にはクラウドが無い。「再読み込み」で抜けられないときの出口は、修復か、全部消すか（T-0381）。
    renderBootFailure(loader, e, {
      title: t('boot.error.title'),
      hint: t('boot.error.hint'),
      failedText: (label, reason) => t('boot.action.failed', { label, reason }),
      actions: [
        { label: t('boot.action.reload'), run: () => window.location.reload() },
        {
          label: t('boot.action.repair'),
          description: t('boot.action.repairDescription'),
          run: () => {
            LocalReset.requestRepair();
            window.location.reload();
          },
        },
        {
          label: t('boot.action.factoryReset'),
          danger: true,
          description: t('boot.action.factoryResetDescription'),
          confirm: () =>
            window.confirm(t('boot.action.factoryResetConfirm')) && window.confirm(t('boot.action.factoryResetConfirmFinal')),
          run: () => {
            LocalReset.requestFactoryReset();
            window.location.reload();
          },
        },
      ],
    });
  }
}

/** 別のタブが動いているときの待機画面（T-0384）。 */
function renderWaiting(loader: HTMLElement, original: { className: string; html: string }): void {
  renderBootFailure(loader, t('boot.waiting.message'), {
    title: t('boot.waiting.title'),
    hint: t('boot.waiting.hint'),
    actions: [
      {
        label: t('boot.waiting.useThisTab'),
        description: t('boot.waiting.useThisTabDescription'),
        run: async () => {
          await instanceGuard.takeOver();
          // 鍵を持ったまま、その場で起動する（読み込み直すと鍵が一瞬離れて取り合いになる）
          loader.className = original.className;
          loader.innerHTML = original.html;
          await runBoot(loader);
        },
      },
      {
        label: t('boot.waiting.goToOther'),
        description: t('boot.waiting.goToOtherDescription'),
        run: () => instanceGuard.requestFocus(),
      },
    ],
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  // index.html の静的な文字を、前回の言語（控え）で当てる。以後は言語が切り替わるたびに当て直す（T-0545）
  startStaticTexts();
  const loader = document.getElementById('boot-loader');
  const original = loader ? { className: loader.className, html: loader.innerHTML } : null;

  // 同じブラウザで 2 つ目のタブなら起動しない（T-0384）。鍵を取れたタブだけが OS。
  if ((await instanceGuard.claim()) === 'held') {
    if (loader && original) renderWaiting(loader, original);
    return;
  }
  await runBoot(loader);
});
