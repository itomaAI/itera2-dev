# Sync Adapter 機構

VFS 上の JavaScript ファイルとして「クラウド同期プロバイダの認証 UI とロジック」を
差し替え可能にする仕組み。ホスト（ビルド成果物）にはプロバイダ固有のコードが一切入らない。

itera-saas で使われていたアダプタパターンを itera2-dev に移植し、
複数アダプタの同居・障害分離・設定の読み取りに対応させたもの。

## 構成

```
src/shell/services/SyncAdapterHost.ts   アダプタの読み込みと状態集約
src/shell/modals/SyncModal.ts           モーダル UI（プロバイダ非依存）
index.html                              ストレージパネルの雲アイコン (#btn-cloud-sync)

vfs_root/system/registry/adapters.json  アダプタの登録簿
vfs_root/system/adapters/*.js           アダプタ本体（ES module）
```

## 起動フロー

```
SystemBootstrapper
  ├─ new SyncAdapterHost(vfs, configManager, processManager)   ← 生成のみ
  ├─ new DesktopEnvironment(..., syncAdapterHost)
  │    └─ new SyncModal(adapterHost)
  │         └─ adapterHost.setContainerFactory(...)   ← 描画スロットの供給を登録
  └─ await syncAdapterHost.loadAll()                  ← 最後に読み込む
       ├─ system/registry/adapters.json を読む
       ├─ 各 .js を Blob URL 化して動的 import()
       └─ mod.init(ctx) を呼ぶ
```

**`loadAll()` を起動シーケンスの最後に置いているのは、
描画スロットの供給元である SyncModal の構築後でなければならないため。**

## アダプタの契約 (API v1)

アダプタは ES module であり、`init(ctx)` をエクスポートする。

```js
export async function init(ctx) { /* ... */ }
```

`ctx` の内容:

| キー | 内容 |
|---|---|
| `apiVersion` | 契約のバージョン（現在 1）。破壊的変更時に上がる |
| `manifest` | レジストリの該当エントリ |
| `vfs` | VfsService。`readFile(principal, path)` / `writeFile(principal, path, content, opts)` |
| `configManager` | ConfigManager |
| `processManager` | ProcessManager（同期デーモンの起動などに使う） |
| `ui.container` | **このアダプタ専用**の DOM スロット。他アダプタと干渉しない |
| `ui.setStatus(status)` | 接続状態の報告 |
| `log(msg, level)` | プレフィックス付きログ |

`setStatus` に渡す `status`:

```ts
{
  state: 'disconnected' | 'connecting' | 'connected' | 'error',
  label?: string,        // 例: 'Cloud Sync Active'
  detail?: string,       // 例: サインイン中のメールアドレス
  accentClass?: string,  // 例: 'text-[#4285F4]'
}
```

## 状態の集約

複数アダプタの状態は 1 つに畳まれてモーダルとサイドバーのアイコンに反映される。

優先順位: `connected` > `connecting` > `error` > `disconnected`
（「1 つでも繋がっていれば繋がっている」と表示する）

## 障害分離

アダプタは 1 つずつ独立して初期化され、例外は個別に捕捉される。
1 つが壊れても他のアダプタと OS 起動は継続する。
失敗したアダプタは `state: 'error'` としてモーダルに残るため、
黙って消えることはない。

> itera-saas 版は全体が 1 つの `try` で囲まれており、
> 1 つ壊れると全アダプタが読み込まれなかった。

## ⚠ セキュリティ

**アダプタはホスト window 内で実行され、iframe サンドボックスの外側にある。**
すなわちアダプタのコードはホストと同等の権限を持つ。

これは意図的な設計判断である（認証ポップアップの opener 連携と、
起動時からの常駐が必要なため）。ただし帰結として:

> **`system/adapters/` への書き込み権限 ≒ ホストの任意コード実行権限**

`VfsInitializer` は `system/` を read-only とし、書き込みを許すのは
`config` / `themes` / `registry` / `temp` / `upstream` に限っている。
**`system/adapters` を `rwPaths` に追加してはならない。**

