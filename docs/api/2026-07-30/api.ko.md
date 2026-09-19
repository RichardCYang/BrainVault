# API

대부분의 API 경로는 `HttpOnly`, `SameSite=Strict` 속성의 `brainvault_session` 쿠키를 사용합니다. HTTPS 배포가 설정된 경우 쿠키에는 `Secure`가 적용되며, 호환성을 위한 bearer 세션은 운영 환경에서 기본적으로 비활성화됩니다. 비밀번호 로그인, 직접 passkey 로그인, MFA 완료 응답은 JWT를 JSON으로 반환하지 않으며, 내장 브라우저 클라이언트도 이를 `localStorage`에 저장하지 않습니다. MFA가 활성화된 계정은 비밀번호 로그인 시 임시 불투명(opaque) MFA 세션을 받고, TOTP 또는 passkey 챌린지를 완료한 뒤에만 일반 인증 쿠키를 받습니다. 대신 검색 가능한(discoverable) passkey를 사용하면 로그인 화면에서 별도의 사용자 이름 없는 기본 로그인 절차를 직접 완료할 수 있습니다.

## 경로 개요

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `POST` | `/api/auth/register` | 계정 생성을 제출합니다. 유효한 신규 ID와 기존 ID 모두에 대해 항상 동일한 접수 응답을 반환합니다. |
| `POST` | `/api/auth/login` | 로그인합니다. 쿠키로 인증된 사용자 응답 또는 임시 MFA 세션을 반환합니다. |
| `POST` | `/api/auth/passkey/options` | 사용자 이름 없는 검색 가능 passkey 옵션과 브라우저에 바인딩된 일회용 챌린지 토큰을 생성합니다. |
| `POST` | `/api/auth/passkey/verify` | 검색 가능 passkey를 검증하고 일반 `HttpOnly` 세션 쿠키를 생성합니다. |
| `POST` | `/api/auth/logout` | 계정 인증 generation을 폐기하고 브라우저 세션 쿠키를 지웁니다. |
| `GET` | `/api/auth/mfa/status` | 설정된 TOTP 및 passkey 방식을 조회합니다. |
| `POST` | `/api/auth/mfa/totp/setup` | 현재 비밀번호로 보호되는 TOTP 등록을 시작합니다. |
| `POST` | `/api/auth/mfa/totp/verify` | 대기 중인 TOTP 등록을 확인하고 활성화합니다. |
| `DELETE` | `/api/auth/mfa/totp` | 현재 비밀번호 확인 후 TOTP를 비활성화합니다. |
| `POST` | `/api/auth/mfa/passkeys/options` | 현재 비밀번호로 보호되는 passkey 등록을 시작합니다. |
| `POST` | `/api/auth/mfa/passkeys` | passkey 자격 증명을 검증하고 저장합니다. |
| `PATCH` | `/api/auth/mfa/passkeys/:id` | 등록된 passkey의 이름을 변경합니다. |
| `DELETE` | `/api/auth/mfa/passkeys/:id` | 현재 비밀번호 확인 후 passkey를 제거합니다. |
| `POST` | `/api/auth/mfa/login/totp` | TOTP 코드로 대기 중인 로그인을 완료합니다. |
| `POST` | `/api/auth/mfa/login/passkey/options` | passkey 인증 챌린지를 생성합니다. |
| `POST` | `/api/auth/mfa/login/passkey/verify` | passkey를 검증하고 로그인을 완료합니다. |
| `GET` | `/api/auth/me` | 현재 사용자를 조회합니다. |
| `GET` | `/api/auth/login-history?months=3` | 현재 사용자의 성공/실패 로그인 시도를 최신순으로 조회합니다. 1~12개월을 허용합니다. |
| `PATCH` | `/api/auth/profile` | 표시 이름, 프로필 이미지 또는 기본 언어를 변경합니다. |
| `POST` | `/api/auth/password` | 현재 비밀번호를 확인한 뒤 비밀번호를 변경합니다. |
| `GET` | `/api/pages` | 페이지 목록을 조회합니다. |
| `POST` | `/api/pages` | 페이지를 생성합니다. 클라이언트는 `mutationId`를 제공할 수 있으며 결과가 불명확한 경우 정확히 같은 요청을 재시도할 때만 재사용할 수 있습니다. |
| `GET` | `/api/pages/:pageId` | 페이지와 블록 트리를 조회합니다. |
| `PATCH` | `/api/pages/:pageId` | 페이지 메타데이터를 업데이트합니다. |
| `DELETE` | `/api/pages/:pageId` | 페이지를 보관하거나 영구 삭제합니다. |
| `GET` | `/api/pages/:pageId/shares` | 직접 페이지 `EDIT` 권한을 나열합니다. 페이지 소유자 또는 실효 `ADMIN`만 가능합니다. |
| `POST` | `/api/pages/:pageId/shares` | 기존 사용자를 직접 페이지 편집자로 추가합니다. 페이지 소유자만 가능합니다. |
| `DELETE` | `/api/pages/:pageId/shares/:userId` | 직접 페이지 편집자를 제거하고 대체된 grant generation의 소켓을 닫습니다. 페이지 소유자 또는 실효 `ADMIN`만 가능합니다. |
| `GET` | `/api/collections/:collectionId/shares` | 사용자 지정 컬렉션의 `READ`/`WRITE`/`ADMIN` 권한을 나열합니다. 소유자 또는 컬렉션 `ADMIN`만 가능합니다. |
| `POST` | `/api/collections/:collectionId/shares` | 기존 계정을 사용자 지정 컬렉션에 `READ`, `WRITE`, `ADMIN` 중 하나의 권한으로 추가합니다. |
| `PATCH` | `/api/collections/:collectionId/shares/:userId` | 현재 generation 토큰을 사용해 컬렉션 권한을 변경합니다. |
| `DELETE` | `/api/collections/:collectionId/shares/:userId` | 현재 generation 토큰을 사용해 컬렉션 권한을 제거합니다. |
| `POST` | `/api/pages/:pageId/collaboration/session` | 짧은 수명의 페이지 범위 WebSocket 티켓과 정규(canonical) 스냅샷을 발급합니다. `{ "documentEpochProtocol": 2 }`가 필요합니다. |
| `PUT` | `/api/pages/:pageId/collaboration/snapshot` | 잠긴 영속 Yjs 로그를 페이지/블록 테이블에 materialize합니다. 요청 본문의 콘텐츠는 신뢰하지 않습니다. |
| `WS` | `/api/collaboration/:pageId` | 인증된 바이너리 Yjs 업데이트와 JSON presence/control 메시지를 처리합니다. |
| `POST` | `/api/pages/:pageId/blocks` | 첨부파일이 아닌 블록을 추가합니다. 결과가 불명확한 정확한 재시도에서는 `mutationId`를 재사용합니다. |
| `POST` | `/api/bookmarks/preview` | 전용 인증 사용자 rate limit 아래에서 북마크 OpenGraph 메타데이터를 가져오거나, `mode: "database-url"` 요청 시 데이터베이스 URL 문서의 `<title>`/favicon 메타데이터를 가져옵니다. |
| `POST` | `/api/pages/:pageId/attachments` | 검사된 파일을 업로드하고 첨부파일 블록을 생성합니다. multipart 바이트가 임시 저장소에 도달하기 전에 접근 권한, 페이지 상태, 요청 크기, rate, 동시성 허용 여부를 검사하며, 결과가 불명확한 정확한 재시도에서는 `mutationId`를 재사용합니다. |
| `PATCH` | `/api/blocks/:blockId` | 블록을 업데이트합니다. |
| `DELETE` | `/api/blocks/:blockId` | 정확한 버전 스냅샷과 필수 mutation ID를 사용해 블록과 그 하위 항목을 삭제합니다. |
| `GET` | `/api/blocks/:blockId/attachment` | 현재 페이지 접근 권한을 확인하고 강제 disposition 및 active-content 응답 강화 조치를 적용한 뒤 첨부파일을 다운로드합니다. |
| `GET` | `/api/data/export` | 사용자별 rate limit 아래에서 완전한 ZIP 백업을 스트리밍합니다. 협업자 계정 ID와 사용자 이름에 바인딩된 페이지/컬렉션 공유 권한도 포함합니다. |
| `POST` | `/api/data/import` | BrainVault 백업 ZIP을 검증하고 복원합니다. ID에 바인딩된 페이지/컬렉션 권한을 다시 만들며, 호환 가능한 레거시 권한은 검증된 현재 ID를 통해서만 보존합니다. |
| `POST` | `/api/pages/:pageId/blocks/reorder` | 블록을 이동하거나 순서를 변경합니다. |
| `GET` | `/api/pages/:pageId/render` | 정화(sanitize)된 페이지 HTML을 렌더링합니다. |
| `GET` | `/api/pages/:pageId/versions` | 소유자 전용 페이지 버전 기록을 나열합니다. 과거 항목에는 삭제된 콘텐츠가 포함될 수 있습니다. |
| `GET` | `/api/pages/:pageId/versions/:versionId` | 소유자 전용 페이지 버전 항목 하나를 조회합니다. |
| `DELETE` | `/api/pages/:pageId/versions` | 멱등성 키와 사용자가 확인한 정확한 페이지/콘텐츠/기록 버전을 사용하여 소유자 전용 페이지 버전 기록을 한 번 초기화합니다. |
| `GET` | `/api/search?q=...` | 제목과 블록 Markdown을 검색합니다. |

