# ページ／コレクション共有とリアルタイム共同編集

BrainVaultは2つの共有スコープをサポートします。通常ページはページレベルの`EDIT`権限で既存アカウントに直接共有でき、**カスタムコレクション**は`READ`、`WRITE`、`ADMIN`権限で共有できます。どの権限によって文書へのアクセスが可能になったかに関係なく、共有された通常文書は同じYjs共同編集・復旧機構を使用します。

アーカイブ済みページではリアルタイム共同編集を開いたり新しい直接ページ権限を追加したりできませんが、アーカイブ中はリアルタイム共同編集だけが停止し、既存のアクセス権限は保持されるため、ページを復元するとアクセスを再有効化できます。仮想の**既定コレクション（Default Collection）**は共有可能なコレクションオブジェクトではありません。コレクション共有は永続化されたカスタムコレクションに適用されます。

## コレクション共有と権限

サイドバーでカスタムコレクションの**名前**をクリックして開きます。コレクションのランディングビューでは、所有者と`ADMIN`コレクション共同編集者に**ページ追加（Add page）**の横へ**コレクション共有（Share collection）**が表示されます。既定コレクション、個別文書を開いている場合、`READ`/`WRITE`共同編集者ではこのボタンは非表示です。

コレクション権限は、そのコレクションと、ネストされた子孫ページを含めmaterialized membershipがそのコレクションに属するすべての文書ページへ継承されます。コレクション内でページを作成すると現在の権限を継承します。ページサブツリーをコレクションの内外へ移動すると適用されるコレクション権限が変わり、影響を受けた共同編集lineageが置き換えられるため、古いroomが以前のメンバーシップによるアクセスを保持できません。

| 権限 | 実効ロール | 主な機能 |
| --- | --- | --- |
| `READ` | `READER` | コレクションを移動して文書を読み取ります。読み取り専用クライアントもライブYjs状態を受信できますが、バイナリ書き込みは`COLLABORATION_READ_ONLY`で拒否されます。 |
| `WRITE` | `EDITOR` | 読み取りに加え、共有文書のタイトル／ブロックやその他の書き込み可能な内容を編集します。共有管理やページ管理はできません。 |
| `ADMIN` | `ADMIN` | 読み書きに加え、コレクション範囲内で共有およびページ／コレクション管理を行います。管理者は共有コレクションの外へページを移動できません。 |

同じユーザーについては、直接ページ権限よりコレクション権限が優先されます。たとえばメンバーページに保存済みの直接`EDIT`権限があっても、コレクション`READ`権限があれば`READ`が優先されます。コレクションアクセスを削除すると、まだ有効な直接権限が再び優先権限になる場合があります。権限generationと対象ソケット切断により、遅延したクリーンアップが復活したアクセス権を取り消すことを防ぎます。

コレクションレコード自体はYjs共同編集文書ではありません。Yjsセッションは通常のメンバーページ上で実行されます。コレクションメタデータと共有管理は認証済みREST mutationを使用します。

UIの入口、ロール動作、継承、APIルート、バックアップ／復元、ボタンが表示されない一般的な理由に絞った説明は[コレクション共有](../2026-09-02/collection-sharing.ja.md)を参照してください。

## 共同編集フロー

