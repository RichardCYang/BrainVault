# 시작하기

## 요구 사항

- Node.js 22.x 계열에서는 22.23.2 이상, Node.js 24.x 계열에서는 24.18.1 이상, 또는 Node.js 26.5.1 이상
- npm 10.9 이상
- 실행 중인 MariaDB 서버

Docker는 필수가 아닙니다. `DATABASE_URL`의 자격 증명으로 접속할 수 있다면 MariaDB는 로컬 또는 원격 호스트에서 실행할 수 있습니다. 운영 환경에서는 원격 데이터베이스 URL에 `?ssl=true`를 추가해야 하며, BrainVault는 평문 원격 데이터베이스 전송을 거부합니다.

## 최초 설정

데이터베이스 자격 증명을 대화형으로 설정한 다음 의존성을 설치합니다.

```bash
npm run db:configure
npm install
```

`db:configure`는 Node.js 내장 기능만 사용하므로 `npm install` 전에 실행할 수 있습니다. 데이터베이스 사용자 이름과 비밀번호를 묻고, 대화형 터미널에서는 비밀번호를 숨긴 채 `.env`의 `DATABASE_URL`을 업데이트합니다. 기존 프로토콜, 호스트, 포트, 데이터베이스 이름은 유지합니다. `.env`가 없으면 자격 증명을 적용하기 전에 `.env.example`에서 새로 생성합니다.

대신 임의의 데이터베이스·JWT·MFA 비밀값이 포함된 로컬 환경 파일을 만들려면 다음을 실행합니다.

```bash
npm run env:init
```

실제 `.env` 파일은 절대 커밋하지 마세요. 저장소에서는 해당 파일을 무시하며, 공유 가능한 기본값은 [`.env.example`](../../../.env.example)에 보관하세요.

## 개발 서버 시작

```bash
npm run dev
```

`AUTO_BOOTSTRAP_DATABASE=true`이면 시작 시 권한이 허용되는 경우 데이터베이스를 생성하고, 기본 스키마를 조정한 뒤 페이지 권한과 영구 Yjs 업데이트를 위한 `020_page_sharing_yjs_collaboration.sql`을 포함하여 아직 적용되지 않은 마이그레이션을 실행합니다. MariaDB가 준비되고 HTTP 서버가 수신 대기 상태가 되면 개발 명령은 앱을 비공개/시크릿 브라우저 창에서 한 번 엽니다.

앱은 다음 주소에서 사용할 수 있습니다.

```text
http://localhost:4000
```

비공개 모드 실행은 Chrome, Edge, Firefox, Brave를 지원합니다. BrainVault는 먼저 시스템 기본 브라우저에 비공개 창을 요청한 다음, 실패하면 설치된 지원 브라우저에 각 브라우저별 비공개 모드 명령줄 옵션을 사용해 다시 시도합니다. 비공개 창을 열 수 없으면 문제를 보고하고 의도적으로 일반 브라우저 창을 열지 않습니다. Safari는 명령줄에서 직접 비공개 모드로 실행할 수 없으므로, macOS에서 자동 실행하려면 지원되는 다른 브라우저가 설치되어 있어야 합니다.

## 선택 사항: 데모 데이터

데모 시딩은 기본적으로 비활성화되어 있으며 저장소에 정의된 비밀번호를 절대 사용하지 않습니다. 샘플 워크스페이스를 만들려면 UTF-8 기준 72바이트 이하이면서 12~128자인 명시적 비밀번호를 지정하세요.

```bash
BRAINVAULT_SEED_DEMO=true \
BRAINVAULT_DEMO_USERNAME=demo \
BRAINVAULT_DEMO_PASSWORD="use-a-unique-local-password" \
npm run db:seed
```

실제 계정 비밀번호를 재사용하지 마세요. 시드 명령은 사용자 이름은 출력하지만, 평문 비밀번호는 데이터베이스 해시 외부에 출력하거나 저장하지 않습니다.

## 데이터베이스 부트스트랩

가장 단순한 설정에서는 `DATABASE_URL`의 계정에 대상 데이터베이스를 만들고 DDL 문을 실행할 권한이 필요합니다.

해당 계정이 아직 존재하지 않으면 관리자 연결을 추가합니다.

```env
MARIADB_ADMIN_URL="mariadb://root:your-root-password@127.0.0.1:3306"
```

그러면 부트스트랩 과정에서 다음을 수행할 수 있습니다.

1. 데이터베이스가 없으면 생성합니다.
2. `DB_USER_HOSTS`의 각 정확한 호스트에 대해 애플리케이션 사용자를 생성하거나 업데이트합니다.
3. 같은 사용자 이름의 기존 와일드카드 호스트 계정을 제거합니다.
4. 대상 데이터베이스에 필요한 애플리케이션 및 마이그레이션 권한만 부여합니다.
5. 기본 스키마를 조정합니다.
6. 아직 실행되지 않은 마이그레이션을 적용합니다.

