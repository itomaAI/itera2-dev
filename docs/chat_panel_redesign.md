# ChatPanel 再設計 — 成果物枠の分離

**状態**: **実装済み・未検証**（2026-08-17 実装。ビルドおよび目視確認は未実施）
**作成**: 2026-08-17

**検証待ち**: この環境にはシェルが無いため `npm test` / `npm run dev` を実行できていない。
`src/utils/markdownLite.test.ts` を追加したが**まだ一度も走らせていない**。
実装完了は動作確認済みを意味しない。

**付随して見つかった不具合**: `LpmlRenderer` が使っていた `border-system` / `bg-system` は
存在しないトークンだった。`system` は `tailwind.config.js` の `colors.text` 配下にあるため、
正しくは `text-text-system` 等になる。よってこれらの指定は**一度も効いていなかった**。
今回タグ箱を中立化したので当該クラスは削除済み。`ChatPanel` 側の `text-system`（`ui` の装飾）も同様に無効で、こちらも削除済み。
**対象**: `src/shell/panels/ChatPanel.ts` / `src/shell/services/LpmlRenderer.ts` / `src/core/control/tools/sys_tools.ts` ほか
**モック**: `data/00_inbox/chatpanel_design_mock.html`（本VFS上。リポジトリには含めない）

---

## 1. 問題

`report` / `ask` の**本文が `ToolResult.ui` に入っている**。

```
report → { log: 'Displayed message to user.', ui: `📢 ${params.content}` }
```

しかし他の全ツールの `ui` は「絵文字＋短い動詞句」の**実行ステータス**である
（`🕒 Time checked` / `📖 Read {path}` / `🚀 Spawned process` …）。
同じフィールドが「何をしたか」と「何を渡したか」という別種のものを運んでいる。**型の誤り**。

結果として2つの症状が出ている。

1. ユーザー向けの散文が、ログの箱の中に `text-xs font-mono mx-8` で描かれる（窮屈）。
2. **レポート本文が2回描画される。** 原稿（modelターン）に生で1回、システムログに整形済みで1回。
   `LpmlRenderer` の `case 'report'` が `isOpen = true` のため、両方が開いた状態で並ぶ。

## 2. 設計原則

### 2.1 4つの主体と4つの表示

| 主体 | 表示 | 性格 |
| :-- | :-- | :-- |
| ユーザー | ユーザー入力 | — |
| LLM（作家） | LLM生出力 | 原稿。ト書きも思考も見える |
| Itera（キャラクター） | **成果物枠** | 上演。自然言語で喋る唯一の場所 |
| システム | システムログ | 舞台機構の作動記録 |

**LLM APIへ渡るのは前3種（ユーザー入力／LLM生出力／システムログ）のみ。成果物枠は表示専用。**

### 2.2 ツールの副作用としての成果物

`tool_output` は常に「やった」という記録であり、成果物そのものではない。

| ツール | 副作用の場所 | tool_output |
| :-- | :-- | :-- |
| `create_file` | VFS にファイルができる | 作った |
| `spawn` | プロセスが起動する | 起動した |
| `report` | **ChatPanel にメッセージができる** | 出力した |

`create_file` の `tool_output` にファイル全文が入っていないのと同じ理由で、
`report` の `tool_output` に本文が入っているのはおかしい。**現状が例外だった。**

この形は既に部分的に存在する（`output.media` はログ行とは別の視覚要素として描かれる）。
ただし media は LLM へも投影される点が異なる。成果物は投影しない。

### 2.3 データの所属と DOM の兄弟関係は別

> ターンは*一つの出来事*の単位であり、出来事は「記録」と「成果物」を持つ。表示はそれを兄弟の枠として並べる。

これにより「枠は分かれている」と「データは同じターンに属する（＝投影が安全）」が両立する。
削除も出来事単位で一貫する（× 一つで記録と成果物が両方消える）。

## 3. 確認済みの事実（再調査不要）

| 事実 | 根拠 |
| :-- | :-- |
| `Projector` は `meta.visible` を見ない。全ターンを無条件に走査する | `Projector.ts` の3実装すべて |
| ゆえに「表示するがLLMに入れない」軸は**存在しない** | 同上 |
| **しかし新設不要。** `serializeToolOutput` は `log` と `params` しか読まない | `LpmlSerializer.ts` L13-26 |
| `shouldEmit = Boolean(output.log \|\| output.media)` | `PromptContentBuilder.ts` L39 |
| → `output` に別フィールドを足せば**投影は自動的にゼロ** | 上2つの帰結 |
| `bg-panel` は両テーマで地色より明るい（light 255>249 / dark 31,41,55>17,24,39） | 実測 |
| `bg-card` はライトで沈みダークで浮く（**使用禁止**） | light 243<249 / dark 55,65,81>31,41,55 |
| `bg-overlay` は Tailwind config に定義済み。新トークン不要 | `tailwind.config.js` L45 |
| 本文を `ui` に積んでいるのは `report` と `ask` の2つだけ | 全ツールの `ui` を確認 |
| `_formatSystemMessage` はコードフェンス・表・インラインコードのみ対応 | `ChatPanel.ts` L509-537 |