`GET /api/pages`는 안정적인 keyset pagination을 사용하며 요청당 최대 500행을 허용합니다. 선택적 `compact=true` 모드는 워크스페이스 탐색 스캔을 위한 것으로, 계층 구조, 접근 권한, 협업, 태그, 커서 동작은 유지하면서 반복되는 소유자 프로필 데이터와 페이지별 블록/자식 수를 생략합니다. 이전 버전과의 호환성을 위해 기본값은 여전히 전체 응답입니다. UI는 추가로 `navigation=true`를 전송합니다. 이 명시적 opt-in은 탐색 화면에서 페이지 태그를 렌더링하지 않으므로 태그 enrichment를 건너뛰지만 태그 필터링은 계속 적용합니다. `navigation=true`를 생략하면 기존 compact 응답을 정확히 그대로 유지합니다.

## 컬렉션 공유 API

컬렉션 공유는 저장된 사용자 지정 컬렉션에만 적용됩니다. 가상 Default Collection에는 공유 가능한 컬렉션 레코드가 없습니다. `/api/collections/:collectionId/shares` 아래의 `GET`, `POST`, `PATCH`, `DELETE`는 모두 컬렉션을 관리할 수 있는 인증된 호출자(소유자 또는 실효 `ADMIN`)를 요구합니다.

