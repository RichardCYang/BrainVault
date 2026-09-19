# 페이지 및 컬렉션 공유와 실시간 협업

BrainVault는 두 가지 공유 범위를 지원합니다. 일반 페이지는 페이지 수준 `EDIT` 권한으로 기존 계정에 직접 공유할 수 있고, **사용자 지정 컬렉션**은 `READ`, `WRITE`, `ADMIN` 권한으로 공유할 수 있습니다. 어떤 권한으로 문서에 접근하게 되었는지와 관계없이 공유된 일반 문서는 동일한 Yjs 협업 및 복구 메커니즘을 사용합니다.

보관된 페이지에서는 실시간 협업을 열거나 새 직접 페이지 권한을 추가할 수 없지만, 보관 중에는 실시간 협업만 일시 중지되고 기존 접근 권한은 유지되므로 페이지를 복원하면 접근이 다시 활성화될 수 있습니다. 가상 **기본 컬렉션(Default Collection)**은 공유 가능한 컬렉션 객체가 아니며, 컬렉션 공유는 영속적으로 저장된 사용자 지정 컬렉션에만 적용됩니다.

## 컬렉션 공유 및 권한

사이드바에서 사용자 지정 컬렉션의 **이름**을 클릭해 엽니다. 컬렉션 랜딩 뷰에서 소유자와 `ADMIN` 컬렉션 협업자는 **페이지 추가(Add page)** 옆에 **컬렉션 공유(Share collection)** 버튼을 볼 수 있습니다. 기본 컬렉션이거나, 개별 문서가 열려 있거나, `READ`/`WRITE` 협업자인 경우 이 버튼은 숨겨집니다.

컬렉션 권한은 해당 컬렉션과, 중첩된 하위 페이지를 포함하여 materialized membership이 그 컬렉션에 속하는 모든 문서 페이지에 상속됩니다. 컬렉션 안에서 새 페이지를 만들면 현재 권한을 상속합니다. 페이지 하위 트리를 컬렉션 안이나 밖으로 이동하면 적용되는 컬렉션 권한이 바뀌고, 영향을 받는 협업 lineage가 교체되어 오래된 room이 이전 멤버십의 접근 권한을 유지할 수 없게 됩니다.

| 권한 | 유효 역할 | 주요 기능 |
| --- | --- | --- |
| `READ` | `READER` | 컬렉션을 탐색하고 문서를 읽습니다. 읽기 전용 클라이언트도 실시간 Yjs 상태는 받을 수 있지만 바이너리 쓰기는 `COLLABORATION_READ_ONLY`로 거부됩니다. |
| `WRITE` | `EDITOR` | 읽기와 함께 공유 문서의 제목/블록 및 기타 쓰기 가능한 문서 내용을 편집합니다. 공유 관리나 페이지 관리는 할 수 없습니다. |
| `ADMIN` | `ADMIN` | 읽기/쓰기와 함께 컬렉션 범위 안에서 공유 및 페이지/컬렉션 관리를 수행합니다. 관리자는 공유된 컬렉션 밖으로 페이지를 이동할 수 없습니다. |

같은 사용자에게는 직접 페이지 권한보다 컬렉션 권한이 우선합니다. 즉, 멤버 페이지에 저장된 직접 `EDIT` 권한이 있어도 컬렉션 `READ` 권한이 있으면 `READ`가 우선합니다. 컬렉션 접근 권한이 제거되면 여전히 유효한 직접 권한이 다시 우선 권한이 될 수 있습니다. 권한 generation과 대상 지정 소켓 연결 종료를 사용해 지연된 정리 작업이 되살아난 접근 권한을 취소하지 못하도록 합니다.

컬렉션 레코드 자체는 Yjs 협업 문서가 아닙니다. Yjs 세션은 일반 멤버 페이지에서 실행됩니다. 컬렉션 메타데이터와 공유 관리는 인증된 REST mutation을 사용합니다.

UI 진입점, 역할 동작, 상속, API 경로, 백업/복원, 버튼이 보이지 않는 일반적인 이유에 대한 집중 가이드는 [컬렉션 공유](../2026-09-02/collection-sharing.ko.md)를 참고하세요.

## 협업 흐름