より弱い権限で十分なアダプタは、ゲストアプリ（`apps/*.html`）として
実装し、アダプタからは spawn するだけにするほうが安全。

## 新しいアダプタを足す

1. `vfs_root/system/adapters/<name>.js` を作り `init(ctx)` をエクスポート
2. `vfs_root/system/registry/adapters.json` にエントリを追加
3. `npm run dev` / `npm run build`（`build_defaults.js` が `vfs_root/` を自動で取り込む）

### 既存インストールへの反映について

- `system/adapters/*.js` は**強制更新の対象**なので、起動時に最新へ更新される
- `system/registry/adapters.json` は**config 領域**であり、
  **一度作成されると以降は更新されない**（ユーザーの編集を尊重するため）。
  既存インストールに新しいアダプタを配る場合は、マイグレーション処理が別途必要。

---

# 同期デーモンのアンカーと再開可能性

`system/services/gdrive_sync.html` の話。アダプタ機構そのものとは別レイヤだが、
同期の正しさに直結するためここに残す。

## アンカーとは

3-way マージの「前回同期時点の状態」を保持するファイル（`system/temp/gdrive_anchor.json`）。
エントリは `{ id, kind, hash, rhash }`。

**`hash` は VFS が計算した値、`rhash` は Google が計算した `md5Checksum`。
この 2 つを互いに比較してはならない。** それぞれ自分の系でのみ比較する。

```
localChanged  = A.hash  !== L.hash
remoteChanged = A.rhash !== R.md5
```

異種のハッシュ空間を直接比較すると、全ファイルが恒久的に「差分あり」となり、
延々とアップロードし続ける。

## なぜ途中保存が要るか

初回同期は数千ファイル・数時間に及ぶ。一方、ブラウザのみの OAuth は
**1 時間で失効し、リフレッシュトークンが無い**。よって初回同期は
ほぼ確実に走行中にトークンが切れる。

以前はアンカーをループ完了後に一度保存するだけだった。この形には次の破綻がある。

1. トークン失効で `reconcile()` が中断 → **`saveAnchor()` に到達せず、アンカーは空のまま**
2. 一方 Drive 側にはアップロード済みのファイルが存在する
3. 再認証後の次サイクルは `isAnchorEmpty === true` でコールドスタート分岐に入る
4. コールドスタートは**リモートを正とする**ため、
   **アップロード済みのローカル実体がスタブに変換される**
5. そのサイクルも完走できないため 1 に戻る

結果として、繰り返すたびにローカルが空洞化していく。
バイト列は Drive にあるのでデータ消失ではないが、
571 MB を再ダウンロードする羽目になる。

## 現在の実装

| 対策 | 場所 |
|---|---|
| `ANCHOR_FLUSH_MS`（10 秒）ごとにアンカーを保存 | `breathe()` |
| 中断時、再スロー前にアンカーを保存 | 内側 `catch` の `TOKEN_EXPIRED` / `NOT_AUTHENTICATED` 分岐 |
| 401 でトークンを読み直して 1 回だけ再試行 | `driveFetch()` |

**成立の根拠**: `newAnchor` の各エントリは、対応する操作が成功した**後**にのみ書かれる。
したがって途中まで保存されたアンカーは常に「正しい部分集合」であり、
早めに永続化しても不整合は生じない。失われるのは最大でも 10 秒分。

中断後のサイクルでは `isAnchorEmpty === false` となるためコールドスタート分岐に入らない。
リモートにのみ在るファイルは通常の Pull 分岐で `createStub` され、結果は同じになる。
すなわち**アップロード方向・ダウンロード方向のどちらでも再開が成立する**。

## 途中保存がエコーループを起こさない理由

アンカーは `system/temp/` に書かれる。ルートマウント（`mountPath: ""`）では
**この保存先自身がマウント配下に入る**ため、素朴には
「保存 → 自分の `onMutate` が発火 → 再同期 → 保存」が無限に回りうる。