`POST /api/collections/:collectionId/shares`는 기존 `username`과 `READ`, `WRITE`, `ADMIN` 중 하나인 `permission`을 받습니다. 권한은 `page_collection_memberships`를 통해 현재의 모든 멤버 페이지에 적용됩니다. 문서가 처음으로 실질적으로 공유 상태가 되면 BrainVault는 해당 문서의 정규 SQL 스냅샷에서 새 Yjs 협업 lineage를 초기화합니다. 같은 사용자에게 컬렉션 권한과 직접 페이지 `EDIT` 권한이 모두 있는 경우 컬렉션 권한이 우선합니다. 따라서 새로운 `READ` 컬렉션 권한이 존재하는 동안에는 해당 사용자의 멤버 페이지 실효 접근 권한이 읽기 전용으로 낮아집니다.

`PATCH /api/collections/:collectionId/shares/:userId`와 `DELETE /api/collections/:collectionId/shares/:userId`에는 현재 권한에서 반환된 `generation` 값인 `expectedGeneration`이 필요합니다. 서버는 권한 변경 시 generation을 회전시키며 오래된 작업은 `409 COLLECTION_SHARE_GENERATION_CHANGED`로 거부합니다. `WRITE`/`ADMIN`에서 `READ`로 낮추거나 권한을 제거할 때는 쓰기 권한을 철회하기 전에 복구 상태를 보존하고 활성 협업 쓰기에 fence를 설정합니다.

