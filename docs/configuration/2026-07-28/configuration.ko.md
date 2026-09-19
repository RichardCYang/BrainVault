# 설정

BrainVault는 환경 변수에서 런타임 설정을 읽습니다. 로컬 개발에서는 `npm run env:init`으로 [`.env.example`](../../../.env.example)을 `.env`로 복사하거나, `npm run db:configure`를 사용해 대화형으로 `.env`를 생성/업데이트하세요. 파일을 변경하지 않고 새 32바이트 값을 생성하려면 `npm run secrets:generate`를 실행합니다. 기존 `.env`의 비어 있거나 생성용 플레이스홀더를 채우려면 `-- --write`를 전달하세요.

실제 `.env` 파일은 절대 커밋하지 마세요.

## 환경 변수

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `NODE_ENV` | 서버 시작에 필수(`npm run dev`는 `development` 설정) | 런타임 환경. 운영 배포에서는 `production`을 명시적으로 설정해야 합니다. |
| `HOST` | `127.0.0.1` | 바인드할 네트워크 주소. 외부 접근이 의도된 경우에만 `0.0.0.0` 또는 `::`를 설정하세요. |
| `PORT` | `4000` | `off`/`proxy` 모드의 HTTP 리스너 포트 또는 `posh-acme` 모드의 HTTPS 리스너 포트 |
| `DATABASE_URL` | 필수. `env:init`이 비밀번호 생성 | 앱이 사용하는 MariaDB 연결. 비어 있지 않고 기본값이 아닌 비밀번호가 필요하며, 원격 운영 호스트에서는 `?ssl=true`가 필요합니다. |
| `MARIADB_ADMIN_URL` | 설정되지 않음 | 데이터베이스 및 정확한 호스트 사용자 생성을 위한 선택적 관리자 연결. 원격 운영 호스트에서는 `?ssl=true`가 필요합니다. |
| `DB_USER_HOSTS` | `localhost,127.0.0.1,::1` | 쉼표로 구분한 정확한 MariaDB 계정 호스트. `%` 및 `_` 와일드카드는 거부됩니다. |
| `AUTO_BOOTSTRAP_DATABASE` | `true` | 수신 대기 전에 데이터베이스 부트스트랩을 실행합니다. |
| `DATABASE_CONNECTION_LIMIT` | `10` | 최대 데이터베이스 풀 크기. 단일 인스턴스 안전 lease가 별도의 MariaDB 연결 하나를 추가로 사용합니다. |
| `JWT_SECRET` | 운영 환경 외에서는 임의의 임시 값 | 접근 토큰 서명에 사용하는 비밀값. `env:init`은 영구 임의 값을 기록하며 운영 환경에서는 명시적이고 플레이스홀더가 아닌 값이 필요합니다. |
| `JWT_EXPIRES_IN` | `12h` | 세션 토큰 수명. 5분 이상 24시간 이하여야 합니다. |
| `AUTH_ALLOW_BEARER_TOKENS` | `false` | 명시적으로 활성화한 경우에만 호환용 `Authorization: Bearer` 세션을 허용합니다. 브라우저 클라이언트는 `HttpOnly` 쿠키를 사용합니다. |
| `MFA_ENCRYPTION_KEY` | 운영 환경 외에서는 임의의 임시 값 | TOTP 비밀값 암호화에 사용하는 독립 키 자료. `env:init`은 영구 임의 값을 기록합니다. |
| `WEBAUTHN_RP_NAME` | `BrainVault` | 패스키 등록 중 표시되는 이름 |
| `WEBAUTHN_RP_ID` | `localhost` | scheme 또는 port가 없는 WebAuthn relying-party 도메인 |
| `WEBAUTHN_ORIGIN` | `http://localhost:4000` | WebAuthn 응답에 허용되는 정확한 브라우저 origin을 쉼표로 구분한 목록 |
| `CORS_ORIGIN` | 로컬 개발 origin | API 호출을 허용할 브라우저 origin을 쉼표로 구분한 목록 |
| `PUBLIC_ORIGIN` | 첫 번째 `WEBAUTHN_ORIGIN` | 리디렉션 및 직접 인증서 호스트 이름 검증에 사용하는 정식 브라우저 공개 origin. 운영 환경에서는 HTTPS가 필요합니다. |
| `HTTPS_MODE` | `off` | 개발/테스트 HTTP는 `off`, 신뢰된 리버스 프록시 TLS는 `proxy`, Posh-ACME PEM 파일로 직접 HTTPS를 제공할 때는 `posh-acme`. 운영 환경은 `off`를 거부합니다. |
| `POSH_ACME_CERT_PATH` | 설정되지 않음 | `posh-acme` 모드에서 필수. order 디렉터리 또는 `fullchain.cer`/`FullChainFile` 경로 |
| `POSH_ACME_KEY_PATH` | 같은 디렉터리의 `cert.key` | `posh-acme` 모드에서 선택적으로 private key 경로를 재정의합니다. |
| `HTTPS_REDIRECT` | 프록시 모드에서 활성화 | 인식되지 않은 HTTP 요청에 대한 프록시 모드 리디렉션. 직접 Posh-ACME 모드는 HTTPS만 엽니다. |
| `HTTPS_HEALTHCHECK_BYPASS` | `true` | 프록시 모드의 비공개 백엔드 HTTP 리스너에서 `/health`를 허용합니다. |
| `REGISTRATION_ENABLED` | 운영 환경 외에서는 활성화, 운영에서는 비활성화 | 공개 회원가입 요청을 받습니다. 새 계정은 로그인 전에 `npm run registration:approve -- <username>`으로 별도의 운영자 승인이 필요합니다. |
| `SERVE_INTERNAL_DOCS` | `false` | 저장소의 `docs/` 디렉터리를 인증된 `/docs` 경로에서 제공합니다. |
| `COLLABORATION_ROOM_MEMORY_MAX_BYTES` | `536870912` | 프로세스 전체의 보수적인 resident-room/replay 예약 바이트 수. 범위 96 MiB~4 GiB. RSS 제한이 아니며 전송 및 검증 worker 회계는 별도입니다. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | 밀리초 단위 rate-limit 창 |
| `RATE_LIMIT_MAX` | `120` | 전역 창당 최대 요청 수 |
| `AI_CHAT_ANSWER_MAX_LENGTH` | `50000` | 각 AI 채팅 답변의 최대 Markdown 문자 수. 허용 범위는 1~500000이며 브라우저/서버가 같은 런타임 값을 공유합니다. |
| `AUTH_LOGIN_IP_WINDOW_MS` | `900000` | 로그인 IP throttling 창 |
| `AUTH_LOGIN_IP_MAX` | `20` | IP 창당 허용되는 실패 로그인 요청 수 |
| `AUTH_LOGIN_ACCOUNT_WINDOW_MS` | `21600000` | 정규화된 계정 로그인 throttling 창 |
| `AUTH_LOGIN_ACCOUNT_MAX` | `30` | 출발 네트워크 전체에서 정규화 계정당 허용되는 실패 또는 MFA 대기 로그인 요청 수 |
| `AUTH_LOGIN_LOCK_THRESHOLD` | `8` | 영속 계정 backoff가 시작되기 전 비밀번호 실패 횟수 |
| `AUTH_LOGIN_LOCK_BASE_MS` | `30000` | 초기 계정 잠금 시간 |
| `AUTH_LOGIN_LOCK_MAX_MS` | `900000` | 최대 지수형 계정 잠금 시간 |
| `AUTH_LOGIN_FAILURE_RESET_MS` | `86400000` | 실패 횟수 감소 간격. 유휴 간격마다 영속 실패 1회를 제거합니다. |
| `AUTH_MFA_IP_WINDOW_MS` | `900000` | MFA 로그인 검증 IP 창 |
| `AUTH_MFA_IP_MAX` | `15` | IP 창당 허용되는 실패 MFA 로그인 검증 수 |
| `AUTH_MFA_ACCOUNT_WINDOW_MS` | `3600000` | MFA 로그인 계정 창 및 실패 유지 간격 |
| `AUTH_MFA_ACCOUNT_MAX` | `20` | 계정 창당 허용되는 실패 MFA 로그인 검증 수 |
| `AUTH_MFA_SETUP_WINDOW_MS` | `900000` | 계정 보안 재인증 및 MFA 등록 검증 창 |
| `AUTH_MFA_SETUP_MAX` | `10` | 계정/창당 허용되는 현재 비밀번호 재인증 또는 TOTP 등록 검증 실패 횟수 |
| `AUTH_PASSKEY_OPTIONS_IP_WINDOW_MS` | `900000` | IP당 사용자 이름 없는 패스키 option 발급 창 |
| `AUTH_PASSKEY_OPTIONS_IP_MAX` | `30` | IP 창당 허용되는 패스키 option 요청 수. 성공한 발급도 계산됩니다. |
| `AUTH_PASSKEY_VERIFY_IP_WINDOW_MS` | `900000` | IP당 사용자 이름 없는 패스키 검증 창 |
| `AUTH_PASSKEY_VERIFY_IP_MAX` | `15` | IP 창당 허용되는 실패 패스키 검증 수. 성공 검증은 계산하지 않습니다. |
| `MFA_TOTP_WINDOW_STEPS` | `0` | 현재 step 양쪽에서 추가로 허용할 TOTP step 수. `0`은 인접 step 재사용을 방지합니다. |
| `AUTH_REGISTER_WINDOW_MS` | `3600000` | 회원가입 throttling 창 |
| `AUTH_REGISTER_MAX` | `5` | IP 창당 허용되는 회원가입 요청 수 |
| `AUTH_REGISTER_GLOBAL_MAX` | `20` | 프로세스 전체 창당 허용되는 회원가입 요청 수 |
| `TRUST_PROXY_ADDRESSES` | 비어 있음 | 쉼표로 구분한 프록시 IP, 좁은 CIDR 또는 `loopback`. 프록시 모드에서 필수입니다. |
| `TRUST_PROXY_HOPS` | `0` | 호환성 변수 전용. 숫자 기반 hop trust는 비활성화되어 있으며 반드시 `0`을 유지해야 합니다. |
| `BOOKMARK_PREVIEW_WINDOW_MS` | `60000` | 인증 사용자 전용 북마크 미리보기 제한 창 |
| `BOOKMARK_PREVIEW_MAX` | `12` | 인증 사용자/창당 허용되는 북마크 미리보기 요청 수 |
| `BOOKMARK_FETCH_TIMEOUT_MS` | `8000` | 단일 OpenGraph 페이지 fetch의 최대 시간 |
| `BOOKMARK_FETCH_MAX_BYTES` | `524288` | 하나의 북마크 미리보기를 위해 검사하는 최대 document-head 바이트 수 |
| `BOOKMARK_FETCH_ALLOWED_PORTS` | `80,443` | 서버 측 북마크 미리보기 fetch에 허용되는 대상 포트를 쉼표로 구분한 목록 |
| `BOOKMARK_FETCH_NAT64_PREFIXES` | 비어 있음 | `ipv4only.arpa`를 통한 성공적인 RFC 7050 탐지에 추가할 선택적 RFC 6052 prefix. 탐지 결과를 알 수 없으면 prefix가 설정되어 있어도 IPv6 fetch 후보를 항상 제외합니다. |
| `ATTACHMENT_UPLOAD_DIR` | `uploads` | 첨부파일 바이트를 위한 비공개 디스크 디렉터리. 시작 시 공개 웹 루트와 그 하위 경로는 거부됩니다. |
| `ATTACHMENT_TEMP_MAX_AGE_MS` | `86400000` | 비공개 첨부파일 staging 디렉터리의 오래된 파일을 시작 시 제거하는 기준 나이 |
| `MAX_ATTACHMENT_SIZE_MB` | `25` | 업로드 첨부파일 하나의 최대 크기(MB) |
| `ATTACHMENT_STORAGE_MAX_MB` | `2048` | 계정당 커밋된 첨부파일 바이트의 최대값(MB). 업로드와 백업 복원에 적용됩니다. |
| `ATTACHMENT_UPLOAD_WINDOW_MS` | `60000` | 인증 계정별 전용 첨부파일 업로드 admission 창 |
| `ATTACHMENT_UPLOAD_MAX` | `12` | multipart 바이트를 받기 전에 계정/창당 허용되는 첨부파일 업로드 요청 수 |
| `ATTACHMENT_UPLOAD_MAX_CONCURRENT` | `4` | 애플리케이션 프로세스 하나가 동시에 처리할 최대 첨부파일 업로드 수. 각 계정은 활성 업로드 1개로도 제한됩니다. |
| `DATA_TRANSFER_MAX_SIZE_MB` | `1024` | 완전 데이터 백업 아카이브 하나의 최대 크기(MB). 업로드, ZIP 내용, 내보내기 staging, 최종 내보내기 계획에 적용됩니다. |
| `DATA_TRANSFER_MAX_MANIFEST_SIZE_MB` | `16` | 백업 내보내기/가져오기 중 버퍼링하고 파싱할 최대 JSON manifest 크기 |
| `DATA_EXPORT_WINDOW_MS` | `3600000` | 인증 사용자별 완전 데이터 내보내기 제한 창 |
| `DATA_EXPORT_MAX` | `20` | 인증 사용자/창당 허용되는 완전 데이터 내보내기 수 |
| `DATA_IMPORT_WINDOW_MS` | `3600000` | 인증 사용자 또는 대체 IP 키별 완전 데이터 가져오기 제한 창 |
| `DATA_IMPORT_MAX` | `3` | multipart 업로드 처리 전에 principal/창당 허용되는 완전 데이터 가져오기 수 |
| `DATA_IMPORT_MAX_CONCURRENT` | `2` | 애플리케이션 프로세스 하나가 동시에 처리할 최대 가져오기 수. 각 principal은 활성 가져오기 1개로도 제한됩니다. |

