# 開発

## 利用可能なスクリプト

| コマンド | 用途 |
| --- | --- |
| `npm run lockfile:check` | `package-lock.json`内のマシン固有レジストリURLを拒否します。 |
| `npm run lockfile:repair` | レジストリtarball URLを設定済みの公開レジストリに正規化します。 |
| `npm run env:init` | 必要に応じて`.env.example`から`.env`を作成します。 |
| `npm run secrets:generate` | 独立した32バイトのJWTおよびMFAシークレットを出力します。既存の`.env`内の空欄または生成用プレースホルダーを埋めるには`-- --write`を指定します。 |
| `npm run db:configure` | データベース認証情報の入力を求め、`.env`を更新／作成します。 |
| `npm run db:init` | データベースを準備し、接続を検証します。 |
| `npm run db:migrate` | スキーマを調整してマイグレーションを適用します。 |
| `npm run db:seed` | デモアカウントと初期コンテンツを追加します。 |
| `npm run setup` | 環境、データベース、マイグレーションを準備します。 |
| `npm run setup:demo` | setupを実行してデモワークスペースを追加します。 |
| `npm run dev` | データベースの準備完了後にサーバーを起動し、プライベート／シークレットブラウザーウィンドウを開きます。通常プロファイルへのフォールバックは無効です。 |
| `npm run build` | TypeScriptを`dist/`へコンパイルします。 |
| `npm run reproduce:materialization-loss` | 保存されたGit履歴を使って旧ブラウザーペイロードのmaterialization損失を再現し、サーバー権威型の修正を検証します。 |
| `npm run reproduce:cross-instance-loss` | 古いクロスプロセスroom compaction損失を再現し、durable-tip fenceを検証します。 |
| `npm run reproduce:block-preserve-children-delete` | 以前の2リクエストによる部分的な階層コミットを再現し、トランザクションのロールバック／成功状態を検証します。 |
| `npm run verify:collaboration` | MariaDBなしで正確なYjs pin、共同編集配線、durable-roomの鮮度、階層不変条件、RFC 6455動作、実行可能なすべてのJS/TS構文を検査します。 |
| `npm run verify:data-loss` | 依存関係不要の永続化、復旧、破壊的遷移、共同編集整合性ガードを実行します。 |
| `npm start` | コンパイル済みサーバーを実行します。 |
| `npm test` | lockfileを検証してテストスイートを1回実行します。 |
| `npm run test:watch` | watchモードでテストを実行します。 |
| `npm run preview:capture` | ローカルのブラウザーUIから`docs/assets/2026-08-09/preview.png`をキャプチャします。 |

## 依存関係lockfileの信頼性

`package-lock.json`はコミット済みで、通常のインストール中はそのまま保持する必要があります。プロジェクトレベルの`.npmrc`はレジストリURLの移植性を保ち、fetch再試行回数を制限することで、レジストリ障害がインストールのハングのように見えることなく速やかに返るようにします。

依存関係の変更をコミットする前にlockfileを検証してください。

```bash
npm run lockfile:check
```

内部ミラーまたは特定マシン固有のレジストリURLが報告された場合は、lockfileを修復して差分を確認します。

```bash
npm run lockfile:repair
git diff -- package-lock.json
```

CIで再現可能なクリーンインストールを行う場合は、次を推奨します。

```bash
npm ci
```

意図的にプライベートレジストリを使用するチームは、`BRAINVAULT_ALLOWED_NPM_REGISTRY_HOSTS`でそのホスト名を一時的に追加できます。認証情報やマシン専用レジストリURLをlockfileへコミットしないでください。

## プロジェクト構成

```text
BrainVault/
├── docs/                 # ガイド、アセット、OpenAPI
├── migrations/           # MariaDBスキーママイグレーション
├── public/               # ブラウザーUI
├── uploads/              # ランタイム添付ファイルのバイト列（Gitで無視、自動作成）
├── scripts/              # 環境、データベース、マイグレーション、シード、プレビュー処理
├── src/
│   ├── config/           # 環境変数の解析
│   ├── lib/              # データベース、認証、Markdown、WebSocket、共同編集ヘルパー
│   ├── middleware/       # 検証、認証、CORS、エラー
│   ├── routes/           # RESTエンドポイント
│   ├── types/            # ドメインおよびExpress型定義
│   └── utils/            # ブロックツリーおよびスキーマユーティリティ
├── tests/                # VitestおよびSupertestのカバレッジ
├── .env.example
├── .npmrc                # 移植可能なレジストリと制限付き再試行設定
├── package.json
└── tsconfig.json
```

## 翻訳

翻訳は`public/i18n.js`にあります。静的HTMLは`data-i18n*`属性を使用し、動的なインターフェースメッセージは同じモジュールの`t()`ヘルパーを使用します。

サポートされる言語識別子は`en`、`ja`、`ko`、`fr`、`de`、`es`、`pt`です。ブラウザー言語検出とユーザー設定の動作は[機能](../../features/2026-07-30/features.ja.md#言語)に記載されています。

## プレビューキャプチャ

ルートREADME画像は、既定の英語読み取りモードのBrainVaultブラウザーUI（`public/index.html`および`public/app.js`）からキャプチャされます。`npm run db:seed`と同じ英語のサンプルワークスペースデータを使用します。

ローカルで再生成するには次を実行します。

```bash
npm run preview:capture
```

ChromiumまたはChromeが必要です。このコマンドは[`docs/assets/2026-08-09/preview.png`](../../assets/2026-08-09/preview.png)を更新します。

## 共同編集の実装

ブラウザーアダプターは`public/collaboration.js`です。アクセス／セッション／materializationルートは`src/routes/collaboration.routes.ts`、認証済みroomサーバーは`src/lib/collaboration-server.ts`、依存関係不要のRFC 6455トランスポートは`src/lib/websocket.ts`にあります。データベースオブジェクトは`migrations/020_page_sharing_yjs_collaboration.sql`で導入されます。

トランスポートを変更する際は、固定されたYjsブラウザーバージョン、CSP allowlist、プロトコルテスト、共同編集ドキュメントを同期してください。デプロイ前に`npm run verify:collaboration`、`npm run build`、`npm test`を実行してください。
