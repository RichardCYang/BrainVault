# 보안

## 비밀번호 없는 passkey 로그인

로그인 화면은 ID나 비밀번호를 먼저 입력받지 않고 검색 가능한(discoverable) WebAuthn 자격 증명으로 직접 인증할 수 있습니다. 익명 options 경로는 빈 `allowCredentials` 목록을 반환하고 사용자 검증을 요구합니다. 일회용 챌린지는 해시로만 저장되고 별도의 `HttpOnly`, `SameSite=Strict` ceremony 쿠키에 바인딩되며, 5분 후 만료됩니다. 또한 전체 assertion을 파싱하기 전에 원자적으로 소비되므로 잘못된 시도를 수정해서 재생할 수 없습니다.

검증에는 정규형이며 바이트 단위로 동일한 `id`/`rawId` 값, 값이 채워진 자격 증명의 `userHandle`, 설정된 정확한 origin과 RP ID, user presence와 user verification, 유효한 서명, 그리고 카운터를 지원하는 경우 감소하지 않는 카운터가 필요합니다. 트랜잭션은 계정과 자격 증명을 모두 다시 잠그고, 서명 검증 이후 자격 증명의 보안 필드가 바뀌지 않았는지 확인한 뒤 compare-and-swap 의미론으로 카운터를 업데이트합니다. 알 수 없는 자격 증명, 잘못된 handle, 암호학적 실패, 재생은 모두 동일한 일반 오류를 반환합니다. 새 passkey 등록에는 `residentKey: "required"`가 필요합니다. 이전의 non-discoverable passkey는 직접 로그인에 나타나기 전에 다시 등록해야 할 수 있습니다.

익명 passkey 본문은 64 KiB로 제한되며, 정확한 객체 키 집합과 명시적인 base64url, extension-result, 깊이, 노드 제한을 사용합니다. options와 verification에는 서로 다른 IP rate limit이 적용됩니다. 해당 저장소는 프로세스 로컬이므로 수평 확장 배포에서는 동등한 edge limit 또는 공유 저장소를 적용해야 합니다.

## 2단계 인증

두 가지 인증 방식 중 하나를 설정하려면 **설정 → 보안**을 여세요.

- **인증 앱(TOTP):** BrainVault는 QR 코드와 수동 설정 키를 표시한 뒤, 유효한 6자리 코드를 확인한 경우에만 방식을 활성화합니다. 저장된 TOTP 비밀값은 AES-256-GCM으로 암호화되며 같은 time step 안에서 코드를 재생할 수 없습니다.
- **Passkey(WebAuthn/FIDO2):** 여러 플랫폼 passkey 또는 외부 하드웨어 보안 키를 추가하고 이름 지정, 이름 변경, 제거할 수 있습니다. 각 자격 증명은 별도로 저장되므로 기본 장치와 복구 키를 함께 둘 수 있습니다.

비밀번호가 승인된 뒤 하나 이상의 방식이 설정된 계정에는 JWT 응답 대신 짧은 수명의 일회용 MFA 세션이 발급됩니다. 사용 가능한 TOTP 또는 passkey 챌린지를 완료하면 일반 `HttpOnly`, `SameSite=Strict` 세션 쿠키가 생성됩니다. 설정된 공개 origin이나 HTTPS 모드가 TLS를 사용하는 경우 쿠키에는 `Secure`가 표시됩니다. 인증 응답은 JWT를 JSON에 포함하지 않으며, 내장 브라우저 클라이언트도 세션 자격 증명을 Web Storage에 영속화하지 않습니다. 호환성을 위한 bearer 세션은 운영 환경에서 기본적으로 비활성화되며 명시적으로 활성화한 경우에도 브라우저 origin 검사를 받습니다.

로컬 WebAuthn 개발은 `http://localhost:4000`에서 동작합니다. 운영 배포에서는 HTTPS를 사용하고 `WEBAUTHN_RP_ID`와 `WEBAUTHN_ORIGIN`을 정확한 relying-party 도메인과 브라우저 origin으로 설정하세요.

사용자가 TOTP를 등록한 뒤 `MFA_ENCRYPTION_KEY`를 변경하면 암호화된 인증기 비밀값이 무효화됩니다. 관리되는 secret 프로세스를 통해 저장하고 회전하세요.

## 비밀값 생성 및 시작 시 보호 장치

`npm run env:init`은 MariaDB 애플리케이션 비밀번호, `JWT_SECRET`, `MFA_ENCRYPTION_KEY`에 대해 서로 독립적인 암호학적 난수 값을 생성하며 예제 파일의 사용 가능한 공개 비밀값을 복사하지 않습니다. `npm run secrets:generate`는 JWT 및 MFA 설정용으로 각각 별도의 32바이트(256비트) base64url 값을 출력합니다. 기존 `.env`에서 누락되었거나 생성된 placeholder 할당을 채우려면 `-- --write`를 추가하세요. 실제 기존 값은 `--force`도 함께 지정하지 않는 한 보호됩니다. MFA 키를 강제로 교체하면 기존 등록 TOTP 비밀값을 읽을 수 없게 되므로 관리되는 migration으로 취급하세요. `DATABASE_URL`에는 비어 있지 않은 비밀번호가 있어야 하며 알려진 공개/기본값은 거부됩니다. 운영 환경에서는 두 암호학적 변수를 모두 명시해야 합니다. 알려진 placeholder, 기존 개발용 값, 두 용도에 동일한 암호학적 값을 재사용하는 구성은 시작 시 거부됩니다. 운영 환경이 아닌 곳에서 암호학적 비밀값이 설정되지 않았으면 BrainVault는 저장소에 공유된 상수 대신 프로세스별 임시 값을 사용합니다.

