[English](network-verification.md) | [한국어](network-verification.ko.md) | **日本語**

# VPN／プロキシのブロックに使うTCP/WebSocket測定

検出機能は、HTTPSの入口で測定した元のクライアントのTCP RTTと、サーバーで測定したWebSocketの往復時間を比較します。測定用の外部リクエストや別プロセスの起動は行いません。ICMP、ping実行ファイル、raw socket、地理的な基準サーバー、WebRTCによるアドレス検出、VPN評価サービスは使用しません。この機能のためにコンテナへ`NET_RAW`、`NET_ADMIN`、privilegedモード、pingパッケージを追加する必要はありません。

## Synology DSM：HTTPSの入口からHTTPコンテナへ転送

対応するデプロイ経路は次のとおりです。

```text
ブラウザ -- HTTPS/WSS --> Synology DSMリバースプロキシ -- HTTP/WS --> BrainVaultコンテナ
           クライアントTCP RTTの測定区間              WebSocketは経路全体を測定
```

TCP測定値は、WebSocketアップグレード要求を運ぶ同じクライアント接続の**ブラウザ↔DSM間**を表す必要があります。コンテナのソケットを測定するとDSM↔コンテナ間だけの値になり、誤検出の原因になります。NAS/DockerのアドレスがプライベートIPであるという理由だけで検証不能になるわけではありません。比較には、実際の公開クライアントアドレスと有効な入口側のTCP情報が必要です。