## 4. 決定事項

- フィールド名は **`artifact`**。
- 成果物枠は**無標**（話者ラベル・アバターなし）。
- `ask` は `report` と同じ枠。違いはループが止まるかどうかだけ。
- 形は「**既存の枠の入れ替え**」。新しい形は作らない。
- 色は「**対の統一**」。ユーザーと成果物を同じ面の高さに置く。
- 過去履歴のマイグレーション・フォールバックは**不要**（セッションリセットで消えるため）。
- Markdown は `**強調**` / `- 箇条書き` / `## 見出し` を追加する。外部ライブラリは入れない。

---

## 5. 実装計画

### Phase 1 — データ契約（LLMコンテキストは1バイトも変えない）

**1-1.** `src/core/types/tools.ts` の `ToolResult` に追加

```ts
artifact?: { kind: 'speech'; text: string };
```

**1-2.** `src/core/control/tools/sys_tools.ts`

| ツール | 変更後 |
| :-- | :-- |
| `report` | `log: 'Displayed message to user.'` / `ui: '📢 report'` / `artifact: { kind:'speech', text: params.content }` / `trigger_llm: false` |
| `ask` | `log: 'Waiting for user input.'` / `ui: '❓ ask'` / `artifact: { kind:'speech', text: params.content }` / `halt_loop: true` |

他のツールは変更不要。

### Phase 2 — 描画（`ChatPanel.ts`）

**2-1.** `_appendTurn` L369：systemターンのコンテナから `text-xs font-mono` を外し、ログ行側へ降ろす。
成果物が親の書式に引きずられないようにするため。

**2-2.** `_renderArrayContent`：`item.output.artifact` があれば、ログ行とは**別の兄弟要素**として成果物枠を描く。順序はログ→成果物。

**2-3.** `ui` は常に1行のステータスとして描く（現行の `text-system font-bold` の特別扱いを廃止）。

### Phase 3 — 形と色

| 要素 | クラス |
| :-- | :-- |
| ユーザー | `bg-panel border border-border-main border-r-[3px] border-r-primary/60 rounded-lg p-3 ml-4 text-sm shadow-sm` |
| 成果物 | `bg-panel border border-border-main border-l-[3px] border-l-success/60 rounded-lg p-3 mr-4 text-sm shadow-sm` |
| 生出力・システム | `bg-overlay/5 border border-border-main/60 rounded-lg p-3 mx-8 text-xs font-mono text-text-muted` |

ユーザーと成果物が**同じ幅・同じ面の高さ**になり、外側の辺のアクセントだけで区別される。
機構レイヤは左右32pxで内側に落ち、黒αで沈む。

**3-1.** `LpmlRenderer`：機構レイヤ内のタグ箱を中立化する。
ただし `error` と `syntax_warning` は色を残す（意味があるため）。

**3-2.** `LpmlRenderer`：`report` / `ask` の `isOpen` を false へ。
**ただしストリーミング中は開く**。生成中はまだ成果物が存在せず、原稿が唯一の窓になるため。
`formatStream(text, opts)` に `streaming` を追加し、`updateStreaming` は true、`_appendTurn` は false を渡す。

**3-3. 自己完結タグの属性表示は現行を維持する。**
`<read_file path="..." />` のように属性を持つタグは、**折り畳みの箱にして全属性を表示**する
（`LpmlRenderer` は属性があれば `displayContent` が非空になり `<details>` を出す）。
すべての情報が見られる状態を保つこと。インラインのチップに省略してはならない。

### Phase 4 — Markdown レンダラ

`src/utils/` に小さなレンダラを追加し、`markdownTable.ts` と組み合わせて成果物枠に適用する。
対応範囲は `**強調**` / `- 箇条書き` / `## 見出し` ＋ 既存のコードフェンス・表・インラインコード。

**注意**: コードフェンスを先にプレースホルダへ退避してから他の変換を行うこと
（`_formatSystemMessage` と同じ手順。誤爆防止）。

### Phase 5 — バグ修正（本件とは独立）

`setProcessing`（`ChatPanel.ts` L252）が `#ai-typing` の `innerHTML` を
「Processing...」で毎回上書きしており、index.html L399-401 の静的マークアップ（「Thinking...」）が死んでいる。
上書きを廃止し、文言を一元化する。

---

## 6. 検証

1. 現行履歴の再描画／ストリーミング中→確定後の遷移／`report` と `ask` の両方
2. **ライト・ダーク両テーマ**（`bg-card` の反転問題があったため必須）
3. 長文・表・コード・見出し・箇条書きを含むレポート
4. LLMへ送るペイロードに成果物が混入していないこと
5. 既存 vitest（`ProviderManager` / `VfsLockManager` / `Translator`）
   ※ シェルが無いため実行はユーザーに依頼する