HTTP 서버는 기본적으로 `127.0.0.1`에 bind합니다. 외부 bind에는 명시적 `HOST` 설정이 필요합니다.

## 런타임 보안 기준선

의존성 설치는 2026년 7월 29일 보안 업데이트보다 오래된 Node.js 릴리스에서 차단됩니다. 지원되는 최소 버전은 22.x 계열의 Node.js 22.23.2, 24.x 계열의 Node.js 24.18.1, 또는 Node.js 26.5.1 이상입니다. package engine 범위는 lockfile에도 반영되며 `.npmrc`에서 `engine-strict=true`가 활성화되어 있으므로 오래된 런타임에서는 `npm install`과 `npm ci`가 단순 경고가 아니라 실패합니다.

이 버전에는 2026년 7월 보안 릴리스에서 발표된 HTTP/2 메모리 고갈 및 use-after-free 문제, permission model 경계 결함, HTTPS identity/session-reuse 문제, DNS 및 zlib 서비스 거부 조건, 요청 헤더 desynchronization, 번들 Undici/llhttp 업데이트에 대한 Node.js 수정이 포함됩니다. 운영 이미지와 CI runner는 최소 범위에만 의존하지 말고 현재 패치된 릴리스를 고정해야 합니다.

`MARIADB_ADMIN_URL`을 사용할 때 bootstrap은 `DB_USER_HOSTS`에 지정된 정확한 host에 대해서만 애플리케이션 계정을 생성하고, `ALTER USER`로 비밀번호를 갱신하며, BrainVault에 필요한 schema 권한만 부여하고 기존 `brainvault@'%'` 형태의 wildcard 계정을 제거합니다. 기존 배포는 새 데이터베이스 비밀번호와 정확한 계정 host를 선택한 뒤 관리자 연결로 `npm run db:init`을 다시 실행해야 합니다.

## 인증 응답 캐시 격리

`requireAuth` 경계를 통과하는 모든 요청에는 자격 증명 파싱, 데이터베이스 접근, 경로 실행 전에 `Cache-Control: private, no-store`가 적용됩니다. 이는 쿠키 인증 API JSON, 인증 오류, 데이터 export, 첨부파일, 선택적 내부 문서가 브라우저나 중간자에 의해 재사용되는 것을 방지합니다. 내부 문서 static handler는 자체 cache metadata를 비활성화하므로 인증 경계 정책을 대체할 수 없습니다.

사용자 지정 페이지 cover 바이너리 endpoint만 의도적인 예외입니다. 이 endpoint는 계속 private이며 즉시 revalidation을 사용하고 `Cookie`와 `Authorization` 모두에 대해 vary하므로, 변경되지 않은 이미지는 일치하는 자격 증명 컨텍스트에서만 조건부로 재사용할 수 있습니다.

## 인증 남용 제어

로그인은 IP 기준 및 정규화된 계정 키 기준 요청 제한과 데이터베이스에 영속화된 계정 backoff로 보호됩니다. 비밀번호 실패는 사용자 행 lock 아래에서 업데이트됩니다. 설정된 임계값 이후 lock 지속 시간이 설정된 최대치까지 지수적으로 증가하므로 분산된 source IP로 계정 상태를 초기화할 수 없습니다. 활성 영속 lock은 비밀번호 실패뿐 아니라 올바른 비밀번호 승인에도 적용됩니다. 저장된 만료 시점이 지나기 전에는 올바른 비밀번호도 잠기며, 만료 후 올바른 비밀번호가 실패 카운터를 지웁니다. 그래도 설정된 MFA 챌린지는 완료해야 합니다. 계정이 여전히 잠겨 있다는 이유만으로 거부된 시도는 일반 자격 증명 실패가 아니라 `LOCKED`로 기록됩니다. 비밀번호는 유효하지만 MFA가 아직 필요한 응답은 완료된 성공 로그인으로 처리하지 않고 횟수에 포함됩니다. TOTP 및 passkey 로그인 검증에는 별도의 IP 및 계정 제한이 있고, 짧은 수명의 MFA 로그인 토큰은 이를 만든 source IP에 바인딩됩니다. TOTP 등록 검증에는 별도의 계정 제한이 있으며 등록 코드의 time step은 즉시 저장되어 같은 코드를 로그인에 재사용할 수 없습니다. MFA 실패 횟수는 사용자 행 lock 아래에서 대체 로그인 세션으로 이어지므로 다시 로그인해도 세션당 8회 시도 예산을 초기화할 수 없습니다. MFA를 성공적으로 완료하면 이 누적 상태를 지웁니다. 등록에는 IP별 및 프로세스 전체 제한이 있고 운영 환경에서 기본적으로 비활성화되며, 기존 사용자 이름에 대해 비밀번호 hashing을 반복하지 않고 동일한 padding된 접수 응답을 반환합니다. 공개 등록을 활성화하면 등록과 로그인 동작을 결합해 정규화된 로그인 ID의 존재 여부가 드러날 수 있습니다. 공개 가입을 의도한 경우가 아니라면 운영 환경에서 등록을 비활성화하세요. 메모리 내 요청 limiter는 단일 프로세스에 적합합니다. 다중 인스턴스 배포에서는 공유 rate-limit 저장소를 사용해야 하지만 비밀번호 backoff는 MariaDB를 통해 공유됩니다.

