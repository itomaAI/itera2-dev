/**
 * src/main.ts
 * Itera OS v2: Vite Entry Point
 */

import { SystemBootstrapper } from './shell/core/SystemBootstrapper';
import { renderBootFailure } from './shell/core/BootFailure';
import { LocalReset } from './core/sys/LocalReset';
import { instanceGuard } from './core/sys/InstanceGuard';
import './style.css';

/** 起動して、終わったらローダーを消す。落ちたら起動失敗画面（T-0381）。画面に出る文は英語（Itera の決まり）。 */
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
      title: 'System Boot Error',
      hint: 'Try "Reload" first. If this screen keeps coming back, try "Repair and boot". Use the factory reset only as a last resort.',
      actions: [
        { label: 'Reload', run: () => window.location.reload() },
        {
          label: 'Repair and boot',
          description:
            'Fixes mismatches between metadata and file contents before booting. Nothing is deleted (rescued files go to .lost+found).',
          run: () => {
            LocalReset.requestRepair();
            window.location.reload();
          },
        },
        {
          label: 'Factory reset (erase all data)',
          danger: true,
          description:
            'Erases all Itera files and chat history on this device and boots from a clean state. This cannot be undone. Make sure you have a backup (ZIP export or a sync target) first.',
          confirm: () =>
            window.confirm(
              'This will erase all Itera files and chat history on this device. This cannot be undone.\n' +
                'If Itera is open in another tab, close it first.\n\nContinue?',
            ) && window.confirm('Really erase everything? (final confirmation)'),
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
  renderBootFailure(loader, 'Itera is already open in another tab of this browser. Only one tab can run at a time.', {
    title: 'Already open in another tab',
    hint: 'Continue in the other tab, or switch to this one.',
    actions: [
      {
        label: 'Use this tab',
        description: 'Stops the other tab and boots here. Anything already saved on this device carries over.',
        run: async () => {
          await instanceGuard.takeOver();
          // 鍵を持ったまま、その場で起動する（読み込み直すと鍵が一瞬離れて取り合いになる）
          loader.className = original.className;
          loader.innerHTML = original.html;
          await runBoot(loader);
        },
      },
      {
        label: 'Go to the other tab',
        description: 'Some browsers do not allow switching tabs automatically. If nothing happens, switch by hand.',
        run: () => instanceGuard.requestFocus(),
      },
    ],
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  const loader = document.getElementById('boot-loader');
  const original = loader ? { className: loader.className, html: loader.innerHTML } : null;

  // 同じブラウザで 2 つ目のタブなら起動しない（T-0384）。鍵を取れたタブだけが OS。
  if ((await instanceGuard.claim()) === 'held') {
    if (loader && original) renderWaiting(loader, original);
    return;
  }
  await runBoot(loader);
});
