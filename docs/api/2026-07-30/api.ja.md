# API

ほとんどのAPIルートでは、`HttpOnly`、`SameSite=Strict`属性の`brainvault_session` Cookieを使用します。HTTPSデプロイが設定されている場合、Cookieには`Secure`が付与され、互換用bearerセッションは本番環境で既定で無効です。パスワードログイン、直接passkeyログイン、MFA完了はJWTをJSONで返さず、組み込みブラウザクライアントも`localStorage`に保存しません。MFAが有効なアカウントはパスワードログイン時に一時的なopaque MFAセッションを受け取り、TOTPまたはpasskeyチャレンジを完了した後にのみ通常の認証Cookieを受け取ります。代わりに、discoverable passkeyを使ってサインイン画面から別のユーザー名なしプライマリログインceremonyを直接完了することもできます。

## ルート概要

| メソッド | ルート | 説明 |
| --- | --- | --- |
| `POST` | `/api/auth/register` | アカウント作成を送信します。有効な新規IDでも既存IDでも常に同じ受付応答を返します。 |
| `POST` | `/api/auth/login` | サインインします。Cookie認証済みユーザー応答または一時MFAセッションを返します。 |
| `POST` | `/api/auth/passkey/options` | ユーザー名なしdiscoverable-passkeyオプションと、ブラウザにバインドされたワンタイムチャレンジトークンを作成します。 |
| `POST` | `/api/auth/passkey/verify` | discoverable passkeyを検証し、通常の`HttpOnly`セッションCookieを作成します。 |
| `POST` | `/api/auth/logout` | アカウント認証generationを失効させ、ブラウザセッションCookieを消去します。 |
| `GET` | `/api/auth/mfa/status` | 設定済みTOTPおよびpasskey方式を取得します。 |
| `POST` | `/api/auth/mfa/totp/setup` | 現在のパスワードで保護されたTOTP登録を開始します。 |
| `POST` | `/api/auth/mfa/totp/verify` | 保留中のTOTP登録を確認して有効化します。 |
| `DELETE` | `/api/auth/mfa/totp` | 現在のパスワード確認後にTOTPを無効化します。 |
| `POST` | `/api/auth/mfa/passkeys/options` | 現在のパスワードで保護されたpasskey登録を開始します。 |
| `POST` | `/api/auth/mfa/passkeys` | passkey資格情報を検証して保存します。 |
| `PATCH` | `/api/auth/mfa/passkeys/:id` | 登録済みpasskeyの名前を変更します。 |
| `DELETE` | `/api/auth/mfa/passkeys/:id` | 現在のパスワード確認後にpasskeyを削除します。 |
| `POST` | `/api/auth/mfa/login/totp` | TOTPコードで保留中ログインを完了します。 |
| `POST` | `/api/auth/mfa/login/passkey/options` | passkey認証チャレンジを作成します。 |
| `POST` | `/api/auth/mfa/login/passkey/verify` | passkeyを検証してログインを完了します。 |
| `GET` | `/api/auth/me` | 現在のユーザーを取得します。 |
| `GET` | `/api/auth/login-history?months=3` | 現在のユーザーの成功・失敗ログイン試行を新しい順に取得します。1～12か月を指定できます。 |
| `PATCH` | `/api/auth/profile` | 表示名、プロフィール画像、または優先言語を更新します。 |
| `POST` | `/api/auth/password` | 現在のパスワードを確認した後、パスワードを変更します。 |
| `GET` | `/api/pages` | ページ一覧を取得します。 |
| `POST` | `/api/pages` | ページを作成します。クライアントは`mutationId`を指定でき、結果が不明確だった後の完全に同一の再試行に限って再利用できます。 |
| `GET` | `/api/pages/:pageId` | ページとそのブロックツリーを取得します。 |
| `PATCH` | `/api/pages/:pageId` | ページメタデータを更新します。 |
| `DELETE` | `/api/pages/:pageId` | ページをアーカイブまたは完全削除します。 |
| `GET` | `/api/pages/:pageId/shares` | 直接ページ`EDIT`権限を一覧表示します。ページ所有者または実効`ADMIN`のみです。 |
| `POST` | `/api/pages/:pageId/shares` | 既存ユーザーを直接ページ編集者として追加します。ページ所有者のみです。 |
| `DELETE` | `/api/pages/:pageId/shares/:userId` | 直接ページ編集者を削除し、置き換えられたgrant generationのソケットを閉じます。ページ所有者または実効`ADMIN`のみです。 |
| `GET` | `/api/collections/:collectionId/shares` | カスタムコレクションの`READ`/`WRITE`/`ADMIN`権限を一覧表示します。所有者またはコレクション`ADMIN`のみです。 |
| `POST` | `/api/collections/:collectionId/shares` | 既存アカウントをカスタムコレクションに`READ`、`WRITE`、`ADMIN`のいずれかで追加します。 |
| `PATCH` | `/api/collections/:collectionId/shares/:userId` | 現在のgenerationトークンを使用してコレクション権限を変更します。 |
| `DELETE` | `/api/collections/:collectionId/shares/:userId` | 現在のgenerationトークンを使用してコレクション権限を削除します。 |
| `POST` | `/api/pages/:pageId/collaboration/session` | 短寿命のページスコープWebSocketチケットとcanonicalスナップショットを発行します。`{ "documentEpochProtocol": 2 }`が必要です。 |
| `PUT` | `/api/pages/:pageId/collaboration/snapshot` | ロックされた永続Yjsログをページ／ブロックテーブルへmaterializeします。要求本文の内容は信頼しません。 |
| `WS` | `/api/collaboration/:pageId` | 認証済みバイナリYjs更新とJSON presence/controlメッセージを処理します。 |
| `POST` | `/api/pages/:pageId/blocks` | 添付ではないブロックを追加します。結果が不明確な完全再試行では`mutationId`を再利用します。 |
| `POST` | `/api/bookmarks/preview` | 専用の認証ユーザーrate limitの下でブックマークOpenGraphメタデータを取得するか、`mode: "database-url"`指定時にデータベースURL文書の`<title>`/faviconメタデータを取得します。 |
| `POST` | `/api/pages/:pageId/attachments` | 検査済みファイルをアップロードし、添付ブロックを作成します。multipartバイトが一時ストレージに到達する前にアクセス、ページ状態、要求サイズ、rate、同時実行admissionを確認し、結果が不明確な完全再試行では`mutationId`を再利用します。 |
| `PATCH` | `/api/blocks/:blockId` | ブロックを更新します。 |
| `DELETE` | `/api/blocks/:blockId` | 正確なバージョンスナップショットと必須mutation IDを使ってブロックとその子孫を削除します。 |
| `GET` | `/api/blocks/:blockId/attachment` | 現在のページアクセスを確認し、強制dispositionとactive-content応答強化を適用した後に添付をダウンロードします。 |
| `GET` | `/api/data/export` | ユーザー単位rate limitの下で完全なZIPバックアップをストリーミングします。協力者アカウントIDとユーザー名にバインドされたページ／コレクション共有権限も含みます。 |
| `POST` | `/api/data/import` | BrainVaultバックアップZIPを検証して復元します。IDにバインドされたページ／コレクション権限を再作成し、互換性のあるlegacy権限は検証済みの現在のidentityを介してのみ保持します。 |
| `POST` | `/api/pages/:pageId/blocks/reorder` | ブロックを移動または並べ替えます。 |
| `GET` | `/api/pages/:pageId/render` | sanitize済みページHTMLをレンダリングします。 |
| `GET` | `/api/pages/:pageId/versions` | 所有者専用ページバージョン履歴を一覧表示します。過去エントリには削除済み内容が含まれる場合があります。 |
| `GET` | `/api/pages/:pageId/versions/:versionId` | 所有者専用ページバージョンエントリを1件取得します。 |
| `DELETE` | `/api/pages/:pageId/versions` | 冪等性キーと、所有者が確認した正確なページ／コンテンツ／履歴バージョンを使用し、所有者専用ページバージョン履歴を一度リセットします。 |
| `GET` | `/api/search?q=...` | タイトルとブロックMarkdownを検索します。 |