## 자격 증명 변경 시 세션 폐기

API access token과 페이지 범위 협업 ticket은 별도의 JWT audience, 고정 HS256 알고리즘, `brainvault` issuer를 사용합니다. 세션 토큰 기본 수명은 12시간이며 설정에서는 24시간보다 긴 수명을 거부합니다. 토큰에는 계정의 현재 authentication generation도 들어갑니다. 비밀번호를 바꾸거나 로그아웃하면 해당 generation을 증가시키고 완료되지 않은 MFA 및 WebAuthn 로그인 상태를 삭제하며 로컬 협업 소켓을 즉시 닫습니다. 비밀번호 변경을 시작한 브라우저에는 교체 쿠키가 발급되고 로그아웃 시 쿠키가 지워집니다. 이전 API 토큰, 협업 ticket, 주기적으로 재검사되는 소켓은 fail closed됩니다.

`024_auth_session_revocation.sql` migration은 비밀값이 아닌 `users.auth_version` generation 카운터를 추가합니다. 이 버전을 배포하면 엄격한 issuer, audience, generation claim이 없는 legacy JWT가 무효화되므로 업그레이드 후 사용자는 한 번 다시 로그인해야 합니다.

## 브라우저 origin 정책

운영 환경은 `HTTPS_MODE`가 `proxy` 또는 `posh-acme`가 아니면 시작을 거부하며 `PUBLIC_ORIGIN`은 HTTPS여야 합니다. 개발 loopback origin과 포트를 포함한 모든 브라우저 origin은 `CORS_ORIGIN`에 명시적으로 나열해야 합니다. API CORS 및 협업 WebSocket origin 검사는 `X-Forwarded-Host` 또는 `X-Forwarded-Proto`에서 권한을 유도하지 않습니다. `HTTPS_MODE=proxy`에서는 직접 연결된 peer가 `TRUST_PROXY_ADDRESSES`와 일치하는 경우에만 forwarding header를 허용합니다. 숫자 hop trust와 catch-all `/0` CIDR은 거부되고, 쉼표로 구분되거나 중복된 forwarded-protocol 값은 fail closed됩니다. `HTTPS_MODE=posh-acme`에서는 BrainVault가 설정된 인증서를 `PUBLIC_ORIGIN`에 대해 검증하고 forwarding header를 신뢰하지 않는 native TLS listener를 생성합니다. redirect 대상은 요청 헤더가 아니라 항상 고정 `PUBLIC_ORIGIN`을 사용합니다. 제한 없는 boolean proxy trust는 사용하지 않습니다.

## 렌더링 HTML 제한

정화된 노트 HTML은 지원되는 동영상 host의 embedded video frame만 허용합니다. 사용자가 제공한 iframe permission 속성은 제거되며 input 요소는 disabled checkbox 렌더링에만 유지됩니다. password 및 기타 상호작용 가능한 input 유형은 버려집니다.

## Content Security Policy

Content Security Policy는 same-origin 애플리케이션 script와 현재 클라이언트가 사용하는 정확한 버전의 KaTeX 및 Yjs resource만 허용합니다. 외부 CDN host 전체를 신뢰하지 않습니다. WebSocket destination은 모든 `ws:` 또는 `wss:` endpoint를 허용하는 대신 정확히 설정된 브라우저 origin에서 파생됩니다. 동적 페이지 render 속성은 escape되며, 협업 block ID는 백업 데이터와 같은 제한된 식별자 alphabet을 사용하고, 클라이언트 측 attribute selector는 `CSS.escape()`를 사용합니다.

## 북마크 미리보기 안전성

브라우저의 cross-origin 규칙 때문에 편집기가 임의 페이지 HTML을 직접 읽을 수 없으므로 OpenGraph 조회는 인증된 `/api/bookmarks/preview` 서버 endpoint를 사용합니다. 서버 측 미리보기 fetch는 설정된 대상 포트(기본값 80, 443)만 허용하고, 명시적 HTML content type을 요구하며, 검증된 public DNS 응답을 outbound 요청에 pin하고, 모든 redirect를 다시 검증합니다. 차단된 private-network 대상과 일반 원격 fetch 실패는 동일한 복구 가능한 warning 형태를 반환하므로 endpoint가 유용한 내부 DNS 또는 port oracle로 동작하지 않습니다.

저장된 북마크, 이미지, favicon URL은 다른 사용자의 브라우저에 렌더링되기 전에 private 또는 local IP literal을 거부합니다. 나중에 private 주소로 resolve되는 hostname은 이 동기 저장 검증에서 거부할 수 없습니다. 운영자는 내부 DNS 이름을 민감 정보로 취급해야 하며 서버 측 미리보기 경로는 계속 전체 DNS 검증과 pinning을 수행합니다.

