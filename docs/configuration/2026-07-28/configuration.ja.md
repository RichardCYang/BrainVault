# 設定

BrainVaultは環境変数からランタイム設定を読み取ります。ローカル開発では、`npm run env:init`で[`.env.example`](../../../.env.example)を`.env`へコピーするか、`npm run db:configure`を使って対話形式で`.env`を作成／更新してください。ファイルを変更せず新しい32バイト値を生成するには`npm run secrets:generate`を実行します。既存`.env`内の空欄または生成用プレースホルダーを埋めるには`-- --write`を指定します。

実際の`.env`ファイルは絶対にコミットしないでください。

## 環境変数

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `NODE_ENV` | サーバー起動に必須（`npm run dev`は`development`を設定） | ランタイム環境。本番デプロイでは`production`を明示的に設定する必要があります。 |
| `HOST` | `127.0.0.1` | バインドするネットワークアドレス。外部アクセスを意図する場合のみ`0.0.0.0`または`::`を設定します。 |
| `PORT` | `4000` | `off`/`proxy`モードのHTTPリスナーポート、または`posh-acme`モードのHTTPSリスナーポート |
| `DATABASE_URL` | 必須。`env:init`がパスワードを生成 | アプリが使用するMariaDB接続。空でなく既定値でもないパスワードが必要で、リモート本番ホストでは`?ssl=true`が必要です。 |
| `MARIADB_ADMIN_URL` | 未設定 | データベースおよび正確なホストのユーザー作成用の任意管理者接続。リモート本番ホストでは`?ssl=true`が必要です。 |
| `DB_USER_HOSTS` | `localhost,127.0.0.1,::1` | カンマ区切りの正確なMariaDBアカウントホスト。`%`および`_`ワイルドカードは拒否されます。 |
| `AUTO_BOOTSTRAP_DATABASE` | `true` | 待ち受け開始前にデータベースブートストラップを実行します。 |
| `DATABASE_CONNECTION_LIMIT` | `10` | データベースプールの最大サイズ。単一インスタンス安全leaseが専用MariaDB接続を1つ追加で使用します。 |
| `JWT_SECRET` | 本番以外ではランダムな一時値 | アクセストークン署名用シークレット。`env:init`は永続的なランダム値を書き込み、本番では明示的かつプレースホルダーでない値が必要です。 |
| `JWT_EXPIRES_IN` | `12h` | セッショントークンの有効期間。5分以上24時間以下である必要があります。 |
| `AUTH_ALLOW_BEARER_TOKENS` | `false` | 明示的に有効化した場合のみ互換用`Authorization: Bearer`セッションを許可します。ブラウザークライアントは`HttpOnly` Cookieを使用します。 |
| `MFA_ENCRYPTION_KEY` | 本番以外ではランダムな一時値 | TOTPシークレット暗号化用の独立したキーマテリアル。`env:init`は永続的なランダム値を書き込みます。 |
| `WEBAUTHN_RP_NAME` | `BrainVault` | パスキー登録時に表示される名前 |
| `WEBAUTHN_RP_ID` | `localhost` | schemeやportを含まないWebAuthn relying-partyドメイン |
| `WEBAUTHN_ORIGIN` | `http://localhost:4000` | WebAuthn応答で受け入れる正確なブラウザーoriginのカンマ区切り一覧 |
| `CORS_ORIGIN` | ローカル開発origin | API呼び出しを許可するブラウザーoriginのカンマ区切り一覧 |
| `PUBLIC_ORIGIN` | 最初の`WEBAUTHN_ORIGIN` | リダイレクトおよび直接証明書ホスト名検証に使用する正規のブラウザー公開origin。本番ではHTTPSが必要です。 |
| `HTTPS_MODE` | `off` | 開発／テストHTTPは`off`、信頼済みリバースプロキシTLSは`proxy`、Posh-ACME PEMファイルによる直接HTTPSは`posh-acme`。本番では`off`を拒否します。 |
| `POSH_ACME_CERT_PATH` | 未設定 | `posh-acme`モードで必須。orderディレクトリまたは`fullchain.cer`/`FullChainFile`パス |
| `POSH_ACME_KEY_PATH` | 同じディレクトリの`cert.key` | `posh-acme`モードでprivate keyパスを任意に上書きします。 |
| `HTTPS_REDIRECT` | プロキシモードで有効 | 認識されないHTTP要求に対するプロキシモードのリダイレクト。直接Posh-ACMEモードではHTTPSのみ開きます。 |
| `HTTPS_HEALTHCHECK_BYPASS` | `true` | プロキシモードの非公開バックエンドHTTPリスナーで`/health`を許可します。 |
| `REGISTRATION_ENABLED` | 本番以外では有効、本番では無効 | 公開登録要求を受け付けます。新規アカウントはサインイン前に`npm run registration:approve -- <username>`による独立した運用者承認が必要です。 |
| `SERVE_INTERNAL_DOCS` | `false` | リポジトリの`docs/`ディレクトリを認証済み`/docs`ルートで配信します。 |
| `COLLABORATION_ROOM_MEMORY_MAX_BYTES` | `536870912` | プロセス全体の保守的なresident-room/replay予約バイト。範囲96 MiB～4 GiB。RSS制限ではなく、トランスポートと検証workerの会計は別です。 |
| `RATE_LIMIT_WINDOW_MS` | `60000` | ミリ秒単位のrate-limitウィンドウ |
| `RATE_LIMIT_MAX` | `120` | グローバルウィンドウあたりの最大要求数 |
| `AI_CHAT_ANSWER_MAX_LENGTH` | `50000` | AIチャット回答ごとの最大Markdown文字数。許容範囲は1～500000で、ブラウザー／サーバーが同じランタイム値を共有します。 |
| `AUTH_LOGIN_IP_WINDOW_MS` | `900000` | ログインIP throttlingウィンドウ |
| `AUTH_LOGIN_IP_MAX` | `20` | IPウィンドウあたり許可される失敗ログイン要求数 |
| `AUTH_LOGIN_ACCOUNT_WINDOW_MS` | `21600000` | 正規化アカウントのログインthrottlingウィンドウ |
| `AUTH_LOGIN_ACCOUNT_MAX` | `30` | 送信元ネットワーク全体で正規化アカウントあたり許可される失敗またはMFA保留ログイン要求数 |
| `AUTH_LOGIN_LOCK_THRESHOLD` | `8` | 永続アカウントbackoff開始前のパスワード失敗回数 |
| `AUTH_LOGIN_LOCK_BASE_MS` | `30000` | 初期アカウントロック時間 |
| `AUTH_LOGIN_LOCK_MAX_MS` | `900000` | 指数的アカウントロックの最大時間 |
| `AUTH_LOGIN_FAILURE_RESET_MS` | `86400000` | 失敗回数の減衰間隔。アイドル間隔ごとに永続失敗を1件削除します。 |
| `AUTH_MFA_IP_WINDOW_MS` | `900000` | MFAログイン検証IPウィンドウ |
| `AUTH_MFA_IP_MAX` | `15` | IPウィンドウあたり許可される失敗MFAログイン検証数 |
| `AUTH_MFA_ACCOUNT_WINDOW_MS` | `3600000` | MFAログインアカウントウィンドウおよび失敗持越し間隔 |
| `AUTH_MFA_ACCOUNT_MAX` | `20` | アカウントウィンドウあたり許可される失敗MFAログイン検証数 |
| `AUTH_MFA_SETUP_WINDOW_MS` | `900000` | アカウントセキュリティ再認証およびMFA登録検証ウィンドウ |
| `AUTH_MFA_SETUP_MAX` | `10` | アカウント／ウィンドウあたり許可される現在パスワード再認証またはTOTP登録検証の失敗回数 |
| `AUTH_PASSKEY_OPTIONS_IP_WINDOW_MS` | `900000` | IPごとのユーザー名なしパスキーoption発行ウィンドウ |
| `AUTH_PASSKEY_OPTIONS_IP_MAX` | `30` | IPウィンドウあたり許可されるパスキーoption要求数。成功した発行もカウントします。 |
| `AUTH_PASSKEY_VERIFY_IP_WINDOW_MS` | `900000` | IPごとのユーザー名なしパスキー検証ウィンドウ |
| `AUTH_PASSKEY_VERIFY_IP_MAX` | `15` | IPウィンドウあたり許可される失敗パスキー検証数。成功した検証はカウントしません。 |
| `MFA_TOTP_WINDOW_STEPS` | `0` | 現在stepの前後で追加許可するTOTP step数。`0`は隣接stepの再利用を防ぎます。 |
| `AUTH_REGISTER_WINDOW_MS` | `3600000` | 登録throttlingウィンドウ |
| `AUTH_REGISTER_MAX` | `5` | IPウィンドウあたり許可される登録要求数 |
| `AUTH_REGISTER_GLOBAL_MAX` | `20` | プロセス全体ウィンドウあたり許可される登録要求数 |
| `TRUST_PROXY_ADDRESSES` | 空 | カンマ区切りのプロキシIP、狭いCIDR、または`loopback`。プロキシモードで必須です。 |
| `TRUST_PROXY_HOPS` | `0` | 互換性変数のみ。数値hop trustは無効化されており、この値は`0`のままにする必要があります。 |
| `BOOKMARK_PREVIEW_WINDOW_MS` | `60000` | 認証ユーザー専用ブックマークプレビュー制限ウィンドウ |
| `BOOKMARK_PREVIEW_MAX` | `12` | 認証ユーザー／ウィンドウあたり許可されるブックマークプレビュー要求数 |
| `BOOKMARK_FETCH_TIMEOUT_MS` | `8000` | OpenGraphページfetch 1回の最大時間 |
| `BOOKMARK_FETCH_MAX_BYTES` | `524288` | ブックマークプレビュー1件で検査する最大document-headバイト数 |
| `BOOKMARK_FETCH_ALLOWED_PORTS` | `80,443` | サーバー側ブックマークプレビューfetchに許可する宛先ポートのカンマ区切り一覧 |
| `BOOKMARK_FETCH_NAT64_PREFIXES` | 空 | `ipv4only.arpa`による成功したRFC 7050検出を補強する任意のRFC 6052 prefix。検出結果が不明な場合、prefixを設定していてもIPv6 fetch候補は常に除外します。 |
| `ATTACHMENT_UPLOAD_DIR` | `uploads` | 添付ファイルバイト用の非公開ディスクディレクトリ。起動時に公開Webルートとその配下を拒否します。 |
| `ATTACHMENT_TEMP_MAX_AGE_MS` | `86400000` | 非公開添付ファイルstagingディレクトリの古いファイルを起動時に削除する基準年齢 |
| `MAX_ATTACHMENT_SIZE_MB` | `25` | アップロード添付ファイル1件の最大サイズ（MB） |
| `ATTACHMENT_STORAGE_MAX_MB` | `2048` | アカウントあたりコミット済み添付ファイルバイトの最大値（MB）。アップロードとバックアップ復元に適用されます。 |
| `ATTACHMENT_UPLOAD_WINDOW_MS` | `60000` | 認証アカウントごとの専用添付ファイルアップロードadmissionウィンドウ |
| `ATTACHMENT_UPLOAD_MAX` | `12` | multipartバイトを受信する前にアカウント／ウィンドウあたり許可される添付ファイルアップロード要求数 |
| `ATTACHMENT_UPLOAD_MAX_CONCURRENT` | `4` | アプリケーションプロセス1つが同時処理する最大添付ファイルアップロード数。各アカウントもアクティブアップロード1件に制限されます。 |
| `DATA_TRANSFER_MAX_SIZE_MB` | `1024` | 完全データバックアップアーカイブ1件の最大サイズ（MB）。アップロード、ZIP内容、エクスポートstaging、最終エクスポート計画に適用されます。 |
| `DATA_TRANSFER_MAX_MANIFEST_SIZE_MB` | `16` | バックアップのエクスポート／インポート中にバッファリング・解析する最大JSON manifestサイズ |
| `DATA_EXPORT_WINDOW_MS` | `3600000` | 認証ユーザーごとの完全データエクスポート制限ウィンドウ |
| `DATA_EXPORT_MAX` | `20` | 認証ユーザー／ウィンドウあたり許可される完全データエクスポート数 |
| `DATA_IMPORT_WINDOW_MS` | `3600000` | 認証ユーザーまたはfallback IPキーごとの完全データインポート制限ウィンドウ |
| `DATA_IMPORT_MAX` | `3` | multipartアップロード処理前にprincipal／ウィンドウあたり許可される完全データインポート数 |
| `DATA_IMPORT_MAX_CONCURRENT` | `2` | アプリケーションプロセス1つが同時処理する最大インポート数。各principalもアクティブインポート1件に制限されます。 |