컬렉션 접근 권한을 제거할 때는 먼저 철회되는 관리자가 만든 멤버 페이지 직접 권한을 삭제한 다음, 모든 멤버 문서의 실효 공유 집합을 다시 계산합니다. 소유자가 독립적으로 생성한 직접 페이지 권한은 다시 유효해질 수 있습니다. 협업 기록은 최종 실효 공유가 사라진 문서에 대해서만, 그리고 가장 최근에 수락된 Yjs 업데이트를 안전하게 materialize한 뒤에만 해제됩니다.

UI 진입점과 자세한 역할/상속 동작은 [컬렉션 공유](../../collaboration/2026-09-02/collection-sharing.ko.md)를 참고하세요.

## 페이지 생성 재시도 무결성

`POST /api/pages`는 선택적 `mutationId`(ASCII 문자, 숫자, `_`, `-`로 구성된 1~64자)를 받습니다. 서버는 페이지, 초기 블록, 태그, 생성 기록 항목과 같은 트랜잭션에서 소유자 범위 mutation receipt를 예약합니다. 같은 ID로 정확히 같은 본문을 재시도하면 원래 페이지를 반환합니다. 다른 콘텐츠에 ID를 재사용하면 `409 MUTATION_ID_REUSED`로 거부됩니다. 원래 페이지가 나중에 영구 삭제된 경우에는 조용히 대체 페이지를 만들지 않고 재생(replay)을 거부합니다.

`DELETE /api/pages/:pageId?permanent=true`에는 최신 `expectedSnapshot`과 `mutationId`(ASCII 문자, 숫자, `_`, `-`로 구성된 1~64자)가 모두 필요합니다. 삭제 receipt는 하위 트리 삭제와 같은 트랜잭션에서 커밋되며, 삭제된 페이지 행이 사라진 뒤에도 의도적으로 유지됩니다. 데이터베이스 커밋은 성공했지만 HTTP 결과가 유실된 경우 같은 mutation ID로 동일 요청을 재시도하면 삭제를 반복하지 않고 성공을 반환합니다. 다른 요청에 mutation ID를 재사용하면 `409 MUTATION_ID_REUSED`로 거부됩니다.

## 블록 및 첨부파일 생성 재시도 무결성

`POST /api/pages/:pageId/blocks`와 multipart `POST /api/pages/:pageId/attachments`는 선택적 `mutationId`(ASCII 문자, 숫자, `_`, `-`로 구성된 1~64자)를 받습니다. 서버는 블록을 삽입하기 전에 같은 트랜잭션에서 `(actor_id, mutation_id)`를 예약합니다. 첨부파일 요청은 업로드 파일을 영구 경로로 옮기기 전에 receipt를 예약합니다. 정확한 재시도는 기록 항목을 또 추가하거나 페이지 콘텐츠 버전을 다시 증가시키거나 첨부파일을 한 번 더 저장하지 않고 원래 블록을 반환합니다.

보관된 페이지는 서버 측에서 직접 페이지 메타데이터/태그 및 블록 생성/수정/삭제/순서 변경 mutation에 대해 읽기 전용입니다. 먼저 페이지를 복원하세요. 보관 상태에서 허용되는 유일한 페이지 업데이트는 `isArchived: false`만 포함하는 복원 전용 `PATCH /api/pages/:pageId`입니다. 새 쓰기를 수행하지 않는 정확한 멱등 재생은 계속 안전하게 승인할 수 있습니다.

첨부파일 업로드는 Multer가 임시 파일을 열기 전에 페이지 접근 권한, 협업 모드, 보관 상태, 선언된 요청 크기, 계정별 rate, 프로세스 로컬 동시성을 확인합니다. 수신 후 트랜잭션에서 권한과 페이지 상태를 다시 확인하므로, 동시에 소유권·공유·보관 상태가 바뀐 경우 영구 저장이나 블록 생성 전에 fail closed됩니다.