`GET /api/pages`は安定したkeyset paginationを使用し、要求ごとに最大500行を受け付けます。オプションの`compact=true`モードはワークスペースナビゲーション走査向けで、階層、アクセス、共同編集、タグ、カーソル動作を維持しつつ、繰り返しの所有者プロフィールデータとページごとのブロック／子数を省略します。後方互換性のため既定値は完全応答のままです。UIはさらに`navigation=true`を送信します。この明示的opt-inではナビゲーションがページタグを描画しないためタグenrichmentを省略しますが、タグフィルタリングは引き続き適用されます。`navigation=true`を省略すると既存のcompact応答を正確に維持します。

## コレクション共有API

コレクション共有は永続化されたカスタムコレクションにのみ適用されます。仮想Default Collectionには共有可能なコレクションレコードがありません。`/api/collections/:collectionId/shares`配下の`GET`、`POST`、`PATCH`、`DELETE`はすべて、コレクションを管理できる認証済み呼び出し元（所有者または実効`ADMIN`）を必要とします。

`POST /api/collections/:collectionId/shares`は既存の`username`と、`READ`、`WRITE`、`ADMIN`のいずれかの`permission`を受け付けます。権限は`page_collection_memberships`を通して現在の全メンバーページに適用されます。文書が初めて実効共有状態になると、BrainVaultはそのcanonical SQLスナップショットから新しいYjs共同編集lineageを初期化します。同じユーザーに対してはコレクション権限が直接ページ`EDIT`権限より優先されるため、新しい`READ`コレクション権限が存在する間、そのユーザーのメンバーページ実効アクセスは読み取り専用に下がります。