添付ファイルアップロードとインポートのadmission gateはプロセスローカル状態を使用します。そのためBrainVaultは起動時にデータベーススコープのアプリケーションインスタンスleaseを取得し、同じMariaDBデータベースに対して2つ目のアクティブアプリケーションプロセスを実行することを拒否します。これらのgate、要求rateカウンター、共同編集coordinationが共有／分散バックエンドへ移行されるまでは水平スケーリングはサポートされません。

## 開発ブラウザーの起動

`npm run dev`はサーバー準備完了後、必ずローカルアプリケーションをプライベート／シークレットブラウザーウィンドウで開きます。この動作は環境変数では制御されず、ランチャーは通常ブラウザープロファイルへフォールバックしません。自動起動はChrome、Edge、Firefox、Braveに対応します。以前の`BRAINVAULT_DEV_BROWSER_PRIVATE`変数は無視されるため、既存のローカル`.env`から削除できます。

## データベース動作

`AUTO_BOOTSTRAP_DATABASE=true`の場合、アプリケーション起動時に待ち受け開始前の対象データベース準備、ベースラインスキーマ調整、マイグレーション適用を試みます。

リモートデータベースホストでは接続URLに`?ssl=true`を追加してください。URLパーサーはこれをMariaDB Connector/Node.jsの`ssl`オプションとして渡します。本番ではTLSのない非ループバック`DATABASE_URL`および`MARIADB_ADMIN_URL`を拒否し、未対応URL query parameterは黙って無視せずfail-closedで失敗します。