요청 해시에는 페이지, 블록 payload, 작업 종류가 포함됩니다. 첨부파일의 경우 정규화된 파일명, media type, 바이트 크기, 위치, 업로드 바이트의 SHA-256 digest도 포함됩니다. 다른 데이터에 키를 재사용하면 `409 MUTATION_ID_REUSED`로 거부됩니다. 원래 블록이 나중에 삭제된 경우에는 대체 블록을 만들지 않고 `409 BLOCK_CREATE_REPLAY_UNAVAILABLE`로 fail closed됩니다. 브라우저는 결과가 불명확한 응답을 한 번 재시도하고 이후 수동 재시도에서도 같은 task key를 유지합니다. 인증이 바뀌면 대기 중인 task를 지웁니다.

생성은 형제 순서에 대해서도 안전합니다. 요청한 `sortOrder` 좌표가 비어 있으면 그대로 유지하고, 다른 형제가 이미 차지하고 있으면 기존 형제의 edit version을 바꾸지 않고 새 블록을 끝에 추가합니다. 이후 호출자는 완전한 형제 목록을 reorder endpoint에 제출할 수 있습니다. 이렇게 하면 동시 생성 뒤 후속 reorder 중 하나 또는 둘 모두가 오래된 상태로 올바르게 실패하더라도 중복 위치가 영구 저장되는 일을 막습니다.

부분 블록 생성/수정/첨부 요청은 mutation을 시작하기 직전에 브라우저가 실제로 렌더링한 전체 스냅샷의 전역 페이지 generation인 `basePageContentVersion`도 전송할 수 있습니다. 서버는 페이지 행 lock을 보유한 상태에서 이 base를 비교합니다. base가 현재 값이었거나 정확한 재시도로 인해 커밋된 mutation이 유일한 중간 generation임이 증명될 때만 `pageContentVersionAuthoritative: true`와 새 `pageContentVersion`을 반환합니다. 그 외에는 `pageContentVersionAuthoritative: false`를 반환하고 `pageContentVersion`을 생략합니다. 이렇게 하면 하나의 블록 응답이 다른 블록의 보이지 않는 변경까지 잘못 인증하는 일을 막습니다. 따라서 base를 보내지 않는 레거시 클라이언트는 오래된 전체 페이지 freshness 토큰을 진행시키는 대신 보수적으로 실패합니다. `PATCH /api/blocks/:blockId`에서 `parentBlockId` 또는 `sortOrder`를 변경하려면 현재 `basePageContentVersion`과 비어 있는 대상 형제 좌표가 필요합니다. 오래되었거나 충돌하는 sparse hierarchy 쓰기는 최신 레이아웃 상태를 덮어쓰지 않고 실패합니다. 완전한 형제 순서를 바꿀 때는 reorder endpoint를 사용하세요. 메타데이터 기반 구조화 블록을 생성하거나 기존 블록을 해당 유형(`TABLE`, `KANBAN`, `DATABASE`, `TREEVIEW`, `ACCORDION`, `TIMETABLE`, `GANTT`, `BOOKMARK`, `AI_CHAT`) 중 하나로 변경하거나 구조화 메타데이터를 명시적으로 교체하려면 대상 유형의 완전한 정규 필드(예: `BOOKMARK`의 `metadata.bookmark`)를 담은 명시적 `metadata` 객체가 필요합니다. 제출된 모델은 서버 normalizer를 거친 뒤 정확히 round-trip되어야 합니다. `metadata: { bookmark: {} }` 또는 `metadata: { bookmark: { items: [] } }`처럼 중첩된 빈 모델이나 부분 모델은 정규화 과정에서 생략된 필드를 조용히 합성하게 되므로 거부됩니다. 같은 유형의 업데이트에서는 저장된 정규 payload를 보존하려면 `metadata`를 생략하고, 교체하려면 완전한 정규 필드를 보내세요. 정보가 부족한 생성, 유형만 바꾸는 변환, null/빈/부분 메타데이터 교체는 콘텐츠 준비나 쓰기 전에 `400 BLOCK_TYPE_METADATA_REQUIRED`로 실패합니다. 이를 통해 제출된 노트 텍스트나 기존 구조화 콘텐츠가 암묵적 기본 모델을 통해 재해석되는 것을 막습니다. 이미 커밋된 정확한 생성 재시도는 이 검증보다 먼저 멱등성 receipt에서 해결됩니다.

