# Itera OS v2

**Itera OS v2** は、AI・人間・アプリケーション・ツール・バックグラウンドサービスが、同じファイルシステムとイベント履歴を共有して協働するための、ブラウザ上で動作する実験的なAIオペレーティングシステムです。

一般的な「チャットUIにツール実行を追加したAgent」ではなく、AIをOS上の一主体として扱い、永続ファイル、プロセス、アプリ、デーモン、権限、履歴、非同期イベントを統合した作業環境を目指しています。

> Status: Experimental / Active Development

## Design Philosophy

Iteraは、AIを人間の代替や上位者として置くのではなく、人間・AI・ツールを共有された作業空間へ参加する対等な主体として扱います。

中心となる考え方は次のとおりです。

- **Local First**: ユーザーデータとOS状態はブラウザ内のVFSへ保存する
- **Persistent Workspace**: 会話が中断されても、ファイルと作業状態は残る
- **Event-driven Collaboration**: 人間、AI、ツール、アプリ、デーモンのイベントを同じ時間軸で扱う
- **Capability-based Tools**: 実行中のGuestアプリやDaemonが、AIへ動的にツールを公開できる
- **Read before Write**: 外部状態を操作する前に、現在の状態を観測する
- **Transparent Operations**: AIのファイル操作とツール実行を履歴として監査できる
- **No Server Runtime**: OS本体は静的ファイルとして配信でき、ブラウザ内で動作する

## Features

### AI Runtime

- Gemini / OpenAI Compatible / AnthropicのProvider Adapter
- Providerごとの画像・PDF・ファイル入力
- LPML（LLM-Prompting Markup Language）による明示的な応答・ツール実行
- 自律的な実行サイクル
- ユーザー、システムイベント、ツール結果による非同期wake-up
- 永続Historyとセッション復元
- Dynamic Toolのプロンプトへの自動登録

### Virtual File System

- IndexedDBを用いたメタデータ管理
- OPFSを用いたファイル実体の保存
- 階層パス解決
- ACLによるPrincipal単位の権限制御
- Transactionと階層Lock
- VFS Mutation Event Bus
- StubとSync Provider
- ファイル関連付け
- Trash、System、User、Agent領域
- 初期VFSの自己修復とUpstream展開

### Applications and Processes

- Guestアプリのiframe sandbox実行
- App / Daemonプロセス
- Process Registry
- 起動、再開、終了、foreground/background管理
- `metaos://` URI routing
- Guestアプリへの起動引数
- ファイルを関連付け済みアプリで開く機能
- Host Editor / Media Viewer / Runner

### Guest Bridge

Guestアプリは`window.MetaOS`を通じてHost OSの機能を利用できます。

主なAPI:

```text
MetaOS.fs
MetaOS.ai
MetaOS.system
MetaOS.host
MetaOS.net
MetaOS.device
MetaOS.tools
```

Guest Bridgeは`src/api/guest_bridge.js`に通常のJavaScriptソースとして定義され、実行時にBlob URLとしてGuestへ注入されます。

### Dynamic Tools

GuestアプリやDaemonは、独自ツールを実行中のAIへ登録できます。

```js
MetaOS.tools.register({
  name: 'example_tool',
  description: 'Example dynamic tool',
  definition: '<define_tag name="example_tool">...</define_tag>',
  handler: async (params) => {
    return {
      log: JSON.stringify(params),
      ui: 'Executed example tool',
    };
  },
});
```

プロセスが終了すると、そのプロセスが公開していたツールも削除されます。

### System Logs

ログはVFS内のJSONLとして保存されます。

```text
system/logs/system/YYYY-MM-DD.jsonl
system/logs/usage/YYYY-MM-DD.jsonl
system/logs/vfs_events/YYYY-MM-DD.jsonl
system/logs/process_events/YYYY-MM-DD.jsonl
system/logs/tool_events/YYYY-MM-DD.jsonl
```

Tool Execution Logには、ツール名、種別、PID、パラメータ、開始・完了時刻、実行時間、結果、エラーが記録されます。

現在の実装では、ツールのパラメータと結果はマスクされず、生データとして保存されます。

## Architecture

```text
┌──────────────────────────────────────────────────────────┐
│ Shell / Desktop                                           │
│ Panels, Modals, Windowing, Process Manager, Theme         │
├──────────────────────────────────────────────────────────┤
│ Control                                                   │
│ Engine, Translator, Tool Registry, Tool Execution         │
├──────────────────────────────────────────────────────────┤
│ Cognitive                                                 │
│ Projectors, Provider Adapters, Prompt Content             │
├──────────────────────────────────────────────────────────┤
│ State / System                                            │
│ History, Config, App Registry, Logger, Associations       │
├──────────────────────────────────────────────────────────┤
│ VFS                                                       │
│ NodeStore, ContentStore, ACL, Lock, Transaction, Events   │
├──────────────────────────────────────────────────────────┤
│ Browser Platform                                          │
│ IndexedDB, OPFS, iframe, postMessage, Web APIs            │
└──────────────────────────────────────────────────────────┘
```

### Source Layout