`PATCH /api/collections/:collectionId/shares/:userId`と`DELETE /api/collections/:collectionId/shares/:userId`には、現在の権限とともに返された`generation`である`expectedGeneration`が必要です。サーバーは権限変更時にgenerationをローテーションし、古い操作を`409 COLLECTION_SHARE_GENERATION_CHANGED`で拒否します。`WRITE`/`ADMIN`から`READ`への降格や削除では、書き込み権限を失効させる前に復旧状態を保持し、アクティブな共同編集書き込みをfenceします。

コレクションアクセスを削除すると、まず失効する管理者が作成したメンバーページ直接権限を削除し、その後すべてのメンバー文書の実効共有集合を再計算します。所有者が独立して作成した直接ページ権限は再び有効になる場合があります。共同編集履歴は最終実効共有がなくなった文書についてのみ、かつ最新の受理済みYjs更新を安全にmaterializeした後にのみ破棄されます。

UIの入口と詳細なロール／継承動作については[コレクション共有](../../collaboration/2026-09-02/collection-sharing.ja.md)を参照してください。

## ページ作成再試行の整合性

`POST /api/pages`はオプションの`mutationId`（ASCII英字、数字、`_`、`-`の1～64文字）を受け付けます。サーバーはページ、初期ブロック、タグ、作成履歴エントリと同じトランザクションで、所有者スコープのmutation receiptを予約します。同じIDで完全に同じ本文を再試行すると元のページを返します。異なる内容でIDを再利用すると`409 MUTATION_ID_REUSED`で拒否されます。元のページが後で完全削除された場合は、黙って代替ページを作成せずreplayを拒否します。