애플리케이션 외부에서 스키마 변경을 관리하려면 시작 시 부트스트랩을 비활성화하세요.

```env
AUTO_BOOTSTRAP_DATABASE=false
```

데이터베이스 작업은 개별 명령으로도 사용할 수 있습니다.

```bash
npm run db:init
npm run db:migrate
npm run db:seed
```

처음부터 전체 스키마를 설정하려면 다음을 실행합니다.

```bash
npm run setup
```

setup 명령은 서로 독립적인 암호학적으로 안전한 임의 데이터베이스·JWT·MFA 비밀값으로 `.env`를 만들고, 데이터베이스를 초기화한 뒤 마이그레이션을 적용합니다. 애플리케이션 데이터베이스 계정이 아직 없다면 부트스트랩에서 정확한 호스트 계정을 만들 수 있도록 먼저 `MARIADB_ADMIN_URL`을 설정하세요. 공유 데모 계정은 만들지 않습니다.

## 운영 환경 빌드

TypeScript 소스를 컴파일한 다음 생성된 서버를 실행합니다.

```bash
npm run build
npm start
```

자동 브라우저 실행은 `npm run dev` 전용 기능이며 운영 환경 실행에서는 절대 호출되지 않습니다.

운영 모드를 사용하기 전에 다음을 확인하세요.

- `HOST`를 의도한 바인드 주소로 설정하세요. 기본값 `127.0.0.1`은 루프백 전용입니다.
- 최소 32자의 고유한 `JWT_SECRET`과 `MFA_ENCRYPTION_KEY` 값을 설정하세요. 운영 환경은 값이 없거나, 플레이스홀더이거나, 기존 기본값이거나, 두 값이 동일하면 시작을 거부합니다.
- `WEBAUTHN_RP_ID`와 `WEBAUTHN_ORIGIN`을 운영 환경의 relying-party 도메인과 정확한 브라우저 origin으로 설정하세요.
- 공개 회원가입을 의도한 경우가 아니라면 `REGISTRATION_ENABLED`를 설정하지 않거나 `false`로 유지하세요.
- 인증된 프로젝트 문서를 의도적으로 노출해야 하는 경우가 아니라면 `SERVE_INTERNAL_DOCS=false`로 유지하세요.
- `DB_USER_HOSTS`를 정확한 애플리케이션 클라이언트 호스트로 설정하고 `npm run db:init`을 다시 실행해 기존 와일드카드 계정을 제거하세요.
- `DATABASE_URL` 또는 `MARIADB_ADMIN_URL`이 루프백이 아닌 호스트를 가리키면 `?ssl=true`를 추가하세요. 운영 환경 시작과 `db:init`은 평문 원격 데이터베이스 연결을 거부합니다.
- `PUBLIC_ORIGIN`을 정식 HTTPS origin으로 설정하세요. 직접 Posh-ACME TLS를 사용하려면 `POSH_ACME_CERT_PATH`와 함께 `HTTPS_MODE=posh-acme`을 사용하고, 신뢰할 수 있는 리버스 프록시가 TLS를 종료한다면 `HTTPS_MODE=proxy`를 사용하세요.
- 프록시 모드에서는 `TRUST_PROXY_ADDRESSES`에 정확한 프록시 IP 또는 가능한 한 좁은 CIDR을 설정하세요. 숫자 기반 `TRUST_PROXY_HOPS` 신뢰는 비활성화되어 있으며 `0`으로 유지해야 합니다.
- 프록시 모드에서는 백엔드 HTTP 포트를 비공개로 유지하고 프록시 또는 로컬 상태 점검기만 접근하도록 하세요. Posh-ACME 모드에서는 의도한 HTTPS 리스너만 노출하세요.
- HTTPS, 관리형 비밀 저장소, 데이터베이스 백업 및 일반적인 운영 모니터링을 사용하세요.

직접 Posh-ACME 모드에서는 같은 네이티브 HTTPS 리스너로 협업 트래픽을 처리합니다. 리버스 프록시 뒤에서는 `/api/collaboration/`에 대해 WebSocket 업그레이드를 활성화하고 원래 origin, host, protocol 헤더를 보존하세요. [협업](../../collaboration/2026-07-29/collaboration.ko.md#인증-및-네트워크-요구-사항) 및 저장소의 [HTTPS 배포 가이드](../../../deploy/README.md)를 참고하세요.

`DATABASE_URL`에 비밀번호가 없거나 알려진 기본 비밀번호가 포함되어 있으면 서버는 시작을 거부합니다. 운영 환경에서는 암호학적 비밀값 중 하나라도 없거나 공개 플레이스홀더로 알려진 값이면 역시 거부합니다. 개발 환경에서 암호학적 비밀값을 설정하지 않으면 프로세스마다 임시 값을 사용하고, `npm run env:init`은 지속적으로 사용할 임의 값을 기록합니다. 자세한 내용은 [보안](../../security/2026-07-30/security.ko.md) 및 [설정](../../configuration/2026-07-28/configuration.ko.md)을 참고하세요.