첨부파일 업로드와 가져오기 admission gate는 프로세스 로컬 상태를 사용합니다. 따라서 BrainVault는 시작 시 데이터베이스 범위의 애플리케이션 인스턴스 lease를 획득하고, 같은 MariaDB 데이터베이스에 두 번째 활성 애플리케이션 프로세스가 실행되는 것을 거부합니다. 이 gate, 요청 rate 카운터, 협업 coordination이 공유/분산 백엔드로 이동하기 전까지 수평 확장은 지원되지 않습니다.

## 개발 브라우저 실행

`npm run dev`는 서버가 준비된 뒤 항상 로컬 애플리케이션을 비공개/시크릿 브라우저 창에서 엽니다. 이 동작은 환경 변수로 제어되지 않으며 런처는 일반 브라우저 프로필로 대체 실행하지 않습니다. 자동 실행은 Chrome, Edge, Firefox, Brave를 지원합니다. 이전의 `BRAINVAULT_DEV_BROWSER_PRIVATE` 변수는 무시되므로 기존 로컬 `.env`에서 제거해도 됩니다.

## 데이터베이스 동작

`AUTO_BOOTSTRAP_DATABASE=true`이면 애플리케이션 시작 시 수신 대기 전에 대상 데이터베이스 준비, 기본 스키마 조정, 마이그레이션 적용을 시도합니다.

