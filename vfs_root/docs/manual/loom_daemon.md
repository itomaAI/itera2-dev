# Loom デーモン（`system/services/loom.html`）

**2026-09-25。** Loom の札（`data/apps/loom/*.md`）の**写し**と、札への**書き込みの列**を持つデーモン。
画面（`system/apps/loom.html`）は描くだけになり、読み書きはすべてこのデーモンに頼む。Itera は道具（`loom_*`）で同じ列を使う。

* 登録: `system/registry/services.json` の `loom_daemon`（autoStart）
* 核（解析・系譜・全景の純粋関数）: `system/lib/loom_core.js`（`window.LoomCore`）。**画面とデーモンは同じこのファイルを読む**
* 写しの保存先: `system/temp/loom_index.json`（クラウド同期の対象外 ＝ **端末ごと**）

---

## 1. なぜあるか

* 札が 480 枚・5.8 MB になり、`search` が遅く、**stub の札は検索から漏れる**（T-0531 の依頼）
* 画面は操作のたびに全件を読み直していた（実測 1.1 秒／480 枚）。4 秒ごとの監視も画面ごとに走っていた
* 画面と Itera が別々に「読む → 変える → 書く」をしていた。同じ札へ同時に書くと片方が消えうる

## 2. 仕組み

* **写しは hash で腐りを検出する。** `MetaOS.fs.getSyncState(dir)` は 1 回の呼び出しで全部の札の hash を返す（実測 3ms）。
  写しの行の hash と一致すれば読まない。食い違った札だけ読み直す。本文もメモリに持つので、一覧・検索はファイルを読まない
* **写しは唯一の正ではない。** 無い・古い・壊れていても、読み直しに落ちるだけで答えは正しい（上がるのは費用だけ）
* **写しの行 ＝ front matter ＋ 本文から導いた事実**（`LoomCore.derive`）: 最後の日時・計画の進み・文脈の取り込み点・
  未送の総括の数・自分の総括／レポートの数・「完了: <id>」として載っている id（＝運んだ証拠）・節の並び・行数。
  **一覧の描画・系譜・全景・「運んだか」の判定は、これと front matter だけで足りる**
* **書き込みは 1 本の列。** 画面の操作も Itera の道具も、ここで直列に「ファイルから読み直す → 変える → 書く」。
  `done`（親へ運ぶ）の二度押しでも、2 回目は列の後ろで「既に運ばれた」を見て止まる
* **監視**: `vfs_mutation`（札のパス）で 250ms 後に突き合わせ。取りこぼしの掃除に 30 秒ごと
* **stub**: 写しに行があり hash が一致すれば取りに行かない。無い札は 1 回 20 枚までずつ取りに行く。
  `loom_search` と `loom_status reconcile="true"` は明示的に全部を取りに行く
* **札の名前（`P-0000.md` / `T-0000.md`）でないファイルは札として読まない。**「読めないファイル」として必ず報告する
  （黙って捨てない。実例: 2026-09-25 に `T-0504 (Conflicted Copy).md` が見つかった）

## 3. Itera の道具

| 道具 | 何をするか |
| :-- | :-- |
| `loom_list` | front matter で絞って一覧（status は `mine` / `yours` / `open` も使える）。**セッション開始時の拾いはこれ** |
| `loom_search` | 本文の全文検索（stub も読む）。行番号はファイルの行番号 |
| `loom_tree` | 祖先（根から）・所属・前任／後継・子を**パスで**返す。中身は返さない |
| `loom_update` | front matter を変える。`status="review"` は確認へ回す（レポートが無ければ回さない）。**`done` は受け付けない** |
| `loom_append` | 節へ追記。**日時はデーモンが押す**。`form` = entry / report / addendum / raw。`status` を同時に変えられる。書いたあと読み直して行番号を返す |
| `loom_create` | 札を起こす（id はデーモンが採番。親の側に 起票／分解／分岐 の 1 行） |
| `loom_status` | 写しの状態・読めないファイル・自己試験 |

**要約する道具は作らない**（T-0055 で却下: `ctx_brief` が要約の空欄を「決定なし」と答え、完全性の錯覚を作った）。
道具は探す・指す・運ぶだけ。祖先を根まで読むのは `read_file` で。

## 4. 画面との IPC

* 画面 → `loom.req` `{ rid, op, args }` ／ デーモン → `loom.res` `{ rid, ok, result | error }`
* デーモン → `loom.changed` `{ rev, rows, removed }`（写しが変わったとき。変わった札の行だけ）
* 操作（`Ops`）: `rows` / `get` / `saveMeta` / `saveBody`（基準の本文と違えば `conflict`）/ `append` / `cyclePlan` /
  `create` / `supersede` / `recapInfo` / `pushUp` / `closeMerge` / `complete` / `done` / `drop` / `remove` / `selfTest` / `status`
* 操作は**訊かない**（ダイアログを出さない）。理由つきで `ok:false` を返し、訊くのは画面の仕事
* 画面はデーモンが応答しないとき**自分で書かない**（掲示を出し、「再読込」でデーモンを起動し直す）

## 5. 試験のしかた

* 起動引数で別の板を相手にできる（本物の板を汚さない）:
  `spawn path="system/services/loom.html" type="daemon" pid="loom_sandbox" dir="system/temp/loom_sandbox" index="system/temp/loom_sandbox_index.json" channel="loom_sb" tools="false"`
  → `inject_js pid="loom_sandbox"` で `window.LoomDaemon.Ops.*` を直接呼ぶ。`tools="false"` の実体は道具を登録も解除もしない
* 核の自己試験: `loom_status selftest="true"`。画面の自己試験（描画を含む）: Loom で `selfTest()`

## 6. 既知の制限

* 写しは端末ごと。別の端末で書かれた札は、クラウド同期で降りてきた時点で hash の食い違いとして拾う
* 画面は選んだ札の本文だけを持つ。選んでいない札の本文を画面で使う機能を足すときは、派生値に足すか、`get` で読む