fetcher는 다음을 수행합니다.

- public HTTP(S) 대상만 허용
- 모든 redirect 재검증
- local, private, reserved IP 범위 거부
- 검증된 DNS 결과 pinning
- Node.js가 IPv4와 IPv6 연결 시도 사이에서 fallback하도록 허용
- 설정된 바이트 제한까지 문서 head만 읽음
- 일반적인 legacy 페이지 문자셋 지원

전용 인증 사용자 limiter가 이 서버 측 fetch 경로의 호출 빈도를 제한합니다. 이 제한에는 `BOOKMARK_PREVIEW_WINDOW_MS`와 `BOOKMARK_PREVIEW_MAX`를, 각 fetch에는 `BOOKMARK_FETCH_TIMEOUT_MS`와 `BOOKMARK_FETCH_MAX_BYTES`를 사용하세요.

## 페이지 버전 기록 개인정보 보호

페이지 버전 기록에는 삭제된 블록의 완전한 스냅샷이 들어갈 수 있습니다. 따라서 목록, 상세, 초기화 작업은 소유자 전용이며 브라우저는 초대된 편집자에게 버전 기록 작업을 숨깁니다. 일반 페이지와 협업 접근은 편집자에게 계속 제공되며 과거 스냅샷 저장소만 제한됩니다.

## 공유 페이지 협업 안전성

페이지 소유자만 편집자 권한을 생성하거나 제거할 수 있습니다. 세션 발급, WebSocket upgrade, 주기적 live-connection 검사, relational materialization, 첨부파일 접근, 일반 페이지 조회는 각각 인증 사용자의 소유자/편집자 접근 권한을 다시 확인합니다. 페이지가 협업 상태에 들어간 뒤에는 직접 REST 첨부파일 생성이 거부됩니다. 이는 직접 블록 mutation invariant와 일치하며 out-of-band relational write를 방지합니다. 권한을 제거하면 해당 사용자의 소켓을 즉시 닫고 페이지를 보관하거나 삭제하면 room을 닫습니다.

협업 ticket은 짧은 수명의 페이지 범위 JWT이며 URL 대신 WebSocket subprotocol로 전송됩니다. 서버는 브라우저 origin, RFC 6455 framing과 masking, frame/message 크기, update rate, 현재 페이지 상태, ticket의 사용자/페이지 scope를 검증합니다. 허용된 바이너리 update는 acknowledgement 및 broadcast 전에 MariaDB에 commit됩니다. 모든 write는 프로세스 로컬 room tip과 lock된 durable update tip도 비교합니다. 다른 프로세스의 update를 놓친 room은 insert 또는 compaction 전에 무효화됩니다.

클라이언트는 단순히 Yjs 메타데이터를 삽입하는 방식으로 첨부파일을 만들 수 없습니다. 새 첨부파일 block은 인증된 upload endpoint에서 생성되어야 하며 relational materialization은 정규 파일 메타데이터를 보존하거나 검증합니다. 스냅샷 검증은 중복/global block ID, 누락된 parent, cycle, 과도한 nesting, 오래된 update marker, 교체된 document epoch, title/block 제한도 거부합니다. 세션 ticket, WebSocket room, 데이터베이스 write, 브라우저 recovery record는 모두 같은 epoch를 보유하므로 restore 이전의 오프라인 Yjs 문서를 같은 page ID로 새로 초기화된 페이지에 재생할 수 없습니다. 세션 발급에는 generation-aware client protocol marker가 필요하므로 배포 뒤에도 열려 있던 수정 이전 탭이 legacy recovery 동작으로 다시 연결되는 것을 막습니다.

협업 문서에 이미 존재하는 첨부파일의 parent와 순서는 지연될 수 있는 relational session snapshot이 아니라 acknowledgement된 Yjs 상태에서 가져옵니다. SQL snapshot은 변경 불가능한 파일 identity와 metadata에 대해 계속 권위가 있으며, 첨부파일이 실제로 Yjs에 없는 경우에만 위치 정보에 사용됩니다. 협업 protocol version 2와 WebSocket subprotocol `brainvault-yjs-v2`는 배포 중 cache된 수정 이전 writer를 거부합니다.

전체 접근 및 영속성 모델은 [협업](../../collaboration/2026-07-29/collaboration.ko.md)을 참고하세요.

## 신뢰할 수 없는 코드 렌더링

Highlight.js grammar는 정규식을 동기적으로 실행합니다. 따라서 BrainVault는 서버와 브라우저 모두에서 신뢰할 수 없는 코드 block당 최대 2,000 UTF-16 code unit까지만 highlighting합니다. 서버 렌더링은 25 ms 실행 deadline이 있는 Node.js VM invocation 안에서 grammar를 실행합니다. 더 긴 입력, 알 수 없는 grammar, 오류, timeout은 노트 내용을 삭제하거나 잘라내지 않고 전체 source를 HTML-escape된 plain text로 보존합니다.

초기 브라우저 hydration은 render pass당 20개 block 및 합계 8,000 code unit으로 추가 제한됩니다. 이 제어는 editor preview, Markdown fence, read-only 렌더링, backup restore, 저장된 코드를 만날 수 있는 협업 materialization 경로에 적용됩니다.

