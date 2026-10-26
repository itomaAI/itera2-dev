# core/vfs — 入口と内部

**外から使ってよいのは `VfsService` と `types.ts` だけである。** 残りは内部の部品とみなす。

## 層

| 層 | ファイル |
| :-- | :-- |
| 記憶域 | `NodeStore`（木と属性）／`ContentStore`（本体） |
| 入口と調停 | `VfsService`（唯一の公開面）／`VfsTransaction`／`VfsLockManager`／`VfsAuth`／`PathResolver` |
| 操作 | `operations/`（`BaseOperation` を土台に `WriteOps`／`TransferOps`／`AclOps`） |
| 同期プロバイダ | `ProviderManager`／`VfsEventBus` |
| 方針の切り出し | `backupExclusion`（全体バックアップの除外判定。T-0030） |
| 保守 | `VfsFsck`／`VfsInitializer`／`VfsEventFormatter` |

## 現況（2026-08-21 実測）— この規則はまだ守られていない

外部からの import 55 件のうち、入口（`VfsService` / `types`）は 35 件。
残る 20 件は内部へ直接届いている:
`VfsEventBus` 5・`NodeStore` 4・`ContentStore` 3・`VfsEventFormatter` 3・
`backupExclusion`／`VfsInitializer`／`VfsFsck`／`ProviderManager`／`PathResolver` 各 1。

とくに**記憶域を直接触っている外部**が 5 か所ある:
`shell/core/{DesktopEnvironment,EventOrchestrator,SystemBootstrapper}`・`shell/modals/SystemModal`・
`shell/services/MaintenanceDaemon`。

**新しく内部への直接依存を足さないこと。** 必要な口が無いなら `VfsService` に足す。
既存の 20 件は、触る用が生じたときに順次入口へ寄せる（一括の移動はしないと決めた。T-0038）。

## 版の照合（T-0715）

`writeFile(…, { ifVersion })` は錠の中でノードの版（`meta.version`。書くたびに 1 増える）と比べ、違えば
`VfsError('ESTALE')` で断る（1 文字も書かない）。`readFileWithVersion` は**中身を読みに行く前**に版を取る
（「古い中身に新しい版」を作らない）。`updateFile(path, fn)` はその輪（読む→fn→書く→ESTALE なら読み直す）。
錠は各操作の 1 手しか守らないので、読む→直す→書く の 3 手はこれで守る（`VfsLockManager` は再入不可なので、
外側で同じパスの錠を取ると `WriteFileOp` が自分を待って止まる —— 錠を伸ばすのではなく版で守る、が決め）。
ゲストには `MetaOS.fs.update` / `read(..., { withVersion })` / `write(..., { ifVersion })`、`error.code === 'ESTALE'`。

## 試験の置き場

ここに置くのは、**このディレクトリの実装を import する試験**だけ。
ゲスト実装（`vfs_root/system/services/*.html`）を対象とする試験は `tests/guest/` にある。

## 複製がある

`myaku-raku-v2/agent/src/core/vfs/` に同じ構造の複製がある。
片方だけ直すと乖離する（`backupExclusion.ts` は byte 一致を保っている）。ここを触ったら向こうも見ること。