1. 共有は通常ページの**共有（Share）**ダイアログ（`page_shares`、直接`EDIT`）またはカスタムコレクションの**コレクション共有（Share collection）**ダイアログ（`collection_shares`、`READ`/`WRITE`/`ADMIN`）から設定します。
2. 権限を持つ所有者または招待済み編集者が、`{ "documentEpochProtocol": 2 }`を指定して`POST /api/pages/:pageId/collaboration/session`を要求します。
3. サーバーは、有効期間が短くページに限定されたWebSocketチケット、正規データベーススナップショット、現在の`documentEpoch`、ソケットパス、必須の`brainvault-yjs-v2`サブプロトコルを返します。
4. ブラウザーは正確に同じ`documentEpoch`を持つローカル復旧更新だけを読み込み、ページタイトル、ブロック、ブロック順序、メタデータ、添付ファイル削除tombstoneを含むYjs文書を作成します。古いまたは不明なgenerationの復旧更新は手動復旧用としてブラウザーストレージに残り、自動ではマージされません。
5. バイナリYjs更新は認証済み`/api/collaboration/:pageId` WebSocketエンドポイントを通して送信されます。サーバーは信頼できない各更新を分離されたYjs文書へ適用し、不正または過大な状態を拒否し、受理した更新をMariaDBへ保存した後でのみ、ライブroom状態を入れ替え、確認応答を返し、ブロードキャストします。
6. presenceメッセージは参加中の共同編集者と、編集しているブロック／フィールドを表示します。Presenceは一時的で、データベースには書き込まれません。
7. ブラウザーは定期的に整合したYjsスナップショットを通常の`pages`および`blocks`テーブルへmaterializeします。そのため既存のREST読み取り、検索、レンダリング、エクスポート、バックアップは引き続き正規のリレーショナル表現を使用します。

新しく共有されたページに最初に参加する共同編集者は、サーバー提供のデータベーススナップショットからYjs履歴をブートストラップします。他のクライアントはその更新が受理されるまで待つため、別々の初期履歴ができることを防ぎます。再接続時は永続化された履歴を再生し、切断中に確認応答を失ったローカル文書状態を再送します。

## 永続化と整合性

マイグレーション`020_page_sharing_yjs_collaboration.sql`は次を追加します。

- 所有者管理の編集者権限用`page_shares`
- 順序付きバイナリ文書更新用`page_yjs_updates`
- 最後のリレーショナルmaterializationマーカー用`page_collaboration_state`

マイグレーション`021_collaboration_document_epoch.sql`は`page_collaboration_state`にnull不可の`document_epoch`を追加します。共有を無効化して再有効化する場合など、共同編集履歴を意図的にリセットするたびepochが更新されます。セッションチケット、WebSocket room、永続化更新、リレーショナルスナップショット、ブラウザー復旧レコードはすべてこのepochに結び付けられます。

マイグレーション`022_server_authoritative_collaboration_materialization.sql`は`materialization_version`を追加します。既存行の既定値はバージョン`0`で、旧ビルドではブラウザー提供の重複スナップショットによって更新マーカーが進んだ可能性があることを意味します。バージョン`1`は、更新済みサーバーがdurable Yjsログからリレーショナル状態を再構築した後にのみ書き込まれます。空でない履歴に対する破壊的操作や置換操作では、正確な最新更新マーカーと現在のprovenanceバージョンの両方が必要です。

マイグレーション`068_collection_sharing.sql`は、`READ`/`WRITE`/`ADMIN`権限と権限ごとのgenerationを持つ`collection_shares`、および各ページを支配するカスタムコレクションをmaterializeする`page_collection_memberships`を追加します。マイグレーションは既存ページ階層からメンバーシップを再帰的にバックフィルします。ランタイムの作成／移動／復元経路は、このmaterialized membershipを同期状態に保ちます。

Materialization要求で意味を持つ入力は、サーバー発行のdocument epochと最後に受信した更新IDだけです。更新IDはチェックポイントであり、別途提供されたタイトルやブロックデータがその更新に属することを証明するものではありません。サーバーはページとYjs履歴をロックし、置換済みgenerationまたは古いチェックポイントを拒否し、順序どおりに`page_yjs_updates`を再生して再構築文書をデコード・検証します。同時に存在する古い添付ファイルマップより添付ファイル削除tombstoneを優先し、偽造添付ファイルブロックを防ぎ、1つのトランザクションでタイトルとブロックを書き込み、最後に更新IDとprovenanceバージョンを記録します。旧ブラウザーフィールドは無視されます。Compactionはサーバー側Yjs文書で再エンコードした完全状態更新を永続化し、置換更新がコミットされた後でのみ古い更新行を削除します。