## 첨부파일 안전성

업로드된 바이트는 기본적으로 프로젝트 루트의 `uploads/`인 `ATTACHMENT_UPLOAD_DIR` 아래에 저장됩니다. 이 디렉터리는 Git에서 무시되며 public static 디렉터리로 mount되지 않습니다.

업로드 검증은 active web 및 executable 확장자와 media type을 거부하고 실행 파일 signature를 탐지하며, 안정적인 magic byte가 있는 형식의 signature를 검증하고, 인식하지 못한 클라이언트 선언 media type을 `application/octet-stream`으로 낮춥니다. 클라이언트 `Content-Type`만을 유일한 신뢰 신호로 인정하지 않습니다. 기존 legacy metadata도 다운로드 시 정규화되며 active legacy 파일명에는 중립적인 `.download` suffix가 붙습니다.

multipart 바이트를 받기 전에 upload 경로는 현재 페이지 접근을 검증하고 공유 또는 보관 대상을 거부하며, 가능한 경우 선언된 요청 크기를 검사하고 전용 계정별 rate limit을 적용하고, 제한된 프로세스 전체 concurrency pool 안에서 계정당 최대 하나의 활성 upload만 허용합니다. 수신 후 트랜잭션에서도 권한 및 페이지 상태 검사를 반복하므로 접근 권한 철회, 공유 변경, 보관 변경이 있으면 fail closed됩니다. 이러한 admission control은 프로세스 로컬입니다. 다중 인스턴스 배포에서는 proxy 또는 분산 저장소에서 동등한 공유 제한을 적용해야 합니다.

모든 다운로드는 `/api/blocks/:blockId/attachment`를 거치며 현재 사용자의 현재 페이지 접근 권한을 다시 확인하고 강제 download disposition, `nosniff`, sandboxing Content Security Policy, same-origin resource policy를 적용합니다. 백업 restore도 직접 upload와 동일한 차단 파일명 및 active-MIME 정책을 적용합니다. 설정된 attachment root가 public web root와 같거나 그 아래에 있으면 대소문자를 구분하지 않는 Windows path까지 포함해 거부됩니다. 시작 시 commit된 첨부파일은 건드리지 않고 오래된 staging file을 제거합니다. 첨부파일 block, 첨부파일을 포함하는 parent block, 또는 영구 삭제된 page subtree를 삭제하면 연결된 파일도 제거됩니다.

`ATTACHMENT_STORAGE_MAX_MB` 기본값은 2048 MB이며 계정별 commit된 첨부파일 바이트를 제한합니다. 계정당 commit된 첨부파일 수도 5,000개로 제한되므로 0바이트 또는 매우 작은 upload로 byte quota를 넘지 않고 filesystem inode를 고갈시키는 것을 막습니다. upload accounting은 owner row를 잠근 상태에서 실행되므로 동시 writer가 남은 용량을 각각 중복 예약할 수 없습니다. 백업 restore는 replacement attachment generation을 staging하기 전에 두 제한에 대해 검증합니다. byte limit은 전용 첨부파일 volume의 실제 사용 가능 용량보다 낮게 설정하고, 임시 upload, backup staging, 중단된 restore recovery generation을 위한 추가 공간을 남겨두세요.

`ATTACHMENT_UPLOAD_DIR`을 `public/`, `docs/`, `.git/` 또는 프로젝트 루트로 지정하지 마세요.

## 백업 및 복원 안전성

export되는 각 첨부파일 upload 파일, 사용자 지정 page cover, 업로드된 custom-icon 항목은 바이트 크기, CRC-32, SHA-256 digest와 함께 기록됩니다. restore는 워크스페이스 데이터를 교체하기 전에 ZIP directory, manifest 관계, entry path, 개수, media signature, digest를 검증합니다. 현재 v5 백업은 더 엄격한 완전 manifest 계약으로 사용자가 볼 수 있는 페이지 Version 기록, 페이지/컬렉션 공유 상태, 페이지 comment, 소유 페이지 navigation 상태를 보존합니다. 업로드 자산 처리는 v3 동작을 유지합니다. 즉 DB에서 참조되는 활성 자산만이 아니라 계정의 attachment-upload directory와 완전한 업로드 custom-icon directory를 모두 열거합니다. 모호한 database commit 이후 의도적으로 유지한 추가 첨부파일은 `retainedAttachments`로 기록되고, library 제거 후 의도적으로 유지한 icon 파일은 `custom-icons/` 안에서 자체 완결적으로 유지됩니다.

파일을 먼저 staging하고 데이터베이스 교체는 트랜잭션 안에서 실행하므로 잘못되었거나 불완전한 백업이 계정을 부분적으로 덮어쓰지 않습니다. 첨부파일과 업로드 custom icon은 하나의 user-row lock과 공유 restore journal을 사용합니다. 이전 directory는 database commit 결과가 확정될 때까지 보존되며, 중단된 rollback은 실패한 restore generation에 속하지 않는 이후의 동시 upload를 보존합니다.
restore preflight fingerprint와 lock된 recheck에는 페이지 Version 기록, 소유 페이지 navigation collapse 상태, 활성 attachment/custom-icon filesystem generation, custom-icon library row/removal row도 포함됩니다. 따라서 더 최신 history reset, navigation preference write, upload, icon-library mutation이 더 오래된 대상 상태에서 준비된 restore로 조용히 덮어써질 수 없습니다. navigation preference mutation은 backup/restore와 같은 사용자별 row lock을 사용합니다.