## 7. 残っている論点

- 成果物枠は将来「ChatPanelを操作するツールの成果物」の**汎用チャンネル**になりうる
  （画像・表・フォーム等）。その場合 `kind` で描き分ける。`kind: 'speech'` のときだけ Itera の声として扱う。
- ゲスト動的ツールに `artifact` を許可するかは未決。

---

## 8. 外観設定と設定アプリ（Phase 6）

### 8.1 配信の仕組み（確認済み）

`VfsInitializer.ts` L105-138 の `isForceUpdateArea = isSystemArea && !isConfigArea`
（`isConfigArea` は `system/config/` と `system/registry/`）より：

| パス | 既存インストールへの配信 |
| :-- | :-- |
| `system/themes/*.json` | **毎回強制更新される**（新しい色キーは全員に届く） |
| `system/apps/settings.html` | **毎回強制更新される** |
| `system/config/appearance.json` | **更新されない**（ユーザーの選択が保持される） |

**したがってマイグレーションは不要。** 新トークンはテーマ定義側に入るため自動的に行き渡り、
`appearance.json` はテーマへの*パス*しか持たないので、パスを変えない限り壊れない。

### 8.2 `appearance.json` はスキーマ変更不要

現在の中身は `theme`（テーマファイルへのパス）/ `typography` / `layout` / `locale` のみで、
個別の色は持っていない。**色はすべてテーマ定義側にある**ため、このファイルは触らない。

### 8.3 新トークンは1つだけ

新デザインが必要とする色は、既存トークンでほぼ賄える。

| 用途 | トークン |
| :-- | :-- |
| ユーザーのアクセント（右辺3px） | `accent.primary`（既存） |
| 機構レイヤの沈み | `bg.overlay` のα（既存） |
| 会話レイヤの面 | `bg.panel`（既存） |
| **成果物のアクセント（左辺3px）** | **`accent.speech`（新規）** |

**`tags.report` の再利用は不可。** ダークでは `#312e81` と背景タイント用の暗色であり、
パネル地（`#1e293b`）の上に3pxの線として置くとほとんど見えない。
`tags.*` は「箱の背景色」として設計されているため、アクセント線には使えない。

### 8.4 変更点

1. **`vfs_root/system/themes/{light,dark,midnight}.json`** — `colors.accent.speech` を追加。
2. **`src/shell/services/ThemeService.ts`** — `setVar('--c-accent-speech', colors.accent?.speech || colors.accent?.success)` を追加。
   **このフォールバックが「キーが無ければ既定に戻る」の実体**であり、マイグレーションコードの代わりになる。
   ユーザーが自作したテーマにもそのまま効く。
3. **`tailwind.config.js`** — `speech: 'rgb(var(--c-accent-speech) / <alpha-value>)'` を追加。
4. **`vfs_root/system/apps/settings.html`** — テーマ選択のプレビューを更新。
   現在は `bg.app` の円の中に `accent.primary` の点を1つ置くだけ（L844-859）なので、
   **`accent.speech` の点を併記**して、会話レイヤの2色が見えるようにする。
   なお設定アプリに個別の色エディタは存在せず、テーマの選択のみを行う。

---

## 10. 追補：成果物枠のヘッダーと削除ボタン（2026-08-17）

当初は成果物枠を**無標**（話者ラベルなし）とする方針だったが、実装後に
**4種のうち成果物枠だけヘッダーが無い**という構造的な非対称が残ることが分かった。

ヘッダーが示しているのは「主体」である（`_appendTurn` は `turn.role` をそのまま大文字で出している）。
したがって4主体モデルに対応させ、成果物枠には **`Itera`** を出す。
これで `USER` と `Itera` が同じ語彙で左右の対になる。

- **未対応**: `preferences.agentName` への追従。現状は固定表記のため、
  エージェント名を変更した利用者の画面では表示が実態と食い違う。
  `setPrincipalProvider` と同じ注入パターンで `setAgentNameProvider` を足せば済む（コードにTODOを記載）。
- **見送った案**: `ARTIFACT: REPORT`（チャネル＋由来を書く案）。
  `report` と `ask` を画面上で区別できる利点があるが、会話レイヤに機構の語彙が入り
  `USER` と対にならないため見送った。**`report` と `ask` が見分けられない問題は未解決のまま残る。**

### 削除ボタン

統一のため成果物枠にも `×` を置いた。ただし**見た目だけの飾りではない**。

押すと消えるのは「ターン＝ひとつの出来事」であり、**記録（ツール実行ログ）も一緒に消える**。
成果物自体はLLMコンテキストへ投影されないが、同じターンのツール実行ログは投影されるため、
**成果物枠の `×` を押すとLLMの文脈からログが消える**点に注意。

成果物だけをDOMから消す実装にはしていない。履歴に残ったまま画面から消すと、
`renderHistory` による再描画で復活して表示が嘘になるため。