すべての通常更新およびcompaction書き込みは、ページと共同編集状態行をロックしたまま、roomのメモリ内`maxUpdateId`と永続化された`MAX(page_yjs_updates.id)`を比較します。他のアプリケーションプロセスがコミットした更新を取りこぼしたプロセスローカルroomは、挿入または履歴削除の前に無効化されます。接続中のクライアントは終了コード`1011`を受け、再接続して永続履歴を再生し、まだ確認応答されていない完全文書の復旧状態を再送します。スナップショット書き込みでは追加の正確な`baseUpdateId`チェックも維持されます。これはfail-closedな整合性fenceであり、プロセス間のリアルタイムfan-outを提供するものではありません。

通常文書の最後の実効共有権限が削除されると、BrainVaultは共同編集履歴を削除する前に、最新の受理済みYjs更新が現在のサーバー実装でmaterializeされていることを要求します。同じprovenance gateがアーカイブ、完全削除、エクスポート、ワークスペース復元を保護します。共同編集者の権限を削除または変更すると、影響する権限generationは直ちに無効化され、該当するアクティブソケットが閉じられます。アーカイブではroom全体を閉じますが、リアルタイム共同編集の停止中も権限は保持します。完全削除ではページとその権限を削除します。

## 文書置換とオフライン復旧

ワークスペース全体の復元、最後の共有権限削除、または後の初回共有では、同じページIDを再利用しながらYjs履歴を意図的に置き換える場合があります。そのためページIDだけでは安全な復旧境界になりません。BrainVaultは`documentEpoch`をgeneration fenceとして使用します。

- HTTPセッション応答と署名済みWebSocketチケットに現在のepochを含めます。
- WebSocketアップグレードはroomへ参加する前にそれを検証します。
- すべてのデータベース書き込みは、ページ／状態行のロックを保持したまま再確認します。
- スナップショットmaterializationにも同じepochが必要です。
- ローカルブラウザー復旧キーにはepochと元タブIDの両方を含めます。
- 旧形式または不一致の復旧レコードは、マージや上書きをせず別の復旧グループとして表示したままにします。

文書generationが変わると、接続中クライアントはWebSocket終了コード`4011`を受け取ります。確認応答されていないローカル状態は、ページ再読み込み前にgeneration固有のブラウザー復旧レコードへ残ります。セッション作成には`documentEpochProtocol: 2`が必要で、WebSocketアップグレードには`brainvault-yjs-v2`が必要です。この2つのバージョンfenceにより、修正前にキャッシュされたタブやローリング再起動の直前に発行されたチケットが、パッチ済みwriterへ再接続して古いSQL添付位置を再公開することを防ぎます。更新すると互換クライアントを読み込みつつ、古いブラウザー復旧レコードは手動確認用に保持します。

## 認証とネットワーク要件

WebSocketチケットは、認証済みユーザーID、ページID、document epochを含む短時間有効のJWTです。URLではなく専用WebSocketサブプロトコルとして送信されます。アップグレードハンドラーは次を確認します。

- 正確な共同編集パスとページID
- ブラウザー`Origin`が設定済みsame-origin/CORSポリシーと一致すること
- RFC 6455のバージョン、キー、プロトコル、マスキング、フレーム、メッセージ制限
- アップグレード前の現在ページアクセスと、接続中の定期的な再確認
- 接続ごとのフレーム／バイトレート制限

直接Posh-ACMEモードではネイティブHTTPSリスナー上の安全なWebSocketアップグレードを受け入れます。本番リバースプロキシは`/api/collaboration/`のWebSocketアップグレードを転送し、`Origin`、`Host`/`X-Forwarded-Host`、`X-Forwarded-Proto`を保持する必要があります。