브라우저는 same-origin 탭 전체에 걸쳐 갱신 가능한 page/workspace transition lease도 획득합니다. 열려 있는 각 editor에는 flush할 기회가 주어집니다. 소유 중인 활성 또는 보관 페이지에 저장되지 않은 direct draft 또는 acknowledgement되지 않은 로컬 Yjs recovery snapshot이 있으면 export가 차단되고, Yjs recovery 조건에 의해 restore가 차단되며, 영구 subtree 삭제는 서버가 검증한 삭제 scope의 모든 페이지에 같은 Yjs guard를 적용하고, 페이지에 로컬 recovery record가 있으면 archive가 collaborator 연결 해제를 거부합니다. 이는 서버 측 version check와 브라우저 storage에만 존재하는 편집 사이의 간극을 막습니다.

restore는 워크스페이스 콘텐츠에 대해 의도적으로 파괴적입니다. 현재 페이지, 컬렉션, block, tag link, page sharing grant, 사용자에게 보이는 page Version 기록, 소유 page navigation collapse 상태, attachment directory를 현재 v5 백업 상태로 교체합니다. v5는 v3의 업로드 자산 동작을 유지하면서 계정의 업로드 custom-icon directory와 custom-icon library/removal 상태를 교체합니다. v3 이전 백업은 이러한 최신 asset 상태를 그대로 둡니다. 로컬 업로드 icon URL과 removal hash는 source account ID에서 destination account ID로 다시 바인딩되며, v5는 page Version 기록에 저장된 로컬 icon reference와 source-owner actor ID에도 동일한 rebinding을 적용합니다. 로그인 자격 증명과 MFA/passkey 보안 자료는 export되지 않으며 변경되지 않습니다.

현재 형식 백업은 page sharing grant를 협업자의 안정적인 account ID와 username 모두에 바인딩합니다. restore는 ID로 계정을 lock하고 페이지를 하나라도 삭제하기 전에 정확한 쌍이 일치해야 합니다. 같은 username을 가진 무관한 destination account는 허용하지 않습니다. 이전 백업 형식의 username-only sharing record는 각 record가 현재 lock된 page-to-account grant와 일치하는 경우에만 허용됩니다. username lookup만 사용하지 않으며 legacy/current record가 섞이면 fail closed됩니다. `pageShares` 필드가 없는 legacy 백업은 import되는 일치하는 일반 page ID에 대해 계정의 현재 grant를 보존하며 보관 페이지도 포함합니다. 따라서 page 삭제 cascade가 grant를 조용히 지우지 않습니다. 과거 Yjs update log는 계속 제외됩니다. 백업은 최신 서버 materialized document state를 저장하고 restore는 새로운 collaboration generation을 만듭니다.

`DATA_TRANSFER_MAX_SIZE_MB` 기본값은 1024 MB이며, `Content-Length`가 있을 때 multipart 수신 전에, Multer가 파일을 streaming하는 동안, ZIP 전체 stored-entry 크기에 대해, export attachment staging 중에, 완성된 export plan에 대해 적용됩니다. `DATA_TRANSFER_MAX_MANIFEST_SIZE_MB` 기본값은 16 MB이며 너무 큰 manifest는 parsing을 위해 바이트를 할당하기 전에 거부됩니다. export는 전체 백업을 메모리에 buffering하지 않고 최종 archive를 계속 streaming합니다.

백업 manifest는 페이지 20,000개, block 50,000개, tag 20,000개, page-tag relation 100,000개, sharing grant 20,000개, page Version-history entry 200,000개, 소유 page navigation-collapse entry 20,000개, 업로드 attachment file 총 5,000개(live-block 첨부파일 + 유지된 미연결 파일), custom page-cover entry 20,000개, 업로드 custom-icon file 20,000개, custom-icon library-removal record 50,000개로 제한됩니다. import는 manifest를 포함해 최대 45,001개의 ZIP entry와 최대 8 MiB의 central directory를 허용합니다. BrainVault는 자체 UTF-8, store-mode ZIP 형식만 허용하므로 압축 entry expansion은 import 경로로 사용할 수 없습니다.

인증된 import는 multipart 바이트를 받기 전에 제한됩니다. 기본값은 principal당 시간당 3회, principal당 활성 import 1개, 애플리케이션 프로세스당 동시 import 2개입니다. 이 제어는 프로세스 로컬입니다. 다중 인스턴스 배포에서는 proxy 또는 분산 limiter를 사용해 동등한 공유 정책을 적용해야 합니다. BrainVault의 data export로 생성된 ZIP 파일만 허용됩니다.

## 메타데이터, URL 및 복원 검증