원격 데이터베이스 호스트에는 연결 URL에 `?ssl=true`를 추가하세요. URL 파서는 이를 MariaDB Connector/Node.js `ssl` 옵션으로 전달합니다. 운영 환경에서는 TLS가 없는 비루프백 `DATABASE_URL` 및 `MARIADB_ADMIN_URL`을 거부하며, 지원하지 않는 URL query parameter는 조용히 무시하지 않고 fail-closed로 처리합니다.

애플리케이션 계정이 아직 없거나 데이터베이스/사용자를 직접 만들 수 없으면 `MARIADB_ADMIN_URL`을 사용하세요. 부트스트랩은 각 정확한 `DB_USER_HOSTS` 항목에 애플리케이션 계정을 생성/업데이트하고, 대상 스키마에 `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `ALTER`, `INDEX`, `DROP`, `REFERENCES`만 부여하며, 와일드카드 호스트 `%`의 같은 사용자 이름을 제거합니다. 스키마 관리를 애플리케이션 외부로 옮기려면 다음과 같이 설정하세요.

```env
AUTO_BOOTSTRAP_DATABASE=false
```

부트스트랩 순서와 데이터베이스 명령은 [시작하기](../../getting-started/2026-07-27/getting-started.ko.md#데이터베이스-부트스트랩)를 참고하세요.

## 운영 환경 값

운영 배포에서는 최소한 다음 항목에 고유한 값을 제공해야 합니다.

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

다른 컨테이너나 호스트의 프록시를 사용한다면 `loopback`을 정확한 프록시 IP 또는 가능한 한 좁은 CIDR로 바꾸세요. `HTTPS_MODE=proxy`는 `TRUST_PROXY_ADDRESSES` 없이 시작을 거부하고, 숫자 기반 hop trust 및 catch-all `/0` CIDR도 거부합니다. `PUBLIC_ORIGIN`은 HTTPS여야 하고 `WEBAUTHN_ORIGIN`과 `CORS_ORIGIN` 양쪽에 포함되어야 합니다. 백엔드 포트는 비공개로 유지하세요.

대신 Posh-ACME로 BrainVault에서 TLS를 종료하려면 프록시 전용 값을 다음과 같이 바꿉니다.

```env
HOST="0.0.0.0"
PORT=443
HTTPS_MODE=posh-acme
POSH_ACME_CERT_PATH="C:/Users/service-account/AppData/Local/Posh-ACME/.../fullchain.cer"
TRUST_PROXY_ADDRESSES=""
TRUST_PROXY_HOPS=0
```

`POSH_ACME_CERT_PATH`는 인증서 order 디렉터리 또는 `fullchain.cer` 자체를 가리킬 수 있습니다. `POSH_ACME_KEY_PATH`로 재정의하지 않으면 BrainVault는 같은 디렉터리의 `cert.key`를 읽습니다. 인증서는 `PUBLIC_ORIGIN`의 호스트 이름을 포함하고 현재 유효해야 하며 private key와 일치해야 합니다. 파일은 시작 시 로드되므로 인증서를 갱신한 뒤 BrainVault를 재시작하세요. 직접 Posh-ACME 및 리버스 프록시 예시는 저장소의 [HTTPS 배포 가이드](../../../deploy/README.md)를 참고하세요.

`JWT_SECRET`과 `MFA_ENCRYPTION_KEY`는 서로 달라야 합니다. 알려진 예시 값과 과거 개발 기본값은 운영 환경 밖에서도 거부됩니다. 사용자가 TOTP를 등록한 뒤에는 `MFA_ENCRYPTION_KEY`를 가볍게 변경하지 마세요. 기존에 암호화된 authenticator 비밀값은 이 키에 의존하며 키가 바뀌면 사용할 수 없게 됩니다.

## 브라우저 잠금 및 secure-context 요구 사항

안전에 중요한 탭 간 전환—영구 삭제, 보관, 공유 변경, 직접 블록 삭제, 전체 워크스페이스 복원—에는 브라우저 Web Locks API가 필요합니다. BrainVault는 원자적 배제를 위해 `localStorage` lease를 대신 사용하지 않습니다. `navigator.locks`를 사용할 수 없으면 파괴적 요청을 보내기 전에 작업을 차단합니다.

운영 환경은 HTTPS로 제공하고 Web Locks를 지원하는 브라우저를 사용하세요. `localhost`의 로컬 개발은 문서에 적힌 HTTP URL을 계속 사용할 수 있습니다. API가 없어도 일반 편집은 가능하지만, 안전에 중요한 persistence-mode 전환은 fail-closed로 실패합니다.

## WebSocket 프록시 및 Yjs 전달

실시간 협업은 HTTP API와 같은 `PORT`, `CORS_ORIGIN`, JWT 서명 비밀값을 사용합니다. 별도의 협업 프로세스나 포트는 필요하지 않습니다. 직접 Posh-ACME 모드에서는 같은 네이티브 HTTPS 리스너로 WebSocket 업그레이드를 처리합니다. 운영 환경 리버스 프록시는 `/api/collaboration/`의 HTTP/1.1 WebSocket 업그레이드를 지원하고 브라우저 origin과 원래 host/protocol 헤더를 전달해야 합니다. 프록시 모드에서 애플리케이션은 신뢰된 `X-Forwarded-Proto` 값으로 외부 HTTPS 요청을 인식합니다. forwarded host 헤더는 브라우저 origin을 인가하거나 리디렉션을 구성하는 데 절대 사용하지 않습니다.

포함된 협업 hub는 프로세스 로컬 방식이며 활성 애플리케이션 프로세스 하나로 실행하도록 설계되어 있습니다. 시작 시 MariaDB advisory lease로 이 topology를 강제하며 같은 데이터베이스에 이미 다른 BrainVault 애플리케이션 프로세스가 lease를 보유하면 fail-closed로 실패합니다. 수평 확장에는 공유 rate/admission 저장소뿐 아니라, 모든 인스턴스가 같은 room 기록과 presence 이벤트를 볼 수 있도록 공유 pub/sub 및 분산 update coordinator가 필요합니다.

브라우저는 lockfile로 제어되는 `yjs`, `lib0`, `isomorphic.js` 패키지에 기반한 same-origin 경로에서 정확한 `yjs@13.6.31` ESM 빌드를 불러옵니다. Mermaid `11.17.2`도 BrainVault 자체 origin에서 제공합니다. `npm run build`는 먼저 다운로드하거나 `BRAINVAULT_MERMAID_TARBALL`을 사용하고, 고정된 npm 패키지 SHA-512 digest를 검증한 뒤 승인된 브라우저 번들과 라이선스만 추출합니다. 인라인 import map은 정확한 CSP hash로 허용됩니다. 정확한 `katex@0.17.0` 자산은 Subresource Integrity가 있는 버전 지정 외부 CDN 경로에 그대로 유지됩니다. Content Security Policy는 same-origin 스크립트, 해당 import-map hash, 정확한 KaTeX 스크립트, `CORS_ORIGIN`에서 파생된 정확한 WebSocket origin만 허용합니다. Mermaid CDN 스크립트 소스, 전체 CDN 호스트, 임의의 `ws:`/`wss:` 대상은 허용하지 않습니다.

완전한 예시는 [협업](../../collaboration/2026-07-29/collaboration.ko.md#인증-및-네트워크-요구-사항) 및 [HTTPS 배포 가이드](../../../deploy/README.md)를 참고하세요.