1. 공유는 일반 페이지의 **공유(Share)** 대화상자(`page_shares`, 직접 `EDIT`) 또는 사용자 지정 컬렉션의 **컬렉션 공유(Share collection)** 대화상자(`collection_shares`, `READ`/`WRITE`/`ADMIN`)에서 설정합니다.
2. 권한이 있는 소유자 또는 초대된 편집자가 `{ "documentEpochProtocol": 2 }`와 함께 `POST /api/pages/:pageId/collaboration/session`을 요청합니다.
3. 서버는 수명이 짧고 페이지 범위로 제한된 WebSocket 티켓, 정식 데이터베이스 스냅샷, 현재 `documentEpoch`, 소켓 경로, 필수 `brainvault-yjs-v2` 서브프로토콜을 반환합니다.
4. 브라우저는 정확히 같은 `documentEpoch`가 있는 로컬 복구 업데이트만 불러온 뒤 페이지 제목, 블록, 블록 순서, 메타데이터, 첨부파일 삭제 tombstone을 포함하는 Yjs 문서를 만듭니다. 이전 또는 알 수 없는 generation의 복구 업데이트는 수동 복구를 위해 브라우저 저장소에 남으며 자동으로 병합되지 않습니다.
5. 바이너리 Yjs 업데이트는 인증된 `/api/collaboration/:pageId` WebSocket 엔드포인트로 전송됩니다. 서버는 신뢰할 수 없는 각 업데이트를 격리된 Yjs 문서에 적용하고, 잘못되었거나 너무 큰 상태를 거부하며, 승인된 업데이트를 MariaDB에 저장한 후에만 실시간 room 상태를 교체하고 승인 응답을 보내며 브로드캐스트합니다.
6. presence 메시지는 현재 참여 중인 협업자와 그들이 편집하는 블록/필드를 표시합니다. Presence는 일시적이며 데이터베이스에 기록되지 않습니다.
7. 브라우저는 주기적으로 일관된 Yjs 스냅샷을 일반 `pages` 및 `blocks` 테이블에 다시 materialize합니다. 따라서 기존 REST 읽기, 검색, 렌더링, 내보내기, 백업은 계속 정식 관계형 표현을 사용합니다.

새로 공유된 페이지에 처음 참여하는 협업자는 서버가 제공한 데이터베이스 스냅샷에서 Yjs 기록을 부트스트랩합니다. 다른 클라이언트는 해당 업데이트가 승인될 때까지 기다리므로 서로 다른 초기 기록이 생성되지 않습니다. 재연결 시에는 영속적으로 저장된 기록을 재생하고, 연결 끊김으로 승인 응답을 잃은 로컬 문서 상태를 다시 전송합니다.

## 영속성 및 일관성

마이그레이션 `020_page_sharing_yjs_collaboration.sql`은 다음을 추가합니다.

- 소유자가 관리하는 편집자 권한용 `page_shares`
- 순서가 있는 바이너리 문서 업데이트용 `page_yjs_updates`
- 마지막 관계형 materialization 마커용 `page_collaboration_state`

마이그레이션 `021_collaboration_document_epoch.sql`은 `page_collaboration_state`에 null이 아닌 `document_epoch`를 추가합니다. 공유 비활성화 후 재활성화처럼 협업 기록을 의도적으로 초기화할 때마다 epoch가 갱신됩니다. 세션 티켓, WebSocket room, 영속 업데이트, 관계형 스냅샷, 브라우저 복구 레코드는 모두 이 epoch에 연결됩니다.

마이그레이션 `022_server_authoritative_collaboration_materialization.sql`은 `materialization_version`을 추가합니다. 기존 행의 기본값은 버전 `0`이며, 이는 이전 빌드에서 브라우저가 제공한 중복 스냅샷으로 업데이트 마커가 진행되었을 가능성이 있음을 의미합니다. 버전 `1`은 업데이트된 서버가 durable Yjs 로그에서 관계형 상태를 재구성한 뒤에만 기록됩니다. 비어 있지 않은 기록에 대해 파괴적 작업이나 교체 작업은 정확한 최신 업데이트 마커와 현재 provenance 버전을 모두 요구합니다.

마이그레이션 `068_collection_sharing.sql`은 `READ`/`WRITE`/`ADMIN` 권한과 권한별 generation을 갖는 `collection_shares`, 그리고 각 페이지를 지배하는 사용자 지정 컬렉션을 materialize하기 위한 `page_collection_memberships`를 추가합니다. 마이그레이션은 기존 페이지 계층에서 멤버십을 재귀적으로 백필합니다. 런타임 생성/이동/복원 경로는 이 materialized membership을 동기화 상태로 유지합니다.

Materialization 요청에서 의미 있는 입력은 서버가 발급한 document epoch와 마지막으로 받은 업데이트 ID뿐입니다. 업데이트 ID는 체크포인트일 뿐, 별도로 제공된 제목이나 블록 데이터가 해당 업데이트에 속한다는 증거가 아닙니다. 서버는 페이지와 Yjs 기록을 잠그고, 교체된 generation이나 오래된 체크포인트를 거부하며, 순서대로 `page_yjs_updates`를 재생하고, 재구성된 문서를 디코딩·검증합니다. 동시에 존재하는 오래된 첨부파일 맵보다 첨부파일 삭제 tombstone을 우선하고, 위조된 첨부파일 블록을 막고, 하나의 트랜잭션에서 제목과 블록을 기록한 뒤 마지막으로 업데이트 ID와 provenance 버전을 기록합니다. 기존 브라우저 필드는 무시됩니다. Compaction은 서버 측 Yjs 문서가 다시 인코딩한 전체 상태 업데이트를 영속적으로 저장하고, 대체 업데이트가 커밋된 뒤에만 이전 업데이트 행을 제거합니다.