인증되지 않은 health 응답은 `{ "ok": true }`만 포함합니다. `SERVE_INTERNAL_DOCS=true`가 명시적으로 설정되지 않으면 내부 저장소 문서를 제공하지 않으며, 활성화된 문서 경로에도 인증 세션이 필요합니다. 잘못된 JSON은 client error로 보고되고 database constraint 응답은 안정적인 application error code를 사용하며, 백업 충돌은 다른 계정이 소유한 identifier를 공개하지 않습니다. page cover URL은 backup restore 중을 포함해 `http:`와 `https:` scheme만 허용합니다. 복원된 profile avatar는 계정 데이터를 교체하기 전에 MIME type, image signature, size를 다시 검증합니다.

## 보안 기본값

서버에는 다음이 포함됩니다.

- 의존성 설치 시 강제되는 보안 패치 Node.js 런타임
- 모든 환경에서 Helmet 보안 header, 정확한 버전의 외부 resource, 명시적 CORS/WebSocket origin allowlist
- global, bookmark-preview, data export/import, login, MFA-login, MFA-enrollment, registration rate limit
- 영속화된 지수형 비밀번호 실패 backoff와 비밀번호/MFA 변경 시 현재 비밀번호 확인
- 기본적으로 current-step replay protection이 적용된 암호화 TOTP 비밀값
- 일회용이며 만료되는 MFA 및 WebAuthn challenge
- WebAuthn user verification, 엄격한 JWT audience 분리, 자격 증명 변경 시 session revocation
- Zod input validation과 검증된 profile-image 데이터
- 파일명, media-type, signature, 인증 다운로드, upload-size 제어가 적용된 private attachment storage
- 인증 middleware 경계의 `private, no-store` caching. page-cover 바이트에 대해서만 자격 증명에 따라 달라지는 private revalidation 사용
- 제한 및 deadline 보호가 적용된 syntax highlighting과 정화된 Markdown/HTML 출력

이 기본값은 출발점일 뿐이며 HTTPS, 안전한 secret storage, 데이터베이스 및 첨부파일 backup, dependency update, 운영 monitoring을 대체하지 않습니다.

## 보고서 기반 강화(2026-09-17)

아래 변경 사항은 제공된 assessment에서 BV-30부터 BV-38로 식별된 code path를 다룹니다. 애플리케이션 또는 배포의 모든 부분에 취약점이 없다고 주장하는 것은 아닙니다.

### outbound 주소 분류(BV-30 및 BV-38)

일치하는 RFC 6052 prefix에 0이 아닌 reserved octet 또는 suffix가 있으면 이제 일반 public IPv6로 처리하지 않고 fail closed합니다. zero-suffix fetch 정책은 의도적으로 RFC 6052보다 엄격합니다. RFC는 0 suffix를 권장하지만 translator가 0이 아닌 suffix bit를 무시해야 한다고 명시합니다. 설정된 `/96` prefix도 reserved octet이 0이어야 합니다.

보고서의 literal `2a00:64::1:7f00:1`은 `2a00:64::/96` 밖에 있습니다. reserved octet이 아니라 prefix bit를 변경합니다. 따라서 해당 주소의 분류만으로는 보고된 `/96` bypass가 입증되지 않습니다. 더 짧은 prefix의 fail-open 경로는 실제로 존재하며 생성된 `/32`, `/40`, `/48`, `/56`, `/64` regression case로 다룹니다. 유효한 public translation은 discovery 성공 후 계속 지원됩니다.

설정된 prefix는 성공한 RFC 7050 discovery를 대체하지 않고 보완합니다. 비어 있거나 실패했거나 잘못된 discovery가 설정 prefix를 통해 조용히 IPv6 eligibility를 유지할 수 없습니다. NAT64 및 canonical-origin cache 수명은 60초이며 local interface 주소는 검증할 때마다 읽습니다. cache 수명 안에서 주소가 바뀌는 것은 계속 배포 고려 사항입니다. network-level egress filtering은 여전히 권장되지만 이 source update가 proxy, container routing, translator 변경을 조용히 설치하지는 않습니다.

