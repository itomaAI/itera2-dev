# tests/guest — ゲスト空間の実装に対する試験

対象は `vfs_root/` 配下、つまり**ホストの `src/` ではなくゲストとして動くもの**である。

- ブラウザのゲスト（素の HTML/JS）… `vfs_root/system/services/*.html`
- 利用者の実機で動く python … `vfs_root/system/services/itera_bridge_server.py`

## 置き場の規則

**ホストの `src/` を import しない試験はここに置く。** `src/**` の隣に置くと、
そのディレクトリの実装を試験しているように読めてしまう
（実際 2026-08-21 まで、ここにある 4 本は `src/core/vfs/` に居た）。

逆に、`src/` の実装を import する試験は**その実装の隣**に置く（このリポジトリの慣習）。

## 実装をコピーしないこと

ゲストの HTML は vitest の対象外なので、**ソースから関数を取り出して評価する**。
コピーして試験すると、コピーだけが正しくて本体が壊れている状態を検出できない。
取り出せなかったときは黙って素通りさせず、**失敗させる**こと。

## 走らせ方

| もの | どう走るか |
| :-- | :-- |
| `*.test.ts` | `npm test`（vitest の include は既定＝プロジェクト全域なので、この位置でも走る） |
| `test_bridge_server.py` | `python3 -m pytest tests/guest/test_bridge_server.py -q`（vitest では走らない。CI にも入っていない） |
| `../lpml_regex_test.html` | ブラウザで開いて目で見る |

## 中身

- `gdriveExclusion.test.ts` … `gdrive_sync.html` の除外判定（T-0014。ルート同期で他プロバイダの祖先を巻き込まない）
- `localBridgeConflict.test.ts` … 3-way マージの「両方が動いた」分岐（T-0013）
- `localBridgeRelease.test.ts` … スタブへ戻す操作（ホスト側の一致を確かめてから消す）
- `localBridgeVanished.test.ts` … リモートから消えたときの扱い
- `test_bridge_server.py` … long-poll と版（rev）の表現