`DELETE /api/pages/:pageId?permanent=true`には最新の`expectedSnapshot`と`mutationId`（ASCII英字、数字、`_`、`-`の1～64文字）の両方が必要です。削除receiptはサブツリー削除と同じトランザクションでコミットされ、削除済みページ行がなくなった後も意図的に残ります。データベースcommitは成功したもののHTTP結果が失われた場合、同じmutation IDで同一要求を再試行すると削除を繰り返さず成功を返します。別の要求にmutation IDを再利用すると`409 MUTATION_ID_REUSED`で拒否されます。

## ブロック／添付作成再試行の整合性

`POST /api/pages/:pageId/blocks`とmultipart `POST /api/pages/:pageId/attachments`はオプションの`mutationId`（ASCII英字、数字、`_`、`-`の1～64文字）を受け付けます。サーバーはブロック挿入前に同じトランザクションで`(actor_id, mutation_id)`を予約し、添付要求ではアップロードファイルを永続パスへ移動する前にreceiptを予約します。完全な再試行は別の履歴エントリを追加したり、ページコンテンツバージョンを再び進めたり、添付ファイルをもう1つ保存したりせず、元のブロックを返します。

アーカイブ済みページは、直接ページメタデータ／タグおよびブロックの作成・更新・削除・並べ替えmutationについてサーバー側で読み取り専用です。まずページを復元してください。アーカイブ中に受理される唯一のページ更新は`isArchived: false`だけを含む復元専用`PATCH /api/pages/:pageId`です。新たな書き込みを行わない完全な冪等replayは引き続き安全に承認できます。

添付アップロードでは、Multerが一時ファイルを開く前にページアクセス、共同編集モード、アーカイブ状態、宣言要求サイズ、アカウント別rate、プロセスローカル同時実行を解決します。受信後のトランザクションでも認可とページ状態を再確認するため、同時に所有権、共有、アーカイブ状態が変化した場合は永続保存またはブロック作成前にfail closedします。

要求ハッシュにはページ、ブロックpayload、操作種別が含まれます。添付ではさらに正規化ファイル名、media type、バイトサイズ、配置、アップロードバイトのSHA-256 digestも含まれます。異なるデータでキーを再利用すると`409 MUTATION_ID_REUSED`で拒否されます。元のブロックが後で削除された場合は代替を作成せず`409 BLOCK_CREATE_REPLAY_UNAVAILABLE`でfail closedします。ブラウザは結果が不明確な応答を1回再試行し、後の手動再試行にも同じtask keyを保持します。認証が変わると保留taskを消去します。

作成は兄弟順序についても安全です。要求された`sortOrder`座標が空いていれば保持し、別の兄弟がすでに占有していれば、既存兄弟のedit versionを変更せず新しいブロックを末尾へ追加します。その後、呼び出し元は完全な兄弟一覧をreorder endpointへ送信できます。これにより同時作成後の追随reorderの一方または両方がstaleとして正しく失敗しても、重複位置が永続化されることを防ぎます。

