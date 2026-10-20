# PDF の道具（`pdf_tool`）— ページ数を知る・ページを画像に・文字を取り出す

**場所**: `system/services/pdf_tool.html`（デーモン・pid `pdf_tool`）／部品 `system/lib/pdf_text.js`
**常駐しない**（`services.json` で `autoStart: false`）。要るときに `spawn` する。

## なぜ在るか

ホストの道具は「テキストを読む／ファイルを丸ごと添付する」だけで、PDF の分割を知らない。
PDF を丸ごと添付すると**全ページ**が AI の文脈に入る（40 ページなら 40 ページ分の費用）。
形式ごとの処理（分割・変換）は VFS → VFS の道具としてゲストに置く —— これはその最初の 1 つ。

pdf.js はホストが同梱している（`public/vendor/pdfjs/`・4 MB）。VFS には置かない（利用者全員に配信されてしまう）。
デーモンは `MetaOS.vendor.resolve('pdfjs')` で場所を訊いてから読む（ホストの URL を自分で組まない）。
外部のサービスには出さない。暗号化された PDF は扱わない。

## 使い方（AI）

```
<spawn path="system/services/pdf_tool.html" type="daemon" show="false" />
```
→ `tool_available` で道具が届く。

| 道具 | 何をする | 主な引数 |
| :-- | :-- | :-- |
| `pdf_info` | ページ数・大きさ・ページごとの寸法と文字数。**読む前にまずこれ** | `path`・`pages`（省略は全ページ） |
| `pdf_pages` | 指定したページを PNG / JPEG にして VFS に書く | `path`・`pages`（必須。`"3"` `"3-5"` `"1,4,7-9"` `"all"`）・`out`（既定 `system/temp/pdf/<名前>/`）・`size`（長辺 px。既定 1568）・`format` |
| `pdf_text` | 文字を取り出して .txt に書く。字形の埋め込みが無い PDF でも読める | `path`・`pages`・`out`・`form`（`lines` / `items`）・`preview` |
| `pdf_to_text` | `pdf_text` の旧名（`from` / `to`） | — |

流れ: `pdf_info` → 読むページを決める → `pdf_pages` で画像に → **読むページの画像だけを 1 枚ずつ読む**（全部を一度に入れない）。
文字が 0 のページは画像だけ（スキャン）なので `pdf_text` では読めない → `pdf_pages`。

## 限界

* 表の列の順（見た目）は保証しない。表を組み直すなら `form="items"`（`y<TAB>x<TAB>文字`）で位置から
* `pdf_pages` は 1 回に 20 枚まで（多いときは `pages` を分ける）
* `system/temp/` に書いたものはセッションの初期化で消える。残すなら `out` に利用者の領域を指定する
* この OS のタブが裏に回っていると描画（canvas）が遅れることがある

## 試験

`tests/guest/pdfTool.test.ts`（行組み・`parsePages`・置き場と配線）。描画は jsdom では動かないので、実機か headless Chromium で。
