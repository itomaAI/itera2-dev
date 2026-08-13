# Google Drive Sync Manager（`system/apps/gdrive_app.html`）

Google Drive 同期デーモン（`system/services/gdrive_sync.html`）を管理する設定アプリ。

## できること

| 機能 | 内容 |
|---|---|
| 状態表示 | デーモンの稼働・認証の有効性・マウント先・アンカー件数・索引件数と構築時刻 |
| デーモンの ON/OFF | トグルで `spawn` / `kill`。再起動ボタンで設定を再読込 |
| マウントパスの変更 | Drive フォルダを VFS のどこに割り当てるか。空欄で VFS ルート全体 |
| 追加の除外パス | 同期対象から外すパスを行区切りで指定 |
| 同期状態のリセット | アンカーと索引を削除（ファイルは消さない） |
| Drive 上の同期フォルダ削除 | Drive 側を恒久削除（ローカルは残す） |

## 設計上の要点

### 削除は「デーモン停止 → リモート削除 → ローカル状態の消去」の順に固定する

**順序を誤るとローカルのデータが失われる。**

同期デーモンが動いたままリモートを削除すると、次のサイクルで全ファイルが
「リモートで削除された」と見える。3-way マージの Pull 分岐はこれを削除と解釈し、
**ローカルの実体を恒久削除する**。

`verifyRemoteAlive()` の fail-closed 化（`'unknown'` では消さない）でも防げない。
フォルダを実際に消した後の応答は 404 であり、これは「不在が確定」＝ `'gone'` だからである。
安全網が正しく働いてなお危険なので、**アプリ側で順序を強制する**。

1. `stopDaemon()`。停止を `ps()` で確認できなければ**中断する**（fail-closed）
2. Drive 側を深さの降順に削除
3. アンカー・索引・`folderId` を消去

手順 3 で `folderId` を `null` に戻すのは、存在しないフォルダを指したまま
同期が再開されるのを防ぐため。削除後、デーモンは停止したままにする。

### Drive の削除は末端から行う

`drive.file` スコープでは、アプリが管理権限を持たない子要素が残っているフォルダの
削除が 403 で拒否される。`collectDescendants()` は `parents` を辿って深さを算出し、
**深い側から**削除する。

### 除外設定は「増やす」方向にしか効かない

`ALWAYS_EXCLUDED`（`system/credentials`, `system/temp`, `system/logs`, `trash`）と
`system/` 配下の allowlist（`system/config`, `system/registry`, `system/themes`）は
アプリから緩められない。認証情報の流出は取り返しがつかないため、
設定で穴を開けられない構造にしてある。

### 設定ファイルの所有権

`system/config/gdrive.json` は OAuth アダプタ（`system/adapters/google_drive_auth.js`）と
共有している。アダプタは `folderId` / `folderName` を書き、アプリは
`mountPath` / `excludePaths` を書く。**アプリは読み込んだ内容を土台に差分だけ上書きし、
他の項目を消さない**（`{ ...current, ... }`）。

## 既知の制約

**`system/registry/apps.json` への追加は、既存インストールへ届かない。**

`src/core/vfs/VfsInitializer.ts` は `system/config/` と `system/registry/` を
強制更新の対象から除外している（L106 / L129）。したがってランチャーへの登録は
**新規インストールでのみ有効**。既存環境では以下のいずれかが必要になる。

- 利用者が `system/registry/apps.json` に手で追記する
- マイグレーション処理を別途実装する

アプリ本体（`system/apps/*.html`）は強制更新の対象なので、ファイル自体は配信される。

## 関連

- 同期アルゴリズムの詳細: `docs/sync_adapters.md`
- デーモン本体: `vfs_root/system/services/gdrive_sync.html`
- OAuth アダプタ: `vfs_root/system/adapters/google_drive_auth.js`