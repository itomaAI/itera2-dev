# アプリをまたぐ「戻る／進む」（T-0453）

ブラウザのセッション履歴に倣った 3 層。

| 層 | 持ち主 | 実体 |
| :-- | :-- | :-- |
| ① 現在の場所 `{ pid, uri }` | OS（`ProcessManager.currentRoute`） | **`setCurrentRoute`** が唯一の口。呼ぶのは `spawn`（新規・resume の `show`）・`kill` 後の切替・ゲストの申告（`declareRoute`）。変わったら `'current_route_changed'` |
| ② アドレスバー | シェル（表示） | `ProcessManager._updateAddressBar` は表示だけ。`EventOrchestrator._restoreAddressBar` も表示を戻すだけ（場所は変えない） |
| ③ 履歴 | シェル（`src/shell/core/NavHistory.ts`） | `'current_route_changed'` を購読して積む。戻る・進むは記録した URI を **`UriRouter.dispatch`** に渡すだけ（生きていれば `route_changed`、死んでいれば起動し直す） |

- **単位は「場所の変化 1 回」**。前面切替も、同じアプリの中の申告も同じ単位。同じ URI は積まない（pid だけ更新）。`index` より後ろは捨てる。上限 100
- **死んだアプリの段も消さない**（URI から起動し直せる）。段ごとの状態（スクロール・フォーム）は持たない（アプリの持ち物）
- **ゲスト API `MetaOS.nav`**: `declare(pathOrQuery)`（申告。`?…` は base に付け足す）／`back()`／`forward()`／`state()`。活性は `system.on('nav_changed')`。**`MetaOS.host.updateAddressBar` は非推奨**（同じ handler。残す）
- **ホスト UI**: アドレスバー左の ← →（`#btn-nav-back` / `#btn-nav-forward`。`DesktopEnvironment.bindNavHistory`）
- **ブラウザ連動**: 段ごとに `window.history.pushState({ iteraNav: index })`。`back()` / `forward()` は `history.go(±1)` に委ね、`popstate` で同じ index へ跳ぶ（経路を 1 本にする）。自分の state（`iteraNav`）以外の `popstate` は無視。**`preferences.navBrowserSync: false` で切れる**（既定 true）。ゲストの iframe は blob を 1 回読むだけで履歴に段を足さないので、これで足りる
- 履歴はセッション内だけ（リロードで空。`replaceState({ iteraNav: -1 })` から始める）
- `show: false` の起動は場所を変えないので積まれない。ゲストの `spawn(path, { args })` の `args` は URI に出ない（その段は `metaos://run/<path>` だけ。戻ると引数無しで開く）

試験: `src/shell/core/NavHistory.test.ts`。
