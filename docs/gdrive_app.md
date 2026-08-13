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

---

## 接続先フォルダの選択

### 複数の端末で同じ VFS を共有する

**既定のままでは共有されない。** `google_drive_auth.js` の `ensureFolder()` は
`config.folderName || 'Itera OS'` という名前でフォルダを検索し、
見つからなければ**新規作成する**。したがって端末ごとに別々のフォルダができる。

共有するには、**すべての端末で同じフォルダを指す**必要がある。

| 方法 | 手順 |
|---|---|
| アプリから選ぶ | 「☁️ 接続先フォルダ」→「📂 Drive のフォルダを一覧」→「これに接続」 |
| `folderId` を直接指定 | 同セクションの入力欄に貼り付けて「適用」 |
| 設定ファイルを事前に置く | サインイン前に `system/config/gdrive.json` へ `folderName` を書く |

`mountPath` も揃えること。既定は `"drive"` だが、VFS ルート全体を同期している
環境と繋ぐ場合は `""`（空文字）にする必要がある。**両者が食い違うと、
同じフォルダを見ていても配置がずれる。**

### 接続先を変えたら同期状態を初期化する

`selectFolderById()` は切り替え前に必ずアンカーと索引を削除する。

アンカーは「前回の同期時点の状態」を表すため、別フォルダの状態を
今のフォルダの状態だと誤認させると、**Pull 分岐がローカルを削除しうる**。
索引には `rootFolderId` の照合があるが（`loadIndex()`）、**アンカーには無い**。
したがってアプリ側で捨てる。

初期化後の最初のサイクルはコールドスタート扱いになり、
リモートにあるものはスタブとして降り、ローカルにしかないものは
アップロードされる。**どちらも削除されない。**

### 一覧に出るフォルダの範囲

`drive.file` スコープでは「このアプリが作成したもの」しか見えない。
よって一覧に出るのは Itera が作ったフォルダだけで、利用者の Drive 全体は覗かない。
逆に、他の手段で作ったフォルダは選べない。

**一覧は必ず全ページ取得する。** 最上位の判定を
「親が取得済み集合に存在しない」で行うため、ページングを怠ると
**親が取得漏れしたフォルダが最上位に化ける**。実際に 1,400 件超の環境で、
同期ツリー内部の深いフォルダが 47 件も候補に並んだ。
20 ページを超えて確定できない場合は一覧を出さず、`folderId` の直接入力へ誘導する。

## 同期メタデータはローカルにのみ置く

| ファイル | 内容 |
|---|---|
| `system/temp/gdrive_anchor.json` | 3-way マージのアンカー |
| `system/temp/gdrive_index.json` | メタデータ索引のキャッシュ |
| `system/temp/gdrive_token.json` | OAuth トークン |

`system/temp` は `ALWAYS_EXCLUDED` なので Drive へは出ない。理由は 2 つ。

1. **含めると無限ループになる。** デーモン自身の書き込みが同期を再起動させる
2. **トークンを外部へ出さない**

`myaku-raku-v2`（Firebase 同期）とはここが構造的に異なる。
Firestore にはファイル一覧を引く手段が無いため `vfs_index/chunk_*` を
クラウドに置いて全端末で共有する必要があるが、**Drive は `files.list` 自体が
索引として機能する**ので、各端末が起動時に約 7 秒で作り直せる。

アンカーがローカル専用でも削除の伝播は成立する。
A で削除 → Drive 側が `trashed` → B では「ローカル無変化・リモート変化」と判定され、
`verifyRemoteAlive()` が `'gone'` を返して B のローカルも削除される。

## `driveFetch()` は DELETE を JSON として解析しない

Drive の `DELETE` は成功時に **HTTP 204 No Content**（本文が空）を返す。
`responseType: 'json'` で受けると `JSON.parse` が
`unexpected end of data` で例外を投げ、**成功が失敗として報告される**。

実際に空フォルダ 142 件の削除が全件「失敗」と表示されたが、
Drive 側では正しく消えていた。**成功を失敗と誤報するのは、
失敗を成功と誤報するのと同じくらい危険**（利用者が再実行や復旧を試みるため）。

対処として、`method` が `DELETE` のときは `responseType` を `'text'` にする。
デーモン側（`gdrive_sync.html`）にも同じ修正を入れてある。