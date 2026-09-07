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
      renderBootFailure(loader, e, {
        title: '起動に失敗しました',
        hint: 'まず「再読み込み」を試してください。同じ画面が続くときは「修復して起動」を。それでも起動しないときだけ、最後の手段として工場出荷状態に戻せます。',
        actions: [
          { label: '再読み込み', run: () => window.location.reload() },
          {
            label: '修復して起動',
            description:
              'メタデータと実体の食い違いを直してから起動します。データは消しません（拾ったものは .lost+found に入ります）。',
            run: () => {
              LocalReset.requestRepair();
              window.location.reload();
            },
          },
          {
            label: '工場出荷状態に戻す（全データ消去）',
            danger: true,
            description:
              'この端末の Itera のファイル・会話履歴をすべて消して、初期状態で起動します。戻せません。控え（ZIP エクスポートや同期先）があるか先に確かめてください。',
            confirm: () =>
              window.confirm(
                'この端末の Itera のファイルと会話履歴をすべて消します。戻せません。\n' +
                  '他のタブで Itera を開いていれば、先に閉じてください。\n\n続けますか？',
              ) && window.confirm('本当に消しますか？（最後の確認）'),
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