これは OS 側で止まっている。`ProviderManager._bindEventBus()` のエコーキャンセルが
**`mutation.sourcePrincipal.id === info.pid` の一致のみ**で判定しており、
`type` を条件に含めていないため、`systemPrivilege: true` のデーモン
（Principal が `{ type: 'system' }` になる）でも自分の書き込みは自分に届かない。

> `saveAnchor` が渡している `{ silent: true }` は **AI のイベントログ出力を抑止するだけ**で、
> Mutation の発行自体は止めない。ここを混同しないこと。

回帰は `src/core/vfs/ProviderManager.test.ts` が押さえている。

## ルートマウント時の除外

`system/` 配下は **allowlist**（`config` / `registry` / `themes` のみ同期）。
denylist にすると、将来 `system/` にディレクトリが増えたとき黙って同期される。

`system/credentials` / `system/temp` / `system/logs` / `trash` は常に除外。
他プロバイダの管轄は `listMounts()` から導出し、**取得に失敗したらサイクルごと中断する**
（fail-open にすると他人の領域を巻き込む）。

## リモート状態の取得（索引方式）

### 以前の実装とその問題

初期実装は Drive の物理階層を BFS で走査していた。フォルダごとに
`'<id>' in parents` を投げるため、**ディレクトリ数と同じ回数の通信**が要る。

この方式には 2 つの問題があった。

1. **新環境でスタブが即座に生成されない。**
   本 VFS の 1,468 ディレクトリでは走査完了まで 1,400 回以上のラウンドトリップが必要で、
   終わるまで**スタブが 1 つも作られない**。
   `firebase_sync.html` は `loadBaselineIndex()` がチャンクを `Promise.all` で
   一括取得するため 1〜2 秒で全スタブが揃う。この性質が移植されていなかった。

2. **走査が毎サイクル繰り返される。**
   より重大なのはこちら。`fetchRemoteState()` は `reconcile()` から呼ばれており、
   キャッシュも差分機構も無かった。`POLL_INTERVAL_MS = 20000` のため、
   同期完了後・無変更の定常状態でも**20 秒ごとに 1,400 回の通信を永久に続ける**。
   `firebase_sync.html` の定常状態の通信は 0（`R = remoteCache`）である。

### 現在の実装

Firestore の「ベースライン + WAL」を Drive API の 2 機能で再現する。

| `firebase_sync` | `gdrive_sync` | コスト |
|---|---|---|
| `vfs_index/chunk_*` の並列ロード | `files.list` のフラット検索（`q="trashed=false"`, `pageSize=1000`） | 3,230 件で 8 通信 / 7.2 秒（実測） |
| `onSnapshot(vfs_nodes)` | `changes.list`（カーソル方式） | 1 通信 / ポーリング |
| — | 索引を `system/temp/gdrive_index.json` へ永続化 | 再起動後も走査不要 |

`getRemoteState()` の分岐:

1. 索引が無い → ディスクから復元、無ければ `buildIndexFlat()`
2. 索引が古い（`INDEX_MAX_AGE_MS` = 24h）→ `buildIndexFlat()`
3. それ以外 → `applyChanges()` で差分のみ適用
4. `changes.list` が使えない環境 → `buildIndexFlat()` へ退避（それでも 10 通信弱）

### 索引は fileId を主キーにする

**Drive はパスを持たない。** パスは `parents` を辿って構成する派生情報にすぎない。
索引にパスを保存すると、**フォルダを 1 つ改名しただけで配下すべてのエントリが
古いパスのまま残る**。

そこで索引は `{ fileId: { name, parents, kind, md5, size, modifiedTime } }` とし、
パスは `derivePathMap()` が毎サイクル導出する。導出は `rootFolderId` からの
到達可能性で範囲を限定するため、次の性質が副産物として得られる。

- **圏外のファイルは自動的に除外される**（`drive.file` スコープで他アプリの
  ファイルが混ざっても、親チェーンがルートに届かないため捨てられる）
- **ゴミ箱に入ったフォルダの子も自動的に消える**（親が `trashed=false` の
  検索結果に現れない → 子が到達不能になる）