```text
src/
├── api/                  Host API、Guest Bridge
├── config/               Provider、Prompt、生成済みVFS defaults
├── core/
│   ├── cognitive/        Projector、Translator、LLM Adapter
│   ├── control/          Engine、Tool Registry、System Tool
│   ├── state/            History、System Logger
│   ├── sys/              Config、App Registry、File Association
│   ├── types/            共有データ契約
│   └── vfs/              Virtual File System
├── ipc/                  Host Transport、IPC Message、RPC
├── shell/
│   ├── core/             Bootstrap、Desktop、Event Orchestration
│   ├── modals/           Host Modal UI
│   ├── panels/           Chat、Explorer、Tree View
│   ├── services/         Shell Service、Recorder
│   └── windowing/        Guest Compiler、Process Manager
└── utils/                ID、Path、Binary変換

vfs_root/
├── apps/                 初期Guestアプリ
├── data/                 初期ユーザーデータ
├── docs/                 VFS内ドキュメント
├── memory/               AIの初期記憶・規則
├── services/             Guest Daemon
└── system/               OS設定、Registry、System App、Theme
```

## VFS Defaults

`vfs_root/`は、OS初回起動時に展開される初期VFSのソースです。

開発・ビルド前に次のスクリプトが`vfs_root/`を走査し、`src/config/default_files.ts`を生成します。

```bash
node scripts/build_defaults.js
```

通常は`predev`と`prebuild`で自動実行されます。

> `src/config/default_files.ts`は自動生成ファイルです。直接編集せず、`vfs_root/`側を編集してください。

起動時の`VfsInitializer`は次を行います。

- 必須System Directoryの修復
- 初期VFSファイルの展開
- Systemファイルの更新
- `system/upstream/`への公式ファイル展開
- System / User / Agent向けACLの適用

## Development

### Requirements

- Node.js 24
- npm
- OPFS / IndexedDB / iframe sandboxをサポートするモダンブラウザ

GitHub PagesのWorkflowもNode.js 24を使用します。

### Install

```bash
git clone https://github.com/itomaAI/itera2-dev.git
cd itera2-dev
npm ci
```

### Development Server

```bash
npm run dev
```

### Build

```bash
npm run build
```

Buildでは次を実行します。

1. `vfs_root/`から`default_files.ts`を生成
2. TypeScript type check
3. Vite production build

出力先:

```text
dist/
```

### Preview

```bash
npm run preview
```

### Format

```bash
npm run format
```

## Deployment

`main`へのpushをトリガーとして、GitHub Actionsが次を実行します。

1. `npm ci`
2. `npm run build`
3. `dist/`をGitHub Pagesへdeploy

Viteの`base`は相対パスに設定されているため、静的なサブパス配信に対応します。

## Configuration

主要な設定はVFS内に保存されます。

```text
system/config/preferences.json
system/config/appearance.json
system/config/llm.json
system/config/network.json
system/registry/apps.json
system/registry/associations.json
system/registry/services.json
```

### App Registry

`system/registry/apps.json`でGuestアプリを登録します。

```json
{
  "id": "notes",
  "name": "Notes",
  "icon": "📝",
  "path": "apps/notes.html",
  "description": "Markdown text editor",
  "fileHandlers": [
    {
      "action": "view",
      "extensions": ["md", "txt"],
      "mimeTypes": ["text/markdown", "text/plain"]
    }
  ]
}
```

### Service Registry

`system/registry/services.json`でDaemonを登録します。

```json
{
  "id": "example_daemon",
  "name": "Example Daemon",
  "path": "services/example.html",
  "autoStart": true
}
```

## Security Model

Iteraは、HostとGuestをiframe sandboxとIPCで分離します。

主な保護機構:

- Process PIDと送信元Windowの照合
- VFS ACL
- Principal単位のread / write / manage権限
- Guest iframe sandbox
- Host API Router経由の操作
- Credential付きProxy Requestの制限
- System領域の再帰ACL
- Dynamic ToolのProcess Lifecycle連動

Principalの例:

```text
system:kernel
user:local_user
agent:Itera_AI
app:<process_id>
any:*
```

### Important Security Note

現在のTool Execution Logは、パラメータと結果を生データで保存します。API tokenや認証情報をTool Parameterへ直接渡す場合、それらがVFSログへ記録される可能性があります。

本機能は監査性を優先した初期実装であり、redaction policyは今後の拡張対象です。

## Current Limitations

- 実験的なAPIを含み、後方互換性は保証されません
- 自動テストは整備途中です
- Browser Sandbox外の一般Shellは提供しません
- Provider APIの利用には各ProviderのCredentialが必要です
- Guest BridgeとHost IPCには一部対応する実装が重複しています
- UI Event APIと一部の境界型は段階的に整理中です
- Tool Execution Logの機密情報maskingは未実装です

## Contributing

大きな変更では、次の原則を推奨します。

1. 現在の外部状態と対象ファイルを読む
2. Runtime semanticsと非同期タイミングを明示する
3. 変更を小さな単位へ分ける
4. TypeScript buildを通す
5. VFS wire format、IPC action名、History形式の互換性を確認する
6. VFS初期ファイルは`vfs_root/`側を編集する
7. Guest / Host境界で暗黙の`any`を増やさない

## License

ライセンスは現在未指定です。利用・再配布条件についてはRepository Ownerへ確認してください。