## 블록 삭제 응답 유실 무결성

`DELETE /api/blocks/:blockId`에는 필수 정확한 버전 스냅샷과 함께 `mutationId`(ASCII 문자, 숫자, `_`, `-`로 구성된 1~64자)가 필요합니다. 서버는 블록 삭제 및 버전 기록 항목과 같은 트랜잭션에서 `(actor_id, mutation_id)`, 정규화된 요청 해시, 커밋된 페이지 콘텐츠 버전, 삭제된 첨부파일 ID를 저장합니다. receipt에는 의도적으로 삭제 대상 블록에 대한 foreign key가 없으므로 자신이 증명하는 작업 뒤에도 유지됩니다.

트랜잭션은 커밋되었지만 HTTP 응답이 유실된 경우, 정확한 재시도는 이미 삭제된 블록을 다시 조회하거나 삭제하지 않고 `204`로 승인됩니다. 다른 블록이나 요청 본문에 ID를 재사용하면 `409 MUTATION_ID_REUSED`로 거부되며, 잘못되었거나 불완전한 receipt는 파괴적 작업을 반복하는 대신 fail closed됩니다. 첨부파일 정리는 replay-safe하며 승인된 재시도 뒤에도 다시 실행되므로 데이터베이스 커밋과 파일 시스템 정리 사이에 프로세스가 중단된 경우를 복구합니다. 브라우저는 원래 버전 스냅샷과 mutation ID를 유지하고, 결과가 불명확하면 한 번 재시도하며, 대기 중인 작업을 현재 인증 generation, 계정, 페이지, 블록, preserve/cascade 모드 범위로 제한합니다.

## 페이지 버전 기록 초기화 재시도 무결성

`DELETE /api/pages/:pageId/versions`에는 `mutationId`(ASCII 문자, 숫자, `_`, `-`로 구성된 1~64자)와 함께 소유자가 확인한 버전 기록 목록의 `expectedVersion`, `expectedContentVersion`, `expectedRevision`이 필요합니다. 서버는 소유자와 소유된 페이지를 잠그고 `(owner_id, mutation_id)`를 예약한 다음, 완료된 일치 receipt가 있으면 먼저 재생합니다. 새로 예약된 mutation의 경우 세 예상 generation을 잠긴 현재 상태와 모두 비교하며, 하나라도 다르면 기록 행을 삭제하기 전에 `409 PAGE_VERSION_RESET_CONFLICT`를 반환합니다.

일치하는 최신 스냅샷만 이전 기록 삭제, revision-1 baseline 기록, `revision` 및 `deletedCount`가 포함된 receipt 완료를 같은 트랜잭션에서 수행합니다. 정확한 재시도는 stale-state 비교 전에 저장된 결과를 `replayed: true`와 함께 반환합니다. 따라서 초기화가 커밋되었지만 HTTP 응답이 유실되어도 승인할 수 있고, 이후 생성된 기록을 삭제할 수 없습니다. 다른 요청에 ID를 재사용하면 `409 MUTATION_ID_REUSED`로 거부됩니다. 브라우저는 확인했던 스냅샷을 mutation task와 함께 유지하고, 결과가 불명확하면 같은 본문으로 재시도하며, 오래된 스냅샷 충돌 뒤에는 소유자가 다시 초기화를 확인할 수 있기 전에 기록 목록을 새로고침합니다.

## 백업 공유 무결성

현재 형식 버전 5 manifest에는 `data.pageShares`와 `data.collectionShares`가 모두 필요합니다. 직접 페이지 항목에는 페이지 ID, 안정적인 협업자 계정 ID, 협업자 사용자 이름, `EDIT` 권한, 생성 시각이 포함됩니다. 컬렉션 항목에는 컬렉션 ID, 동일한 안정적 협업자 ID 쌍, `READ`/`WRITE`/`ADMIN` 권한, 생성 시각, 업데이트 시각이 포함됩니다. import는 대상 계정을 잠그고 파괴적 교체 전에 ID와 사용자 이름 쌍을 검증합니다. 계정 누락 또는 불일치, 자기 자신과의 공유, 중복 권한, 유효하지 않은 대상, 알 수 없는 페이지/컬렉션, 필수 v5 워크스페이스 섹션 누락이 있으면 데이터를 교체하지 않고 검증에 실패합니다.

