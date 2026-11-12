[English](README.md) | [한국어](README.ko.md) | **日本語**

# HTTPSデプロイ

本番環境のBrainVaultは必ずHTTPSで提供してください。方法は2つあります。

- **直接HTTPS**：BrainVaultがPosh-ACMEで発行した証明書ファイルを使い、自身でTLSを処理します。
- **リバースプロキシ**：Caddy、NGINX、Nginx Proxy Manager、Synology DSMが公開TLSを処理し、内部HTTPでBrainVaultへ転送します。

## 目次

- [デプロイ方式の選択](#デプロイ方式の選択)
- [両方式に共通の設定](#両方式に共通の設定)
- [方式A. Posh-ACMEで直接HTTPSを提供](#方式a-posh-acmeで直接httpsを提供)
- [方式B. リバースプロキシ経由のHTTPS](#方式b-リバースプロキシ経由のhttps)
- [運用時の注意事項](#運用時の注意事項)
- [このディレクトリのファイル](#このディレクトリのファイル)

## デプロイ方式の選択

| | 直接HTTPS (`HTTPS_MODE=posh-acme`) | リバースプロキシ (`HTTPS_MODE=proxy`) |
| --- | --- | --- |
| TLSを処理するもの | BrainVault | プロキシ |
| BrainVaultの待ち受け | 公開HTTPS（例：`0.0.0.0:443`） | 内部HTTP（例：`127.0.0.1:4000`） |
| 証明書 | Posh-ACMEのファイル、起動時に読み込み | プロキシが管理 |
| HTTP→HTTPSリダイレクト | なし（80番ポートは使わない） | BrainVaultまたはプロキシが提供 |
| 入口でのリクエスト制限 | アプリケーションの制限のみ | プロキシの制限を追加可能（[後述](#公開入口のリクエスト制限)） |
| 向いている環境 | プロキシのない単一のWindowsホスト | ほとんどのデプロイ、NAS、コンテナ |

迷ったらリバースプロキシを使ってください。

<details>
<summary>初めての方へ：主な用語</summary>

| 用語 | 意味 |
| --- | --- |
| TLS / HTTPS | ブラウザとサーバー間の暗号化。ドメイン用の証明書が必要です。 |
| リバースプロキシ | BrainVaultの前で公開HTTPSリクエストを受け取り、BrainVaultへ転送するWebサーバー。 |
| Origin | サイトのプロトコル、ドメイン、ポートの組み合わせ。例：`https://notes.example.com` |
| WebSocket | リアルタイム共同編集に使う持続的な接続。プロキシがWebSocketの「アップグレード」を許可する必要があります。 |
| ループバック | 自分自身を指すアドレス（`127.0.0.1`）。同じマシン上のプログラムだけが接続できます。 |

</details>

## 両方式に共通の設定

どちらの方式でもサイトの公開URLが必要です。`notes.example.com`を実際のドメインに置き換えてください。

```env
NODE_ENV=production

PUBLIC_ORIGIN="https://notes.example.com"
WEBAUTHN_RP_ID="notes.example.com"
WEBAUTHN_ORIGIN="https://notes.example.com"
CORS_ORIGIN="https://notes.example.com"
```

`JWT_SECRET`は再起動しても変わらないように維持してください。この値は削除プレビューの署名にも使われるため、変更すると発行済みのプレビューが無効になり、削除前にプレビューを再取得する必要があります。署名方式の導入前に作成されたプレビューは`409 PAGE_EDIT_CONFLICT`で失敗します。

すべての環境変数は[設定ガイド](../docs/configuration/2026-07-28/configuration.ja.md)を参照してください。

## 方式A. Posh-ACMEで直接HTTPSを提供

### 1. 証明書ファイルの場所を確認

Posh-ACMEは証明書のorderフォルダーごとに`fullchain.cer`（証明書と発行チェーン）と`cert.key`（秘密鍵）を保存します。PowerShellで現在のorderのパスを確認します。

```powershell
Get-PACertificate | Format-List Subject,FullChainFile,KeyFile,NotAfter
```

### 2. BrainVaultを設定

[共通の設定](#両方式に共通の設定)に以下を追加します。`POSH_ACME_CERT_PATH`には、orderフォルダーまたは上で確認した`FullChainFile`のパスを指定できます。

```env
HOST="0.0.0.0"
PORT=443

HTTPS_MODE=posh-acme
POSH_ACME_CERT_PATH="C:/Users/service-account/AppData/Local/Posh-ACME/acme-v02.api.letsencrypt.org/example-order/fullchain.cer"
# 任意。デフォルトではfullchain.cerと同じ場所のcert.keyを読み込みます。
# POSH_ACME_KEY_PATH="D:/certificates/notes.example.com/cert.key"
```

- Windowsの`.env`のパスにはスラッシュ（`/`）を使い、バックスラッシュのエスケープ問題を避けてください。
- BrainVaultを実行するアカウントに、両方のファイルの読み取り権限が必要です。

### 3. 起動と確認

BrainVaultは起動時に、証明書が現在有効か、`PUBLIC_ORIGIN`のホスト名を含むか、秘密鍵と一致するかを確認します。ファイルがない、または不正な場合は、HTTPに切り替えずに起動を中止します。

ログに`Posh-ACME HTTPS mode enabled`と表示されるはずです。続いて以下を確認します。

```bash
curl -I https://notes.example.com/health
curl -I https://notes.example.com/
```

共同編集のWebSocketも同じHTTPSリスナーを使うため、追加の設定は不要です。

### 4. 証明書の更新後に再起動

証明書ファイルは起動時にしか読み込まれないため、Posh-ACMEが証明書を更新したらBrainVaultを再起動してください。たとえば、スケジュールされた更新タスクで次のようにします。

```powershell
Set-PAOrder notes.example.com
if (Submit-Renewal) {
    Restart-Service -Name BrainVault
}
```

> [!NOTE]
> この方式は`HOST`:`PORT`のHTTPSリスナーだけを開きます。80番ポートは使いません。HTTP→HTTPSリダイレクトが必要な場合は、ファイアウォール、ルーター、または別のリダイレクトサービスを使ってください。

## 方式B. リバースプロキシ経由のHTTPS

### 1. BrainVaultを設定

[共通の設定](#両方式に共通の設定)に以下を追加します。これは同じホストでプロキシを動かす場合の例です。

```env
HOST="127.0.0.1"
PORT=4000

HTTPS_MODE=proxy
HTTPS_REDIRECT=true
HTTPS_HEALTHCHECK_BYPASS=true
TRUST_PROXY_ADDRESSES="loopback"
TRUST_PROXY_HOPS=0
```

| 設定 | 役割 |
| --- | --- |
| `TRUST_PROXY_ADDRESSES` | 必須。このアドレスからのリクエストだけが`X-Forwarded-Proto`を指定できます。同じホストのプロキシには`loopback`を使います。別のコンテナやホストのプロキシには、正確なIPまたは実用上できるだけ狭いCIDRを指定してください。すべてを許可する`/0`の範囲は拒否されます。 |
| `TRUST_PROXY_HOPS` | 互換性のためだけに残っており、必ず`0`にします。バックエンドへより短い経路を持つクライアントが転送ヘッダーを偽造できるため、hop数による信頼は拒否されます。 |
| `HTTPS_REDIRECT` | `true`：通常のHTTPリクエストを`PUBLIC_ORIGIN`へ308でリダイレクトします。`false`：`426 HTTPS_REQUIRED`を返します。 |
| `HTTPS_HEALTHCHECK_BYPASS` | `true`：ローカル確認用に`/health`を内部HTTPで使えるようにします。 |
| `HOST` | プロキシから到達できるインターフェースだけにバインドしてください。4000番ポートを外部に公開しないでください。 |

### 2. プロキシを設定

どのプロキシでも次の3つが必要です。ドメインのTLS提供、`X-Forwarded-Proto: https`の転送、WebSocketアップグレードの許可（`/api/collaboration/`で使用）です。

#### Caddy

[Caddyfile.example](Caddyfile.example)をコピーし、ドメインとバックエンドのアドレスを変更してCaddyを再読み込みします。`reverse_proxy`が元のプロトコルを転送し、WebSocketアップグレードも自動で処理します。

#### NGINX

1. [nginx.conf.example](nginx.conf.example)の`log_format`、`map`、`limit_req_zone`の行と2つの`server`ブロックを`http`コンテキストにコピーします。
2. ドメインと証明書のパスを変更します。
3. `nginx -t`で検査してから再読み込みします。

例にある`Upgrade`と`Connection`ヘッダーは共同編集に必要です。例には[リクエスト制限](#公開入口のリクエスト制限)と[安全なログ設定](#プロキシのログに認証情報を残さない)も含まれています。

#### Nginx Proxy Manager

Proxy Hostを次のように作成します。

| 項目 | 値 |
| --- | --- |
| Domain | `notes.example.com` |
| Scheme | `http` |
| Forward host/IP | BrainVaultの内部アドレス |
| Forward port | `4000` |
| Websockets Support | 有効 |
| SSL certificate | 選択 |
| Force SSL | 有効 |

Nginx Proxy Managerは通常、転送用のホストとプロトコルのヘッダーを送ります。4000番ポートにはプロキシのネットワークからだけ接続できるようにしてください。

#### Synology DSMリバースプロキシ

1. **コントロールパネル → ログインポータル → 詳細設定 → リバースプロキシ**でルールを作成します。

   | 項目 | 値 |
   | --- | --- |
   | ソースプロトコル | `HTTPS` |
   | ソースホスト名 | `notes.example.com` |
   | ソースポート | `443` |
   | 宛先プロトコル | `HTTP` |
   | 宛先ホスト名 | `127.0.0.1`またはBrainVaultの内部アドレス |
   | 宛先ポート | `4000` |

2. **カスタムヘッダー**で**作成 → WebSocket**を選択します。
3. DSMのバージョンが自動で追加しない場合は、ヘッダー`X-Forwarded-Proto`を値`$scheme`で追加します。BrainVaultは信頼されたプロキシが`https`を伝えることを必須としています。
4. DSMで`notes.example.com`の証明書を割り当てます。
5. 任意：HTTPSへリダイレクトする別のHTTPソースルールを追加します。

宛先ポートは外部に公開しないでください。

### 3. 確認

ログに`HTTPS reverse-proxy mode enabled`と表示されるはずです。続いて以下を実行します。

| コマンド | 期待される結果 |
| --- | --- |
| `curl -I http://127.0.0.1:4000/health` | `200`（内部のヘルスチェック） |
| `curl -I -H 'Host: notes.example.com' http://127.0.0.1:4000/` | `308`（`HTTPS_REDIRECT=false`なら`426`） |
| `curl -I -H 'X-Forwarded-Proto: https' http://127.0.0.1:4000/` | `200`（信頼されたプロキシを模擬） |
| `curl -I https://notes.example.com/` | リダイレクトのループなしでアプリが表示される |

最後に、同じ共有ページを2つのブラウザウィンドウで開き、リアルタイム共同編集が動作することを確認します。

## 運用時の注意事項

### 公開入口のリクエスト制限

- **インスタンスは1つだけ実行してください。** アプリケーションのリクエスト制限カウンターはプロセスのメモリにあり、再起動するとリセットされます。BrainVaultは待ち受けを始める前にMariaDBデータベースのリース（lease）を取得し、同じデータベースで2つ目のプロセスが動作することを拒否します。水平スケーリングには対応していません。アップロード/インポートの受け入れ制御と共同編集の調整にも共有バックエンドが必要なため、プロキシの制限を追加してもこの制約は変わりません。
- **ログインのロックは別物です。** ログインのロックはデータベースに保存され、これらのカウンターの影響を受けません。
- **プロキシの制限はアプリの再起動後も維持されます。** NGINXの例は`/api/`にIPごとの制限を、`/api/auth/`と`/api/mfa/`にはより厳しい制限をかけ、HTTP 429を返します。静的ファイルと`/health`は対象外です。共有メモリーゾーンは1つのNGINX入口のすべてのworkerに適用されます。
- **制限値を調整してください。** 自動保存、共同編集の再接続、1つの共有NATの背後にいる多数のユーザーを考慮してください。[NGINX `limit_req`のドキュメント](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html)を参照してください。
- **すべてのバックエンドを内部に置き**、公開トラフィックが必ず制限を通るようにしてください。
- **信頼できない転送ヘッダーを制限のキーにしないでください。** NGINXの前に別の信頼されたプロキシがある場合は、そこで実際のクライアントIPの処理を設定してください。
- **例の限界を把握してください。** 入口のホストが複数ある場合は、共有のエッジ制限や共有ストアが必要です。この例にはRedis連携やアカウントごとのグローバル割り当てがなく、WebSocketのフレームではなくハンドシェイクだけを制限します。

### プロキシのログに認証情報を残さない

すべての入口で、次のヘッダーがアクセスログ、トレーシング、WAFのキャプチャ、エラー/デバッグログに残らないようにしてください。

- `Sec-WebSocket-Protocol`
- `Cookie`、`Set-Cookie`
- `Authorization`

共同編集のWebSocketサブプロトコルには、ページとセッションに結び付いた120秒間有効なチケットが含まれます（一致するセッションCookieも必要です）。チケットをCookieに移さないでください。Cookieもログから隠す必要があるのは同じで、1つの共有Cookieは複数のページタブ間で衝突します。現在の転送方式を維持し、ログの段階で隠してください。

NGINXの例は、クエリ文字列やヘッダーを記録しない最小限の`brainvault_safe`ログ形式をすでに使っています。本番環境で全ヘッダーのログ記録を有効にしないでください。

### パスワードログインのロック解除

パスワードの試行制限は、すべてのネットワークをまたいでアカウント単位で適用されます。そのため、アカウントIDを知っている人なら誰でも、そのアカウントのパスワードログインを一時的に妨げることができます。

| 制限 | 動作 |
| --- | --- |
| 保存されたロック | 30秒から始まり、期限切れ後に再び失敗すると延び、最大15分 |
| アカウントのリクエスト上限 | 別のデフォルト上限で、6時間維持 |

保存されたロックだけを消してもリクエスト上限は残り、分散型の推測攻撃への保護が弱まるだけです。復旧方法は次のとおりです。

1. **パスキー（推奨）。** 検出可能な（discoverable）パスキーを事前に登録してください。**パスキー**でのサインインは別の制限を使い、WebAuthn認証が検証されるとアカウントのパスワードカウンターと保存されたロックを解除します。
2. **既存のセッション。** サインイン済みのセッションから`POST /api/auth/login-lockout/reset`を呼び出せます。他のアカウントは解除できず、共有のIP上限もリセットしません。
3. **待つ。** パスキーもセッションもない場合は、制限が期限切れになるまでパスワードログインを待つ必要があります。

3の状況に備えて、運用者による復旧手順を用意してください。アカウントIDだけで動作する匿名のリセット機能は提供しないでください。

## このディレクトリのファイル

| ファイル | 内容 |
| --- | --- |
| [`README.md`](README.md) / [`README.ko.md`](README.ko.md) / `README.jp.md` | このHTTPSデプロイガイド |
| [`Caddyfile.example`](Caddyfile.example) | Caddyのリバースプロキシの例 |
| [`nginx.conf.example`](nginx.conf.example) | リダイレクト、WebSocket、リクエスト制限、安全なログを含むNGINXの例 |
