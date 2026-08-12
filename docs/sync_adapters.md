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