모든 일반 업데이트와 compaction 쓰기는 페이지 및 협업 상태 행 잠금을 유지한 상태에서 room의 메모리 내 `maxUpdateId`와 영속 저장소의 `MAX(page_yjs_updates.id)`를 비교합니다. 다른 애플리케이션 프로세스가 커밋한 업데이트를 놓친 프로세스 로컬 room은 삽입이나 기록 삭제 전에 무효화됩니다. 연결된 클라이언트는 종료 코드 `1011`을 받고 재연결한 뒤 영속 기록을 재생하고, 아직 승인받지 못한 전체 문서 복구 상태를 다시 전송합니다. 스냅샷 쓰기는 추가로 정확한 `baseUpdateId` 검사를 유지합니다. 이는 fail-closed 무결성 fence이며, 프로세스 간 실시간 fan-out을 제공하는 것은 아닙니다.

일반 문서의 마지막 유효 공유 권한이 제거될 때 BrainVault는 협업 기록을 삭제하기 전에 현재 서버 구현에서 최신 승인 Yjs 업데이트가 materialize되어 있어야 한다고 요구합니다. 같은 provenance gate가 보관, 영구 삭제, 내보내기, 워크스페이스 복원을 보호합니다. 협업자 권한을 제거하거나 변경하면 영향을 받는 권한 generation이 즉시 무효화되고 해당 활성 소켓이 닫힙니다. 보관 시에는 전체 room을 닫지만 실시간 협업이 일시 중지되는 동안 권한은 유지하며, 영구 삭제는 페이지와 해당 권한을 함께 제거합니다.

## 문서 교체 및 오프라인 복구

전체 워크스페이스 복원, 마지막 공유 권한 제거, 또는 나중의 첫 공유는 같은 페이지 ID를 재사용하면서 Yjs 기록을 의도적으로 교체할 수 있습니다. 따라서 페이지 ID만으로는 안전한 복구 경계가 될 수 없습니다. BrainVault는 `documentEpoch`를 generation fence로 사용합니다.

- HTTP 세션 응답과 서명된 WebSocket 티켓에 현재 epoch가 포함됩니다.
- WebSocket 업그레이드는 room에 참여하기 전에 이를 검증합니다.
- 모든 데이터베이스 쓰기는 페이지/상태 행 잠금을 유지한 채 다시 확인합니다.
- 스냅샷 materialization에도 동일한 epoch가 필요합니다.
- 로컬 브라우저 복구 키에는 epoch와 원본 탭 ID가 모두 포함됩니다.
- 기존 또는 일치하지 않는 복구 레코드는 병합되거나 덮어써지지 않고 별도의 복구 그룹으로 계속 표시됩니다.

문서 generation이 변경되면 연결된 클라이언트는 WebSocket 종료 코드 `4011`을 받습니다. 승인되지 않은 로컬 상태는 페이지가 다시 로드되기 전에 generation별 브라우저 복구 레코드에 남습니다. 세션 생성에는 `documentEpochProtocol: 2`가 필요하고 WebSocket 업그레이드에는 `brainvault-yjs-v2`가 필요합니다. 이 두 버전 fence는 수정 전 캐시된 탭 또는 롤링 재시작 직전에 발급된 티켓이 패치된 writer에 재연결해 오래된 SQL 첨부파일 위치를 다시 게시하는 것을 방지합니다. 새로고침하면 호환 클라이언트를 로드하면서 이전 브라우저 복구 레코드는 수동 검사를 위해 보존합니다.

## 인증 및 네트워크 요구 사항

WebSocket 티켓은 인증된 사용자 ID, 페이지 ID, document epoch가 들어 있는 수명이 짧은 JWT입니다. URL이 아니라 전용 WebSocket 서브프로토콜로 전송됩니다. 업그레이드 핸들러는 다음을 확인합니다.

- 정확한 협업 경로와 페이지 ID
- 브라우저 `Origin`이 설정된 same-origin/CORS 정책과 일치하는지
- RFC 6455 버전, 키, 프로토콜, 마스킹, 프레임 및 메시지 제한
- 업그레이드 전 현재 페이지 접근 권한과 연결 중 주기적인 재확인
- 연결별 프레임 및 바이트 속도 제한