同一フォルダ内の同名ファイルは Drive では合法なので、`modifiedTime` →
`fileId` の順で**決定的に**1 つを選ぶ。ここが非決定的だと、
サイクルごとに別の実体を指してスタブが揺れる。

### カーソルはスキャンの「前」に取る

`buildIndexFlat()` は `changes/startPageToken` を**全件取得の前**に取得する。
後に取ると、スキャン中に起きた変更がベースラインにも差分にも入らず、
恒久的に取りこぼす。

### 索引の取りこぼしは「削除」と区別がつかない

3-way マージにおいて「リモートに無い」は削除を意味し、Pull 分岐は
**ローカルの実体を恒久削除する**。索引に漏れがあると、これが誤って発火する。

対策は 2 つ。

1. **自分の書き込みは即座に索引へ反映する**
   （`ensureRemoteFolder` / `indexUploaded` / `trashRemote`）。
   反映を怠ると、作った直後のものが次サイクルの導出結果に現れない。
2. **削除を実行する前に現物を 1 件確認する**（`verifyRemoteAlive()`）。
   生きていれば索引へ戻して何もしない。次サイクルで正しい分岐に入る。
   削除は稀なので追加コストは無視できる。

### 実測値

本番環境（VFS 実データ、`drive.file` スコープ）での計測。

| 項目 | 実測 |
|---|---|
| メタデータ全件取得 | **8 リクエスト / 7.2 秒**（3,230 件、1 ページあたり約 0.8 秒） |
| `derivePathMap()` のパス導出 | **5 ms**（3,188 件） |
| `createStub` のスループット | **373 件/秒**（2.68 ms/件） |
| 索引のディスク復元 | **176 ms**（3,088 件 / 606 KB） |
| `changes.list` 1 回 | **422 ms** |

6,207 ファイル規模のコールドスタートは、メタデータ約 7 秒 + スタブ生成約 17 秒で
**合計 25 秒程度**。従来の逐次 BFS（1,400+ リクエスト）から桁が変わっている。

ただし `firebase_sync` の 1〜2 秒には届かない。Drive には `vfs_index` に相当する
集約ドキュメントが無く、1,000 件ずつページングする必要があるためである。
**「瞬時」ではなく「数十秒」が正しい表現。**

冪等性も実データで確認した。アンカー 2,220 件に対し
`localDrift = 0` / `remoteDrift = 0` / `missingRemote = 0`。
両系のハッシュがそれぞれ自分の系で一致しており、再アップロードは発生していない。

`changes.list` は `drive.file` スコープで**動作する**（当初は未検証だった）。
したがってフラット全件取得への退避は通常経路では起こらない。

### 試験について

`derivePathMap()` / `isExcluded()` の試験（パス導出、フォルダ改名時の追随、
到達不能エントリの破棄、ゴミ箱の親を持つ子の除去、同名重複の決定性、
allowlist 除外の接頭辞誤爆、部分木マウント）は
**本リポジトリには含めない**。

理由は配布経路にある。`scripts/build_defaults.js` は `vfs_root/` を
**丸ごと走査して** `default_files.ts` を生成するため、
ゲスト空間に試験ファイルを置くと**利用者全員の VFS へ配信されてしまう**
（除外されるのは `.git` / `__pycache__` / `.trash` / `.sample` / `.DS_Store` のみ）。

かといってホスト側の `src/` に置くのも筋が悪い。対象はゲスト空間で動く
プレーンな HTML/JS であり、ホストのモジュールではない。

したがってゲスト空間の試験は**開発環境の VFS 上で実行し、結果をここに記録する**
運用とする。試験ハーネスは実装をコピーせず `gdrive_sync.html` の
script 要素の本体を評価するため、実装が変われば追随する。

直近の実行結果: **31 ケース全通過**。
さらに変異試験（パス連結・新旧比較・同着判定をそれぞれ破壊）で
対応するケースが確実に落ちることを確認済みであり、
試験が空回りしていないことの裏付けとしている。