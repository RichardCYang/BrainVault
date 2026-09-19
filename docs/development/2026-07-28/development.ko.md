# 개발

## 사용 가능한 스크립트

| 명령 | 용도 |
| --- | --- |
| `npm run lockfile:check` | `package-lock.json`의 머신 종속 레지스트리 URL을 거부합니다. |
| `npm run lockfile:repair` | 레지스트리 tarball URL을 설정된 공개 레지스트리 기준으로 정규화합니다. |
| `npm run env:init` | 필요할 때 `.env.example`에서 `.env`를 생성합니다. |
| `npm run secrets:generate` | 서로 독립적인 32바이트 JWT 및 MFA 비밀값을 출력합니다. 기존 `.env`의 비어 있거나 생성용 플레이스홀더를 채우려면 `-- --write`를 전달합니다. |
| `npm run db:configure` | 데이터베이스 자격 증명을 입력받아 `.env`를 업데이트/생성합니다. |
| `npm run db:init` | 데이터베이스를 준비하고 연결을 확인합니다. |
| `npm run db:migrate` | 스키마를 조정하고 마이그레이션을 적용합니다. |
| `npm run db:seed` | 데모 계정과 시작 콘텐츠를 추가합니다. |
| `npm run setup` | 환경, 데이터베이스, 마이그레이션을 준비합니다. |
| `npm run setup:demo` | setup을 실행하고 데모 워크스페이스를 추가합니다. |
| `npm run dev` | 데이터베이스가 준비된 뒤 서버를 시작하고 비공개/시크릿 브라우저 창을 엽니다. 일반 프로필로의 대체 실행은 비활성화되어 있습니다. |
| `npm run build` | TypeScript를 `dist/`로 컴파일합니다. |
| `npm run reproduce:materialization-loss` | 보존된 Git 기록을 이용해 과거 브라우저 페이로드 materialization 손실을 재현하고 서버 권위형 수정이 동작하는지 검증합니다. |
| `npm run reproduce:cross-instance-loss` | 오래된 교차 프로세스 room compaction 손실을 재현하고 durable-tip fence를 검증합니다. |
| `npm run reproduce:block-preserve-children-delete` | 과거의 두 요청 부분 계층 커밋 문제를 재현하고 트랜잭션 롤백/성공 상태를 검증합니다. |
| `npm run verify:collaboration` | MariaDB 없이 정확한 Yjs pin, 협업 연결, durable-room 최신성, 계층 불변조건, RFC 6455 동작 및 실행 가능한 모든 JS/TS 구문을 검사합니다. |
| `npm run verify:data-loss` | 의존성 없는 영속성, 복구, 파괴적 전환 및 협업 무결성 보호 검사를 실행합니다. |
| `npm start` | 컴파일된 서버를 실행합니다. |
| `npm test` | lockfile을 검증하고 테스트 스위트를 한 번 실행합니다. |
| `npm run test:watch` | watch 모드로 테스트를 실행합니다. |
| `npm run preview:capture` | 로컬 브라우저 UI에서 `docs/assets/2026-08-09/preview.png`를 캡처합니다. |

## 의존성 lockfile 신뢰성

`package-lock.json`은 커밋되어 있으며 일반 설치 과정에서 그대로 유지해야 합니다. 프로젝트 수준의 `.npmrc`는 레지스트리 URL을 이식 가능하게 유지하고 fetch 재시도 횟수를 제한하여, 레지스트리 장애가 설치 멈춤처럼 보이지 않고 빠르게 반환되도록 합니다.

의존성 변경을 커밋하기 전에 lockfile을 검증하세요.

```bash
npm run lockfile:check
```

검사에서 내부 미러 또는 특정 머신에 종속된 레지스트리 URL이 보고되면 lockfile을 복구한 뒤 변경 내용을 검토하세요.

```bash
npm run lockfile:repair
git diff -- package-lock.json
```

CI에서 재현 가능한 깨끗한 설치를 하려면 다음을 권장합니다.

```bash
npm ci
```

의도적으로 비공개 레지스트리를 사용하는 팀은 `BRAINVAULT_ALLOWED_NPM_REGISTRY_HOSTS`를 통해 해당 호스트 이름을 임시로 추가할 수 있습니다. 자격 증명이나 특정 머신 전용 레지스트리 URL을 lockfile에 커밋하지 마세요.

## 프로젝트 구조

```text
BrainVault/
├── docs/                 # 가이드, 자산 및 OpenAPI
├── migrations/           # MariaDB 스키마 마이그레이션
├── public/               # 브라우저 UI
├── uploads/              # 런타임 첨부파일 바이트(Git에서 무시, 자동 생성)
├── scripts/              # 환경, 데이터베이스, 마이그레이션, 시드 및 미리보기 작업
├── src/
│   ├── config/           # 환경 변수 파싱
│   ├── lib/              # 데이터베이스, 인증, Markdown, WebSocket 및 협업 도우미
│   ├── middleware/       # 검증, 인증, CORS 및 오류
│   ├── routes/           # REST 엔드포인트
│   ├── types/            # 도메인 및 Express 타입 정의
│   └── utils/            # 블록 트리 및 스키마 유틸리티
├── tests/                # Vitest 및 Supertest 커버리지
├── .env.example
├── .npmrc                # 이식 가능한 레지스트리 및 제한된 재시도 설정
├── package.json
└── tsconfig.json
```

## 번역

번역은 `public/i18n.js`에 있습니다. 정적 HTML은 `data-i18n*` 속성을 사용하고, 동적 인터페이스 메시지는 같은 모듈의 `t()` 도우미를 사용합니다.

지원되는 언어 식별자는 `en`, `ja`, `ko`, `fr`, `de`, `es`, `pt`입니다. 브라우저 언어 감지와 사용자 환경설정 동작은 [기능](../../features/2026-07-30/features.ko.md#언어)에 설명되어 있습니다.

## 미리보기 캡처

루트 README 이미지는 기본 영어 읽기 모드의 BrainVault 브라우저 UI(`public/index.html` 및 `public/app.js`)에서 캡처합니다. `npm run db:seed`와 동일한 영어 샘플 워크스페이스 데이터를 사용합니다.

로컬에서 다시 생성하려면 다음을 실행합니다.

```bash
npm run preview:capture
```

Chromium 또는 Chrome이 필요합니다. 이 명령은 [`docs/assets/2026-08-09/preview.png`](../../assets/2026-08-09/preview.png)를 업데이트합니다.

## 협업 구현

브라우저 어댑터는 `public/collaboration.js`입니다. 접근/세션/materialization 경로는 `src/routes/collaboration.routes.ts`에 있고, 인증된 room 서버는 `src/lib/collaboration-server.ts`, 의존성 없는 RFC 6455 전송 계층은 `src/lib/websocket.ts`입니다. 데이터베이스 객체는 `migrations/020_page_sharing_yjs_collaboration.sql`에서 도입됩니다.

전송 계층을 변경할 때는 고정된 Yjs 브라우저 버전, CSP allowlist, 프로토콜 테스트 및 협업 문서를 함께 동기화하세요. 배포 전에 `npm run verify:collaboration`, `npm run build`, `npm test`를 실행하세요.