컬렉션 권한을 삽입하기 전에 복원된 페이지 계층에서 컬렉션 membership을 다시 구성합니다. 복원된 페이지 및 컬렉션 권한에는 새 causal generation이 부여됩니다. import 응답은 직접 페이지 권한 총계를 `counts.shares`/`sharing`에, 컬렉션 권한 총계를 `counts.collectionShares`/`collectionSharing`에 보고합니다.

이전 직접 공유 형식의 사용자 이름만 포함한 `pageShares` 레코드는 각 레코드가 대상 워크스페이스에서 현재 잠긴 페이지-계정 권한과 일치하는 경우에만 허용됩니다. importer는 사용자 이름만으로 레거시 협업자를 찾지 않습니다. `pageShares`가 도입되기 전의 백업은 일치하는 일반 페이지 ID에 대한 현재의 유효한 직접 권한을 보존합니다. `collectionShares`가 없는 이전 버전 4 백업도 복원 후 살아남는 컬렉션 ID에 대한 현재의 유효한 컬렉션 권한을 보존하며, `updated_at`이 없는 v4 컬렉션 레코드는 기존 fallback 동작을 유지합니다. v4 이전 백업은 컬렉션 공유 데이터를 선언할 수 없습니다. v5가 엄격한 현재 형식입니다.

## 협업 materialization 무결성

`PUT /api/pages/:pageId/collaboration/snapshot`은 현재 `documentEpoch`와 정확한 최신 `updateId`만 의미 있는 입력으로 받습니다. update ID는 동기화 체크포인트이며 요청 본문과 문서 콘텐츠 사이의 binding이 아닙니다. 서버는 WebSocket writer가 사용하는 것과 같은 페이지 lock을 보유하면서 `page_yjs_updates`를 update 순서로 읽고 Yjs 문서를 재구성한 뒤, 제목, 블록, 계층 구조, JSON-safe 메타데이터, 첨부파일 tombstone을 검증하고 서버가 도출한 상태만 `pages`와 `blocks`에 기록합니다.

배포 호환성을 위해 이전 탭이 여전히 `title`, `blocks`, `deletedAttachmentIds`를 보낼 수 있지만 이러한 알 수 없는 필드는 제거되어 무시됩니다. migration `022_server_authoritative_collaboration_materialization.sql`은 수정 이전의 materialization 체크포인트를 provenance version `0`으로 표시합니다. 비어 있지 않은 협업 기록은 마지막 공유 제거, 보관, 영구 삭제, export, 워크스페이스 restore를 진행하기 전에 업데이트된 서버에서 다시 materialize되어야 합니다.

## OpenAPI

완전한 OpenAPI 3.1 문서는 [`docs/api/2026-07-30/openapi.yaml`](openapi.yaml)에 저장되어 있습니다. 저장소 문서를 런타임에서 제공하는 기능은 기본적으로 비활성화되어 있습니다. `SERVE_INTERNAL_DOCS=true`를 설정하면 `/docs`가 활성화되지만 해당 경로도 인증된 세션을 요구합니다.

## 상태 확인

상태 확인 endpoint는 인증 없이 사용할 수 있으며 `{ "ok": true }`만 반환합니다.

```bash
curl http://localhost:4000/health
```

## WebSocket 세부 정보

협업 세션 응답은 socket 경로와 두 개의 필수 subprotocol 값, 즉 `brainvault-yjs-v2`와 짧은 수명의 `brainvault-ticket.<token>` 자격 증명을 제공합니다. 바이너리 메시지는 순서가 있는 Yjs 업데이트를 전달하고, JSON 메시지는 준비 승인, presence, 접근 권한 변경, 정규 첨부파일 알림을 전달합니다. 프로토콜 및 배포 요구 사항은 [협업](../../collaboration/2026-07-29/collaboration.ko.md)을 참고하세요.