部分的なブロック作成／更新／添付要求は、mutation開始前にブラウザが実際に描画した完全スナップショットのグローバルページgenerationである`basePageContentVersion`も送信できます。サーバーはページ行lockを保持したままそのbaseを比較します。baseが最新だった場合、または完全再試行によってcommit済みmutationが唯一の介在generationだと証明された場合に限り、`pageContentVersionAuthoritative: true`と新しい`pageContentVersion`を返します。それ以外では`pageContentVersionAuthoritative: false`を返し、`pageContentVersion`を省略します。これにより1ブロックの応答が、他のブロックで見えていない変更まで誤って保証することを防ぎます。したがってbaseを送らないlegacyクライアントは、古い全ページfreshnessトークンを進める代わりに保守的に失敗します。`PATCH /api/blocks/:blockId`で`parentBlockId`または`sortOrder`を変更するには、現在の`basePageContentVersion`と未占有の宛先兄弟座標が必要です。staleまたは衝突するsparse hierarchy書き込みは、新しいレイアウト状態を上書きせず失敗します。完全な兄弟順序を変更する場合はreorder endpointを使用してください。メタデータベースの構造化ブロックを作成する、既存ブロックを対象タイプ（`TABLE`、`KANBAN`、`DATABASE`、`TREEVIEW`、`ACCORDION`、`TIMETABLE`、`GANTT`、`BOOKMARK`、`AI_CHAT`）のいずれかへ変更する、または構造化メタデータを明示的に置き換える場合は、対象タイプの完全なcanonicalフィールド（例：`BOOKMARK`の`metadata.bookmark`）を含む明示的な`metadata`オブジェクトが必要です。送信モデルはサーバーnormalizerを通して正確にround-tripできなければなりません。`metadata: { bookmark: {} }`や`metadata: { bookmark: { items: [] } }`のようなネストされた空または部分モデルは、正規化が省略フィールドを黙って合成するため拒否されます。同一タイプの更新では、保存済みcanonical payloadを保持するなら`metadata`を省略し、置き換えるなら完全なcanonicalフィールドを送信してください。指定不足の作成、タイプだけの変換、null・空・部分的なメタデータ置換は、内容準備や書き込み前に`400 BLOCK_TYPE_METADATA_REQUIRED`で失敗し、送信されたノート本文や既存の構造化内容が暗黙の既定モデルを通じて再解釈されることを防ぎます。すでにcommit済みの完全作成再試行は、この検証より前に冪等性receiptから解決されます。

## ブロック削除応答喪失の整合性

`DELETE /api/blocks/:blockId`には、必須の正確なバージョンスナップショットとともに`mutationId`（ASCII英字、数字、`_`、`-`の1～64文字）が必要です。サーバーはブロック削除とバージョン履歴エントリと同じトランザクションで、`(actor_id, mutation_id)`、正規化要求ハッシュ、commit済みページコンテンツバージョン、削除添付IDを保存します。receiptには意図的に削除対象ブロックへのforeign keyがないため、証明する操作の後も残ります。

トランザクションがcommitしたもののHTTP応答が失われた場合、完全な再試行はすでに削除済みのブロックを再検索・再削除せず`204`で承認されます。異なるブロックまたは要求本文でIDを再利用すると`409 MUTATION_ID_REUSED`で拒否され、不正または不完全なreceiptは破壊的操作を繰り返す代わりにfail closedします。添付ファイルのcleanupはreplay-safeで、承認済み再試行の後にも再実行されるため、データベースcommitとファイルシステムcleanupの間のプロセス中断を修復します。ブラウザは元のバージョンスナップショットとmutation IDを保持し、不明確な結果を1回再試行し、保留作業を現在の認証generation、アカウント、ページ、ブロック、preserve/cascadeモードにスコープします。

## ページバージョンリセット再試行の整合性

`DELETE /api/pages/:pageId/versions`には`mutationId`（ASCII英字、数字、`_`、`-`の1～64文字）に加え、所有者が確認したバージョン履歴一覧の`expectedVersion`、`expectedContentVersion`、`expectedRevision`が必要です。サーバーは所有者と所有ページをロックし、`(owner_id, mutation_id)`を予約して、完了済みで一致するreceiptがあれば最初にreplayします。新規予約mutationでは3つの期待generationすべてをロック済み現在状態と比較し、不一致なら履歴行を削除する前に`409 PAGE_VERSION_RESET_CONFLICT`を返します。

一致する最新スナップショットだけが、以前の履歴削除、revision-1 baselineの書き込み、`revision`と`deletedCount`を含むreceipt完了を同じトランザクションで実行します。完全再試行はstale-state比較の前に保存済み結果を`replayed: true`で返すため、リセットがcommitした後にHTTP応答が失われても承認でき、その後作成された履歴を削除することはありません。別の要求へのID再利用は`409 MUTATION_ID_REUSED`で拒否されます。ブラウザは表示済みスナップショットをmutation taskとともに保持し、不明確な結果では同じ本文で再試行し、staleスナップショット競合後は所有者が別のリセットを確認できる前に履歴一覧を更新します。