DSMの**コントロールパネル > ログインポータル > 詳細設定 > リバースプロキシ**でBrainVaultのルールを編集します。送信元はHTTPS、送信先は内部コンテナのHTTPアドレスにします。**カスタムヘッダー**で**作成 > WebSocket**を選択します。`Origin`を保持し、既存の信頼された転送経路を通じて`X-Forwarded-Proto: https`と実際のクライアントアドレスを渡します。WebSocketとカスタムヘッダーの設定はSynologyの[DSMリバースプロキシガイド](https://kb.synology.com/en-in/DSM/help/DSM/AdminCenter/system_login_portal_advanced)でも確認できます。

HTTPSの入口で次の**リクエストヘッダー**を設定し、受信した既存の値を上書きします。

| ヘッダー | NGINXの値 | 用途 |
| --- | --- | --- |
| `X-BrainVault-TCP-Peer-IP` | `$remote_addr` | クライアント接続の実際のTCP接続相手のアドレス |
| `X-BrainVault-TCP-RTT-Us` | `$tcpinfo_rtt` | カーネルが測定したTCP RTT、マイクロ秒単位 |
| `X-BrainVault-TCP-RTTVar-Us` | `$tcpinfo_rttvar` | カーネルが測定したTCP RTTの変動値、マイクロ秒単位 |

これらの変数はNGINXの[TCP_INFO対応](https://nginx.org/en/docs/http/ngx_http_core_module.html#var_tcpinfo_rtt)を使用します。[NGINXの実装](https://github.com/nginx/nginx/blob/master/src/http/ngx_http_variables.c)は、カーネルのRTTと変動値をマイクロ秒単位で渡します。対応状況はDSMのバージョンやビルドによって異なります。カスタムヘッダーの設定画面があるだけでは、変数が利用可能であることや、実際の値へ展開されることは保証されません。生成されたプロキシ設定で変数が評価され、WebSocketアップグレード要求のヘッダーが数値としてバックエンドに届くことを確認してください。文字列のままの`$tcpinfo_rtt`、空の値、RTTが0の値は拒否されます。固定のRTT値で代用しないでください。DSMのビルドがTCP_INFOを提供できない場合、元のクライアント接続を受ける入口でTCP_INFOに対応する必要があります。DSMの**後段**にNGINXを追加しても元の接続情報は復元できません。このリポジトリの変更によってNAS自体の設定が変更されることはありません。

同等のNGINX設定は[nginx.conf.example](nginx.conf.example)にあります。NGINXの`real_ip`が`$remote_addr`を書き換える場合は、`X-BrainVault-TCP-Peer-IP`に`$realip_remote_addr`を使い、元のTCP接続相手を保持します。このアドレスは、検証済みのクライアントIPと一致する必要があります。DSMの前段にCDNやTCP接続を終端する別のプロキシがあると、DSMが測定する接続は変わります。CDNのクライアントIPヘッダーを転送しても、DSMのTCP RTTがブラウザのRTTになるわけではありません。一致しない測定情報は拒否されます。

3つのヘッダーが正しく生成され、既存の値が上書きされることを確認した後、コンテナから実際に見えるプロキシアドレスに合わせて設定します。

```env
HTTPS_MODE=proxy
PUBLIC_ORIGIN="https://notes.example.com"
TRUST_PROXY_ADDRESSES="172.18.0.1"
TRUST_PROXY_HOPS=0
TRUST_PROXY_ALLOW_PRIVATE_CLIENTS=false
VPN_TRUST_PROXY_TCP_INFO=true
VPN_PROXY_RTT_MARGIN_MS=10
VPN_MIN_EXCESS_RTT_MS=50
```

プロキシの信頼範囲は実用上可能な限り狭くし、コンテナのHTTPポートを外部へ公開しないでください。通常のプロキシは攻撃者が送ったカスタムヘッダーをそのまま転送できるため、TCP_INFOの信頼設定はデフォルトで**false**です。上書きルールを設定した後にだけ有効にしてください。重複ヘッダー、不正な値、信頼されていない接続相手、HTTPS以外の転送、無効な転送経路、TCP接続相手とクライアントIPの不一致は、TCP測定の根拠として認められません。`/api/network-verification/probe`と`/api/collaboration/`の両方でWebSocketアップグレードを転送してください。

アカウントのセキュリティ設定で**接続を再測定**を使用します。設定が正常な場合、**信頼された入口で測定したクライアントTCP RTT**と、測定したWebSocket/TCP RTTが表示されます。画面では、TCP情報の利用が無効な状態、TCP RTTの欠落、クライアント情報の不一致を区別します。外部ネットワークから接続して確認してください。意図されたローカルネットワークの例外によってアクセスできても、公開入口の設定が検証されたことにはなりません。認証前のAPIでは測定値や判定のしきい値を公開しません。

## 測定と判定

ブラウザは同一オリジンの使い捨てチケットを要求し、`/api/network-verification/probe`へ接続します。サーバーはそのアップグレード要求のTCP_INFOメタデータを取得し、予測不能なWebSocketプロトコルのpingフレームを12回送信して、一致するpong応答の往復時間を単調時計で測定します。これらはTCP上のWebSocket制御フレームであり、ネットワークのICMPパケットではありません。ブラウザが提出するのは内容を解釈できない完了トークンだけで、クライアントが申告するRTTや判定は無視します。

6サンプルずつの連続する2つのWebSocket測定区間を、入口で取得した実際のTCPスナップショットと比較します。両区間とも、TCP RTTに設定された最小追加遅延、ローカルプロキシの許容誤差、TCP RTT変動値の3倍を加えた基準を超える場合に`TUNNEL`と判定します。RTTが高いだけでは検出しません。WebSocketの遅延が不安定な場合、TCPの変動が大きい場合、推定値が整合しない場合は`INCONCLUSIVE`です。TCP測定の根拠がない場合は`UNKNOWN`とし、完了したWebSocketサンプルは保持します。1つのTCPスナップショットを、複数の独立したトランスポート測定として扱うことはありません。

測定の完了後、使い捨ての完了トークンを、HttpOnly、SameSite=Strict属性を持つ不透明なCookieと交換します。HTTPSではSecure属性と`__Host-`プレフィックスも使用します。測定結果はブラウザ別の識別子と、正確に正規化されたクライアントIPに結び付けられ、5分後に期限切れになります。ページが表示されている間は定期的に更新されます。同じNATを共有する別のブラウザ間で判定を共有することはありません。パスワードログイン、MFA、パスキー、認証済みリクエスト、共同編集の再検証で、この測定結果を適用します。

## ポリシーと制限

| 設定 | デフォルト | 意味 |
| --- | --- | --- |
| `VPN_TRUST_PROXY_TCP_INFO` | `false` | 明示的に信頼したローカルHTTPS入口が上書きして渡すTCP_INFOを使用 |
| `VPN_MIN_EXCESS_RTT_MS` | `50` | 繰り返し観測する必要のある最小追加遅延。ミリ秒単位であり、信頼度の百分率ではない |
| `VPN_PROXY_RTT_MARGIN_MS` | `10` | ローカルリバースプロキシ区間の追加許容誤差 |
| `VPN_ALLOW_PRIVATE_NETWORK` | `true` | 直接のLANアクセスを維持。転送されるプライベートクライアントには`TRUST_PROXY_ALLOW_PRIVATE_CLIENTS=true`も必要 |
| `VPN_POLICY_FAIL_CLOSED` | `true` | ブロックを有効にしたアカウントで測定の根拠がない場合にアクセスを拒否 |

測定不能はトンネル検出とは異なります。ただしfail-closedが有効な場合、アカウントのブロックポリシーに従ってアクセスが拒否されることがあります。falseの場合は測定失敗時のアクセスを許可しますが、検出されたトンネルのブロックは解除しません。ブロックを無効にしたアカウントは引き続きアクセスできます。現在の接続を直ちにブロックするポリシーの有効化は拒否します。既存のパスワード/MFA再認証とセッション失効の保護も適用されます。過去のブロック記録と、別機能の国別ログイン制限も引き続き参照できます。

リソース制限は、全体で32個のアクティブな測定ソケット、送信元IPごとに4個、送信元IPごとに毎分30枚のチケット、サイズと有効期限を制限したマップ、12秒の測定期限、12個のWebSocketサンプルです。チケットを含むサブプロトコル、完了トークン、Cookieをログに残してはいけません。ブラウザの測定が失敗すると、後続の保護されたリクエストが約20秒遅延する場合があります。追加のコンテナ権限や外部の基準サーバーリストは不要です。

## 検出範囲

この比較は、中継地点でTCP接続が分割され、WebSocketストリームがブラウザまで継続する場合に、安定して繰り返される追加経路の遅延を検出できることがあります。住宅用IPを使うすべてのVPNを確実に識別できるわけではありません。WireGuard/OpenVPNなどのトンネルはクライアントのTCP接続をエンドツーエンドで転送できるため、TCP RTTとWebSocket RTTが同時に増加する場合があります。近距離の中継サーバーや、WebSocket制御フレームへ直接応答する中継サーバーも、この比較を回避できる場合があります。`CLEAR`はTCP/WebSocket間に追加の遅延差が観測されなかったことを示し、VPNが存在しないことを保証しません。ネットワーク負荷と入口側の処理スケジュールは、両方の測定値に影響します。直接接続、モバイル、混雑回線、ローカルプロキシ、住宅用IPのVPNを区別した実際のトラフィックで調整し、誤検出率と測定根拠を取得できる割合を別々に評価してください。デプロイ環境の検出精度を百分率で保証するものではありません。

Node.jsがHTTPSを直接提供するモードには、現在WebSocket測定のみがあり、ネイティブのTCP_INFO収集機能はありません。この場合は`DIRECT_TCP_INFO_UNAVAILABLE`と表示し、リクエストヘッダーをカーネルのソケットデータの代わりに使用することはできません。実装済みのTCP収集経路は、上記のDSM/NGINXを入口とするデプロイ構成を対象としています。
