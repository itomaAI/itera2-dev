/**
 * src/main.ts
 * Itera OS v2: Vite Entry Point
 */

import { SystemBootstrapper } from './shell/core/SystemBootstrapper';
import { renderBootFailure } from './shell/core/BootFailure';
import { LocalReset } from './core/sys/LocalReset';
import './style.css';

document.addEventListener('DOMContentLoaded', async () => {
  try {
    // OS のブートシーケンスを開始
    await SystemBootstrapper.boot();

    // 起動完了後、ローダーをフェードアウト
    const loader = document.getElementById('boot-loader');
    if (loader) {
      loader.classList.add('animate-fade-out');
      setTimeout(() => {
        loader.remove();
      }, 500);
    }
  } catch (e: any) {
    console.error('System Boot Failed:', e);
    const loader = document.getElementById('boot-loader');
    if (loader) {
      // Itera にはクラウドが無い。「再読み込み」で抜けられないときの出口は、修復か、全部消すか（T-0381）。
      // 画面に出る文は英語（Itera の決まり。コメントは日本語でよい）。
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
});
