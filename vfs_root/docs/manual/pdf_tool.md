# PDF の道具（`pdf_tool`）— ページ数を知る・ページを別の PDF に切り出す・ページを画像に・文字を取り出す

**場所**: `system/services/pdf_tool.html`（デーモン・pid `pdf_tool`）／部品 `system/lib/pdf_text.js`
**常駐しない**（`services.json` で `autoStart: false`）。要るときに `spawn` する。

## なぜ在るか

ホストの道具は「テキストを読む／ファイルを丸ごと添付する」だけで、PDF の分割を知らない。
PDF を丸ごと添付すると**全ページ**が AI の文脈に入る（40 ページなら 40 ページ分の費用）。
形式ごとの処理（分割・変換）は VFS → VFS の道具としてゲストに置く —— これはその最初の 1 つ。

pdf.js はホストが同梱している（`public/vendor/pdfjs/`・4 MB）。VFS には置かない（利用者全員に配信されてしまう）。
デーモンは `MetaOS.vendor.resolve('pdfjs')` で場所を訊いてから読む（ホストの URL を自分で組まない）。
pdf.js は読む・描く専用で PDF を**書けない**ので、切り出し（`pdf_extract`）は pdf-lib（保守版 `@cantoo/pdf-lib`・`public/vendor/pdflib/`・614 KB・
`MetaOS.vendor.resolve('pdflib')`）で `copyPages` する。どちらも使うまで降りてこない。
外部のサービスには出さない。暗号化された PDF は扱わない。

**PDF は PDF のまま添付するのが基本。** LLM の API の多くは PDF の中の文字（文字層）を読む。ページを画像にすると
その情報が落ちる（字形の埋め込みが無い PDF では名称が空白に見える）。画像にするのは**見た目が要るとき**だけ。

## 使い方（AI）

```
<spawn path="system/services/pdf_tool.html" type="daemon" show="false" />
```
→ `tool_available` で道具が届く。

| 道具 | 何をする | 主な引数 |
| :-- | :-- | :-- |
| `pdf_info` | ページ数・大きさ・ページごとの寸法と文字数。**読む前にまずこれ** | `path`・`pages`（省略は全ページ） |
| `pdf_extract` | 指定したページを**別の（小さい）PDF** にして VFS に書く → `attach_file`。文字層・フォント・画像・ページの注釈はそのまま写る | `path`・`pages`（必須。`"3"` `"3-5"` `"1,4,7-9"`。全ページは断る＝元をそのまま添付する）・`out`（既定 `system/temp/pdf/<名前>/<名前>_p003-005.pdf`） |
| `pdf_pages` | 指定したページを PNG / JPEG にして VFS に書く（見た目が要るとき: 図面・レイアウト・文字 0 のスキャン） | `path`・`pages`（必須。`"3"` `"3-5"` `"1,4,7-9"` `"all"`）・`out`（既定 `system/temp/pdf/<名前>/`）・`size`（長辺 px。既定 1568）・`format` |
| `pdf_text` | 文字を取り出して .txt に書く。字形の埋め込みが無い PDF でも読める | `path`・`pages`・`out`・`form`（`lines` / `items`）・`preview` |
| `pdf_to_text` | `pdf_text` の旧名（`from` / `to`） | — |

流れ: `pdf_info` → 読むページを決める → `pdf_extract` でそのページだけの PDF に → **その PDF を `attach_file`**（費用はページ数ぶん）。
見た目が要るページだけ `pdf_pages` で画像に。文字だけでよければ `pdf_text`（履歴に文字で入る。添付の費用が掛からない）。
文字が 0 のページは画像だけ（スキャン）なので `pdf_text` では読めない → `pdf_pages`（PDF のまま添付しても、文字の無いページは画像として扱われる）。

## 限界

* 表の列の順（見た目）は保証しない。表を組み直すなら `form="items"`（`y<TAB>x<TAB>文字`）で位置から
* `pdf_pages` は 1 回に 20 枚まで（多いときは `pages` を分ける）
* `pdf_extract` は文書全体の栞（アウトライン）を写さない。フォームの欄・リンクはページ単位で付いてくる
* `system/temp/` に書いたものはセッションの初期化で消える。残すなら `out` に利用者の領域を指定する
* この OS のタブが裏に回っていると描画（canvas）が遅れることがある

## 試験

`tests/guest/pdfTool.test.ts`（行組み・`parsePages`・`pagesLabel`・置き場と配線）、`tests/guest/pdfExtract.test.ts`（pdf-lib の `copyPages` で切り出した PDF から pdf.js が元の文字を読めること）。描画は jsdom では動かないので、実機か headless Chromium で。