직접 Posh-ACME 모드는 네이티브 HTTPS 리스너에서 보안 WebSocket 업그레이드를 허용합니다. 운영 환경 리버스 프록시는 `/api/collaboration/`의 WebSocket 업그레이드를 전달하고 `Origin`, `Host`/`X-Forwarded-Host`, `X-Forwarded-Proto`를 보존해야 합니다.

내장 room fan-out은 프로세스 로컬 방식입니다. BrainVault는 데이터베이스 범위의 시작 lease를 사용하여 MariaDB 데이터베이스 하나당 활성 애플리케이션 프로세스를 하나만 허용하므로, 실수로 두 번째 프로세스를 실행하면 네트워크 트래픽을 받기 전에 실패합니다. 공유 rate/admission 저장소, 공유 pub/sub backplane, 분산 room/update coordination이 구현되기 전까지 다중 프로세스 또는 다중 호스트 배포는 지원되지 않습니다.

프록시 모드에서는 직접 연결된 프록시가 `TRUST_PROXY_ADDRESSES`와 일치해야 합니다. 숫자 기반 hop trust는 거부됩니다. BrainVault는 해당 peer에서 하나의 정식 `X-Forwarded-Proto: https` 값만 인정하고, 보안 세션 쿠키를 유지하며, 공개 페이지 URL에서 `wss:` 브라우저 연결을 유도합니다. 평문 백엔드 HTTP 요청은 `HTTPS_REDIRECT` 설정에 따라 고정된 `PUBLIC_ORIGIN`으로 리디렉션되거나 거부됩니다. Posh-ACME 모드에서는 리스너 자체가 HTTPS이므로 forwarded-protocol 신뢰가 필요하지 않습니다.

직접 Posh-ACME와 완전한 Caddy, NGINX, Nginx Proxy Manager, Synology DSM 설정은 저장소의 [HTTPS 배포 가이드](../../../deploy/README.md)에 있습니다. 포함된 NGINX 예시는 공유 location에서 WebSocket 업그레이드 헤더를 전달하므로 일반 API 요청과 `/api/collaboration/`이 같은 백엔드 포트를 사용합니다.

브라우저는 `/vendor/yjs/yjs.mjs`에서 고정된 `yjs@13.6.31` ESM 빌드를 불러옵니다. BrainVault는 lockfile로 제어되는 `yjs`, `lib0`, `isomorphic.js` 패키지의 JavaScript 모듈 파일만 노출하며, CSP 해시가 있는 인라인 import map은 Yjs bare module specifier를 같은 origin의 경로로 해석합니다. 제3자 Yjs CDN 접근은 필요하지 않습니다. 이 same-origin 모듈 URL들은 content-versioned가 아니라 안정된 경로이므로 장기 `immutable` 캐싱 대신 재사용 시 재검증이 필요합니다. 이를 통해 새로 열린 탭이 배포 전 협업 런타임을 계속 유지하지 않도록 합니다.

## 검증

Node.js 22.x 계열에서는 22.23.2 이상, Node.js 24.x 계열에서는 24.18.1 이상, 또는 Node.js 26.5.1 이상에서 협업 전용 결정적 검사를 실행하세요.

```bash
npm run reproduce:materialization-loss
npm run reproduce:cross-instance-loss
npm run reproduce:recovery-write-loss
npm run reproduce:attachment-position-loss
npm run test:durability
npm run verify:collaboration
npm run verify:data-loss
```

Materialization 재현은 관계형 정식 상태가 잠긴 durable Yjs 기록에서 다시 만들어짐을 입증합니다. Cross-instance 재현은 오래된 프로세스 로컬 room이 더 최신의 durable tip 위에 append하거나 compact할 수 없음을 입증합니다. Recovery-write 재현은 브라우저 편집이 화면에 보이기 전에 영속화되는지 검증합니다. Attachment-position 재현은 관계형 materialization 전에 재연결하더라도 승인된 Yjs 이동 위에 오래된 SQL parent/order 필드를 다시 게시하지 않으며 정식 파일 메타데이터는 서버가 소유함을 입증합니다. 협업 검증기는 네 가지 손실 시나리오, 프로토콜 버전 fencing, 소스 연결, 정확한 Yjs 의존성 pin 및 무결성, materialization provenance, durable-room 최신성, 실행 가능한 모든 프로젝트 JavaScript/TypeScript 구문, 블록 계층 불변조건, RFC 6455 handshake accept 값, 마스킹된 텍스트 및 바이너리 프레임, 분할 메시지, Ping/Pong 동작, JSON 서버 프레임, 마스킹되지 않은 클라이언트 프레임 거부를 검사합니다. Vitest 스위트에는 서버 측 Yjs 병합, materialization, 격리, 잘못된 업데이트, 크기 제한, write-checkpoint 테스트도 포함됩니다.

일반 프로젝트 검사는 그대로 다음과 같습니다.

```bash
npm run build
npm test
```