アプリケーションアカウントがまだ存在しない、またはデータベース／ユーザーを自身で作成できない場合は`MARIADB_ADMIN_URL`を使用します。ブートストラップは各正確な`DB_USER_HOSTS`項目にアプリケーションアカウントを作成／更新し、対象スキーマに`SELECT`、`INSERT`、`UPDATE`、`DELETE`、`CREATE`、`ALTER`、`INDEX`、`DROP`、`REFERENCES`だけを付与し、ワイルドカードホスト`%`の同じユーザー名を削除します。スキーマ管理をアプリケーション外へ移すには次を設定します。

```env
AUTO_BOOTSTRAP_DATABASE=false
```

ブートストラップ手順とデータベースコマンドは[はじめに](../../getting-started/2026-07-27/getting-started.ja.md#データベースのブートストラップ)を参照してください。

## 本番環境の値

本番デプロイでは最低限、次の項目に一意な値を設定してください。

```env
NODE_ENV=production
HOST="127.0.0.1"
DATABASE_URL="mariadb://brainvault:use-a-unique-database-password@127.0.0.1:3306/brainvault"
DB_USER_HOSTS="localhost,127.0.0.1"
JWT_SECRET="replace-with-a-unique-secret-of-at-least-32-characters"
MFA_ENCRYPTION_KEY="replace-with-a-different-secret-of-at-least-32-characters"
WEBAUTHN_RP_ID="notes.example.com"
WEBAUTHN_ORIGIN="https://notes.example.com"
CORS_ORIGIN="https://notes.example.com"
PUBLIC_ORIGIN="https://notes.example.com"
HTTPS_MODE=proxy
HTTPS_REDIRECT=true
HTTPS_HEALTHCHECK_BYPASS=true
REGISTRATION_ENABLED=false
AUTH_ALLOW_BEARER_TOKENS=false
JWT_EXPIRES_IN="12h"
SERVE_INTERNAL_DOCS=false
TRUST_PROXY_ADDRESSES="loopback"
TRUST_PROXY_HOPS=0
```

別コンテナまたは別ホストのプロキシを使う場合は、`loopback`を正確なプロキシIPまたは可能な限り狭いCIDRへ置き換えます。`HTTPS_MODE=proxy`は`TRUST_PROXY_ADDRESSES`なしでは起動を拒否し、数値hop trustとcatch-all `/0` CIDRも拒否します。`PUBLIC_ORIGIN`はHTTPSであり、`WEBAUTHN_ORIGIN`と`CORS_ORIGIN`の両方に含まれている必要があります。バックエンドポートは非公開にしてください。

代わりにPosh-ACMEを使用してBrainVault自身でTLSを終端する場合、プロキシ固有の値を次へ置き換えます。

```env
HOST="0.0.0.0"
PORT=443
HTTPS_MODE=posh-acme
POSH_ACME_CERT_PATH="C:/Users/service-account/AppData/Local/Posh-ACME/.../fullchain.cer"
TRUST_PROXY_ADDRESSES=""
TRUST_PROXY_HOPS=0
```

`POSH_ACME_CERT_PATH`は証明書orderディレクトリまたは`fullchain.cer`そのものを指せます。`POSH_ACME_KEY_PATH`で上書きしない限り、BrainVaultは同じディレクトリの`cert.key`を読み込みます。証明書は`PUBLIC_ORIGIN`のホスト名を含み、現在有効で、private keyと一致する必要があります。ファイルは起動時に読み込まれるため、証明書更新後はBrainVaultを再起動してください。直接Posh-ACMEおよびリバースプロキシの例はリポジトリの[HTTPSデプロイガイド](../../../deploy/README.md)を参照してください。

`JWT_SECRET`と`MFA_ENCRYPTION_KEY`は異なる値である必要があります。既知のサンプル値と旧開発既定値は本番以外でも拒否されます。ユーザーがTOTPを登録した後に`MFA_ENCRYPTION_KEY`を不用意に変更しないでください。既存の暗号化済みauthenticatorシークレットはこのキーに依存しており、変更すると使用できなくなります。

## ブラウザーロックとsecure-context要件

安全性が重要なタブ間遷移—完全削除、アーカイブ、共有変更、直接ブロック削除、ワークスペース全体の復元—にはブラウザーWeb Locks APIが必要です。BrainVaultは原子的排他の代わりに`localStorage` leaseを使用しません。`navigator.locks`が利用できない場合、破壊的要求を送信する前に操作をブロックします。

本番環境はHTTPSで配信し、Web Locksをサポートするブラウザーを使用してください。`localhost`でのローカル開発では文書化されたHTTP URLを引き続き使用できます。APIがない場合でも通常編集は可能ですが、安全性が重要なpersistence-mode遷移はfail-closedで失敗します。

## WebSocketプロキシとYjs配信

リアルタイム共同編集はHTTP APIと同じ`PORT`、`CORS_ORIGIN`、JWT署名シークレットを使用します。別の共同編集プロセスやポートは不要です。直接Posh-ACMEモードでは同じネイティブHTTPSリスナー上でWebSocketアップグレードを処理します。本番リバースプロキシは`/api/collaboration/`のHTTP/1.1 WebSocketアップグレードをサポートし、ブラウザーoriginと元のhost/protocolヘッダーを転送する必要があります。プロキシモードでは、アプリケーションは信頼済み`X-Forwarded-Proto`値で外部HTTPS要求を認識します。forwarded hostヘッダーをブラウザーorigin認可やリダイレクト構築に使用することはありません。

付属の共同編集hubはプロセスローカルで、アクティブなアプリケーションプロセス1つとして実行することを意図しています。起動時にMariaDB advisory leaseでこのtopologyを強制し、同じデータベースに対して別BrainVaultアプリケーションプロセスが既にleaseを保持している場合はfail-closedで失敗します。水平スケーリングには共有rate/admissionストアに加え、すべてのインスタンスが同じroom履歴とpresenceイベントを観測できる共有pub/subおよび分散update coordinatorが必要です。

ブラウザーはlockfile管理の`yjs`、`lib0`、`isomorphic.js`パッケージを基盤とするsame-originルートから、正確な`yjs@13.6.31` ESMビルドを読み込みます。Mermaid `11.17.2`もBrainVault自身のoriginから配信されます。`npm run build`はまずダウンロードまたは`BRAINVAULT_MERMAID_TARBALL`を使用し、固定済みnpmパッケージSHA-512 digestを検証して、承認されたブラウザーバンドルとライセンスだけを抽出します。インラインimport mapは正確なCSP hashで許可されます。正確な`katex@0.17.0`アセットはSubresource Integrity付きのバージョン固定外部CDNパスのままです。Content Security Policyはsame-originスクリプト、そのimport-map hash、正確なKaTeXスクリプト、`CORS_ORIGIN`から導出した正確なWebSocket originだけを許可します。Mermaid CDNスクリプトソース、CDNホスト全体、任意の`ws:`/`wss:`宛先は許可しません。

完全な例は[共同編集](../../collaboration/2026-07-29/collaboration.ja.md#認証とネットワーク要件)および[HTTPSデプロイガイド](../../../deploy/README.md)を参照してください。