組み込みroom fan-outはプロセスローカルです。BrainVaultはデータベーススコープの起動leaseにより、MariaDBデータベース1つにつきアクティブなアプリケーションプロセスを1つだけ許可します。そのため誤って2つ目のプロセスを起動すると、ネットワークトラフィックを受け付ける前に失敗します。共有rate/admissionストア、共有pub/sub backplane、分散room/update coordinationが実装されるまでは、マルチプロセスまたはマルチホスト配置はサポートされません。

プロキシモードでは、直接接続したプロキシが`TRUST_PROXY_ADDRESSES`と一致する必要があります。数値によるhop trustは拒否されます。BrainVaultはそのpeerからの正規`X-Forwarded-Proto: https`値を1つだけ認識し、安全なセッションCookieを保持し、公開ページURLから`wss:`ブラウザー接続を導出します。平文バックエンドHTTP要求は`HTTPS_REDIRECT`に応じて固定`PUBLIC_ORIGIN`へリダイレクトされるか拒否されます。Posh-ACMEモードではリスナー自体がHTTPSのため、forwarded-protocol信頼は不要です。

直接Posh-ACMEと完全なCaddy、NGINX、Nginx Proxy Manager、Synology DSM設定はリポジトリの[HTTPSデプロイガイド](../../../deploy/README.md)にあります。付属NGINX例は共有locationでWebSocketアップグレードヘッダーを転送するため、通常API要求と`/api/collaboration/`が同じバックエンドポートを使用します。

ブラウザーは`/vendor/yjs/yjs.mjs`から固定済み`yjs@13.6.31` ESMビルドを読み込みます。BrainVaultはlockfileで制御された`yjs`、`lib0`、`isomorphic.js`パッケージのJavaScriptモジュールファイルだけを公開し、CSPハッシュ付きインラインimport mapがYjsのbare module specifierを同一originのルートへ解決します。サードパーティYjs CDNへのアクセスは不要です。これらのsame-originモジュールURLはcontent-versionedではなく安定URLのため、長期`immutable`キャッシュではなく再利用時に再検証が必要です。これにより新規タブがデプロイ前の共同編集ランタイムを保持し続けることを防ぎます。

## 検証

Node.js 22.x系では22.23.2以降、Node.js 24.x系では24.18.1以降、またはNode.js 26.5.1以降で、共同編集専用の決定的チェックを実行します。

```bash
npm run reproduce:materialization-loss
npm run reproduce:cross-instance-loss
npm run reproduce:recovery-write-loss
npm run reproduce:attachment-position-loss
npm run test:durability
npm run verify:collaboration
npm run verify:data-loss
```

Materialization再現は、リレーショナルな正規状態がロック済みdurable Yjs履歴から再構築されることを証明します。Cross-instance再現は、古いプロセスローカルroomがより新しいdurable tipの上へappendまたはcompactできないことを証明します。Recovery-write再現は、ブラウザー編集が可視化前に永続化されることを検証します。Attachment-position再現は、リレーショナルmaterialization前に再接続しても、確認済みYjs移動の上へ古いSQL parent/orderフィールドを再公開しなくなったこと、かつ正規ファイルメタデータはサーバー所有のままであることを証明します。共同編集検証は、4つの損失スケジュール、プロトコルバージョンfencing、ソース配線、正確なYjs依存関係pinと整合性、materialization provenance、durable-roomの鮮度、実行可能なすべてのプロジェクトJavaScript/TypeScript構文、ブロック階層不変条件、RFC 6455 handshake accept値、マスク済みテキスト／バイナリフレーム、断片化メッセージ、Ping/Pong動作、JSONサーバーフレーム、未マスククライアントフレームの拒否を確認します。Vitestスイートにはサーバー側Yjsマージ、materialization、分離、不正更新、サイズ制限、write-checkpointテストも含まれます。

通常のプロジェクトチェックは次のとおりです。

```bash
npm run build
npm test
```