## バックアップ共有の整合性

現行形式version 5 manifestでは`data.pageShares`と`data.collectionShares`の両方が必須です。直接ページエントリにはページID、安定した協力者アカウントID、協力者ユーザー名、`EDIT`権限、作成時刻が含まれます。コレクションエントリにはコレクションID、同じ安定した協力者identityペア、`READ`/`WRITE`/`ADMIN`権限、作成時刻、更新時刻が含まれます。importは宛先アカウントをロックし、破壊的置換前にIDとユーザー名のペアを検証します。アカウント欠落・不一致、自己共有、重複権限、不正な対象、不明なページ／コレクション、必須v5ワークスペースセクション欠落があると、データを置換せず検証に失敗します。

コレクション権限を挿入する前に、復元ページ階層からコレクションmembershipを再構築します。復元されたページ／コレクション権限には新しいcausal generationが付与されます。import応答は直接ページ権限総数を`counts.shares`/`sharing`に、コレクション権限総数を`counts.collectionShares`/`collectionSharing`に報告します。

以前の直接共有形式にあるユーザー名のみの`pageShares`レコードは、各レコードが宛先ワークスペースで現在ロックされているページ対アカウント権限と一致する場合にのみ受理されます。importerがユーザー名だけでlegacy協力者を発見することはありません。`pageShares`導入前のバックアップは、一致する通常ページIDについて有効な現在の直接権限を保持します。`collectionShares`を省略した古いversion 4バックアップも、復元後に残るコレクションIDについて有効な現在のコレクション権限を保持し、`updated_at`のないv4コレクションレコードは従来のfallback動作を維持します。v4より前のバックアップはコレクション共有データを宣言できません。v5が厳格な現行形式です。

## 共同編集materializationの整合性

`PUT /api/pages/:pageId/collaboration/snapshot`は、意味のある入力として現在の`documentEpoch`と正確な最新`updateId`だけを受け付けます。update IDは同期checkpointであり、要求本文と文書内容をbindingするものではありません。WebSocket writerが使用するのと同じページlockを保持したまま、サーバーは`page_yjs_updates`をupdate順に読み、Yjs文書を再構成し、タイトル、ブロック、階層、JSON-safeメタデータ、添付tombstoneを検証し、サーバーが導出した状態だけを`pages`と`blocks`へ書き込みます。

展開互換性のため、古いタブは引き続き`title`、`blocks`、`deletedAttachmentIds`を送信する場合がありますが、これら未知フィールドは除去され無視されます。migration `022_server_authoritative_collaboration_materialization.sql`は修正前のmaterialization checkpointをprovenance version `0`として印付けします。空でない共同編集履歴は、最後の共有削除、アーカイブ、完全削除、export、ワークスペースrestoreを進める前に更新済みサーバーで再materializeされる必要があります。

## OpenAPI

完全なOpenAPI 3.1文書は[`docs/api/2026-07-30/openapi.yaml`](openapi.yaml)に保存されています。リポジトリ文書のランタイム配信は既定で無効です。`SERVE_INTERNAL_DOCS=true`を設定すると`/docs`が有効になりますが、それらのルートにも認証済みセッションが必要です。

## ヘルスチェック

ヘルスendpointは認証なしで利用でき、`{ "ok": true }`だけを返します。

```bash
curl http://localhost:4000/health
```

## WebSocket詳細

共同編集セッション応答はソケットパスと2つの必須subprotocol値、`brainvault-yjs-v2`および短寿命の`brainvault-ticket.<token>`資格情報を提供します。バイナリメッセージは順序付きYjs更新を運び、JSONメッセージは準備acknowledgement、presence、アクセス変更、canonical添付通知を運びます。プロトコルとデプロイ要件については[共同編集](../../collaboration/2026-07-29/collaboration.ja.md)を参照してください。