참고: [RFC 6052, section 2.2](https://www.rfc-editor.org/rfc/rfc6052.html#section-2.2) 및 [RFC 7050](https://www.rfc-editor.org/rfc/rfc7050.html).

### 위임 권한 및 복구(BV-31 및 BV-32)

collection root 영구 삭제 및 직접 page grant 생성/제거는 소유자 전용입니다. deletion-snapshot 경로와 최종 lock된 delete 경로는 같은 collection-root 제한을 적용합니다. direct-grant removal은 admission 시 ownership을 확인하고 transaction-bound access lock 아래에서 다시 확인합니다. 기존 snapshot, mutation receipt, grant-generation, authentication, workspace 검사는 유지됩니다. 위임된 administrator는 다른 collection-management 및 member-page 기능을 계속 보유합니다. 이는 관리 권한 전체를 제거하는 조치가 아닙니다.

recovery는 두 번째 editing channel이 아니라 quarantine/download 기능으로 남습니다. non-owner upload는 모든 공유 page를 합쳐 principal당 8개 candidate 및 32 MiB, page/lineage당 3개 candidate 및 20 MiB로 제한됩니다. 기존의 전체 principal quota, 정확한 registered-lineage 검사, payload hashing/deduplication, authentication, 7일 grant expiry는 그대로 유지됩니다. client `sourceId` 또는 `generation`을 바꿔도 quota는 초기화되지 않습니다. 기존 저장 recovery candidate는 조용히 삭제되지 않습니다.

recovery `generation`은 local draft/persistence identifier이지 collaboration grant generation이 아닙니다. 보고서 제안처럼 이 둘을 동일시하면 provenance를 입증하지 못하면서 정상 recovery를 거부하게 됩니다. 구현은 대신 kind/lineage 일관성을 검증하고 신뢰할 수 없는 입력을 제한하며 non-owner candidate와 제출 principal을 눈에 띄게 표시합니다. 허용 범위 안에서는 임의 candidate content가 여전히 가능하지만 자동 렌더링되거나 적용되지 않으며 revocation 이전 저작의 증거가 아닙니다.

### 인증 경계(BV-33 및 BV-34)

TOTP 로그인은 현재 block 검사, session-attempt reservation, credential verification, failure/block persistence 전에 user row를 lock합니다. 이제 이 모든 처리는 같은 transaction을 사용합니다. 예상 가능한 verification failure는 transaction에서 반환하고 commit 이후에만 throw합니다. transaction 내부에서 throw하면 attempt counter가 rollback되어 race가 다시 생깁니다. 기존 세션당 8회 시도 제한과 used-step replay 검사는 유지됩니다. source-IP precheck는 최적화일 뿐 권위 있는 gate가 아닙니다.

migration `080_registration_approval.sql`은 기본값 1인 `registration_approved`를 추가하여 기존 계정과 operator가 provision한 계정을 보존합니다. public registration은 명시적으로 0을 삽입합니다. pending account는 operator CLI로 독립적으로 승인될 때까지 dummy-password/invalid-credential 경로를 사용합니다. 중복 registration은 기존 계정을 활성화하거나 덮어쓰지 않습니다. registration은 운영 환경에서 계속 기본 비활성화입니다. 검증되지 않은 신청자를 자동 승인하지 마세요. approval은 계정 존재를 무기한 숨기기 위한 지연이 아니라 out-of-band trust boundary입니다.

참고: [MariaDB FOR UPDATE](https://mariadb.com/docs/server/reference/sql-statements/data-manipulation/selecting-data/for-update) 및 [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html).

### 리소스, 경로 및 regression 제어(BV-35~BV-37)

상주 collaboration room은 admission 전에 최악의 경우 canonical document와 history-metadata allowance를 예약하며 load 시 bounded replay byte도 추가 예약합니다. 공유 ceiling 기본값은 512 MiB이며 `COLLABORATION_ROOM_MEMORY_MAX_BYTES`로 설정합니다. 고갈되면 WebSocket upgrade 전에 retryable 503으로 새 load를 거부하고 안전하게 idle한 room을 evict합니다. invalidated room에 아직 loader 또는 writer가 남아 있는 동안 reservation은 반환되지 않습니다.

receive capacity, retained fragment, queued/active message payload는 각각 별도의 프로세스 전체 128 MiB budget을 갖습니다. capacity growth는 allocation 전에 replacement buffer를 예약합니다. active-handler payload reservation은 socket이 닫힌 뒤에도 handler가 끝날 때까지 유지됩니다. pending upgrade는 IP당 8개로 제한됩니다. 1바이트 header나 nonfragmented frame을 포함한 모든 partial frame은 15초 안에 완료되어야 하며 추가 바이트가 들어와도 deadline이 갱신되지 않습니다. 완료된 작은 frame은 partial-frame timer를 할당하지 않습니다. 이 제한은 모든 JavaScript object, worker, driver, kernel memory를 측정하지 않으므로 OS 수준 containment가 여전히 필요합니다.

보고서는 room component 하나를 과장합니다. 유지되는 `history` entry에는 모든 과거 BLOB가 아니라 metadata가 들어갑니다. durable history와 transient replay byte는 resident room state와 별개입니다. 그럼에도 aggregate availability 위험은 새 accounting을 도입할 만큼 충분했습니다.

네 개의 export/restore owner-directory join은 모두 `storageOwnerDirectory`를 사용합니다. 이는 unsafe storage segment를 alias로 정규화하지 않고 거부하며 lexical containment를 검증합니다. 기존 ID는 서버가 생성합니다. 이는 defense-in-depth 수정이지 실제 HTTP traversal exploit이 입증된 것은 아닙니다. 기존 archive validation 및 symlink protection은 변경되지 않습니다.

오래된 regression 기대값은 이제 account-wide login throttling, passkey rename의 현재 authentication boundary, 미검증 bookmark placeholder, literal regex escaping, 실제 custom-icon mutation count, 더 강한 origin policy를 추적합니다. 관련 source assertion도 approval-aware login과 fail-closed discovery에 맞게 정렬했습니다. WebSocket performance assertion은 새 partial-frame deadline을 고려하면서 scratch-buffer 및 idle-timer 재사용을 계속 요구합니다. 집중 regression suite는 격리된 DNS, clock, transaction simulation으로 production function을 실행합니다. 실제 MariaDB, 실제 NAT64 translation, dependency-backed compilation, 브라우저 end-to-end 동작은 배포 환경에서 검증해야 합니다.

이 업데이트는 새로운 audit trail 또는 log-file subsystem을 추가하지 않습니다.
