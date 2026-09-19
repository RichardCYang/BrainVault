# 컬렉션 공유

BrainVault는 **사용자 지정 컬렉션**에 대한 컬렉션 수준 접근 권한을 지원합니다. 컬렉션 권한은 해당 컬렉션과, 중첩된 하위 페이지를 포함하여 그 컬렉션에 속하는 모든 일반 페이지에 적용됩니다. 이 기능은 브라우저 UI, REST API, MariaDB 마이그레이션, 유효 접근 권한 resolver, Yjs 협업 서버, 백업/복원 경로, 내구성 테스트까지 전체 경로에 구현되어 있습니다.

## UI에서 **컬렉션 공유** 찾기

컬렉션 공유 진입점은 전역 메뉴가 아니라 의도적으로 현재 문맥에 따라 표시됩니다.

1. 컬렉션 소유자 또는 `ADMIN` 권한을 가진 협업자로 로그인합니다.
2. 왼쪽 사이드바에서 **사용자 지정 컬렉션의 이름**을 클릭합니다. 그 안의 문서 페이지를 열지 마세요.
3. 컬렉션 랜딩 뷰에서 **페이지 추가(Add page)** 옆의 **컬렉션 공유(Share collection)**를 선택합니다.
4. 기존 BrainVault 로그인 ID를 입력하고 `READ`, `WRITE`, `ADMIN` 중 하나를 선택합니다.

다음 중 하나에 해당하면 버튼이 숨겨집니다.

- 현재 뷰가 가상 **기본 컬렉션(Default Collection)**인 경우
- 컬렉션 랜딩 뷰가 아니라 개별 문서 페이지가 열려 있는 경우
- 로그인한 계정이 `READ` 또는 `WRITE` 권한만 가진 경우
- 활성 항목이 영속적으로 저장된 사용자 지정 컬렉션이 아닌 경우

사이드바 컬렉션의 점 3개 메뉴는 공유 진입점이 아닙니다. 일반 페이지 하나를 직접 공유하는 기능은 해당 페이지의 **공유(Share)** 버튼에서 계속 사용할 수 있습니다.

## 권한 모델

| 권한 | 유효 페이지 역할 | 문서 읽기 | 공유 문서 편집 | 페이지/컬렉션 작업 관리 | 공유 관리 |
| --- | --- | --- | --- | --- | --- |
| `READ` | `READER` | 예 | 아니요 | 아니요 | 아니요 |
| `WRITE` | `EDITOR` | 예 | 예 | 아니요 | 아니요 |
| `ADMIN` | `ADMIN` | 예 | 예 | 예, 공유된 컬렉션 범위 내 | 예 |

`READ` 클라이언트는 이미 공유된 일반 페이지의 실시간 Yjs 스트림에 참여해 현재 및 이후 문서 업데이트를 받을 수 있지만, WebSocket 서버는 연결을 쓰기 불가로 표시하고 바이너리 문서 쓰기를 `COLLABORATION_READ_ONLY`로 거부합니다.

`WRITE`는 일반적인 공유 문서 편집을 허용하지만 공유 관리나 페이지 관리 컨트롤은 노출하지 않습니다.

`ADMIN`은 의도적으로 더 강한 권한입니다. 공유 컬렉션 범위 내에서 컬렉션 공유 및 지원되는 페이지/컬렉션 관리 작업에 필요한 관리자 검사를 충족합니다. 직접 페이지 공유 생성은 계속 소유자 전용이므로 컬렉션 관리자가 자신에게 권한을 준 컬렉션 권한보다 오래 남는 낮은 우선순위 권한을 만들 수 없습니다. 컬렉션 관리자는 범위 제한을 받으며, 공유 컬렉션 밖으로 페이지를 이동하려고 하면 `COLLECTION_ADMIN_SCOPE_REQUIRED`로 거부됩니다.

## 범위 및 상속

마이그레이션 `068_collection_sharing.sql`은 두 구조를 만듭니다.

- `collection_shares`: `(collection_id, user_id)`별 하나의 권한으로 `READ`, `WRITE`, `ADMIN`, `shared_by`, 인과적 `generation` 토큰을 가집니다.
- `page_collection_memberships`: 컬렉션 자체와 모든 하위 페이지에 대한 materialized 사용자 지정 컬렉션 멤버십입니다.

컬렉션은 루트 객체이며 그 아래 페이지는 중첩될 수 있습니다. 멤버십은 재귀적이므로 권한은 직접 자식뿐 아니라 모든 하위 페이지에 전달됩니다.

컬렉션 아래에 페이지를 만들면 멤버십이 즉시 기록됩니다. 페이지 하위 트리를 이동하면 BrainVault가 해당 하위 트리의 멤버십을 교체합니다. 이동으로 유효 공유 집합이 달라지면 서버는 활성 쓰기를 fence하고 복구 후보를 보존하며 영향을 받는 Yjs 문서 generation을 초기화한 뒤, 대체된 협업 lineage만 연결 종료합니다.

## 컬렉션 권한과 직접 페이지 권한 비교

한 사용자가 같은 멤버 페이지에 두 종류의 접근 권한을 모두 가진 경우 컬렉션 권한이 우선합니다. 유효 접근 권한 resolver는 `page_shares`보다 `collection_shares`를 먼저 확인합니다.

즉 다음과 같습니다.

- 컬렉션 `READ` + 직접 페이지 `EDIT` => 컬렉션 권한이 존재하는 동안 유효 역할은 `READER`
- 컬렉션 `WRITE` + 직접 페이지 `EDIT` => 컬렉션 권한에 의한 유효 역할은 `EDITOR`
- 컬렉션 `ADMIN` + 직접 페이지 `EDIT` => 컬렉션 권한에 의한 유효 역할은 `ADMIN`

워크스페이스 소유자가 만든 독립적인 직접 페이지 권한은 컬렉션 권한 아래에 저장된 채 남을 수 있습니다. BrainVault는 컬렉션 공유가 이 권한을 대체할 때 해당 generation을 회전시켜 지연된 소켓 정리가 나중 세션을 내보내지 못하게 합니다. 컬렉션 권한이 제거되고 소유자가 만든 직접 권한이 여전히 유효하면, 직접 페이지 권한이 다시 효력을 가질 수 있습니다. 컬렉션 관리자가 권한을 박탈당하면 BrainVault는 멤버 페이지 중 `shared_by` provenance가 해당 관리자를 가리키는 직접 페이지 권한도 제거합니다. 이는 관리자가 심어둔 권한이 관리자 권한 박탈 후에도 남는 것을 방지합니다.

## REST API

모든 엔드포인트는 일반적인 인증된 BrainVault 세션이 필요합니다. 컬렉션 공유는 컬렉션 소유자 또는 해당 컬렉션에서 유효 역할이 `ADMIN`인 계정이 관리할 수 있습니다.

| 메서드 | 경로 | 용도 |
| --- | --- | --- |
| `GET` | `/api/collections/:collectionId/shares` | 현재 컬렉션 권한 목록을 조회합니다. |
| `POST` | `/api/collections/:collectionId/shares` | 기존 계정을 `READ`, `WRITE`, `ADMIN` 권한으로 추가합니다. |
| `PATCH` | `/api/collections/:collectionId/shares/:userId` | 현재 `expectedGeneration`을 사용해 권한 수준을 변경합니다. |
| `DELETE` | `/api/collections/:collectionId/shares/:userId` | 현재 `expectedGeneration`을 사용해 권한을 제거합니다. |

생성 요청 본문 예시:

```json
{
  "username": "collaborator-id",
  "permission": "WRITE"
}
```

업데이트 요청 본문 예시:

```json
{
  "permission": "ADMIN",
  "expectedGeneration": "cshare_current_generation"
}
```

제거 요청 본문 예시:

```json
{
  "expectedGeneration": "cshare_current_generation"
}
```

Generation은 인과적 토큰입니다. 다른 세션이 이미 권한을 변경했다면 오래된 업데이트/제거 요청은 대체 권한을 변경하지 않고 `409 COLLECTION_SHARE_GENERATION_CHANGED`로 실패합니다.

## 실시간 협업 동작

컬렉션 공유는 실질적으로 공유되는 각 **일반 문서**에 직접 페이지 공유와 같은 협업 모델을 적용합니다. 컬렉션 자체는 Yjs 문서가 아닙니다.

문서에 첫 번째 유효 협업자가 생기면 BrainVault는 정식 SQL 스냅샷에서 새 협업 lineage를 시작합니다. 쓰기 가능한 소유자/`WRITE`/`ADMIN` 사용자는 Yjs 업데이트를 제출할 수 있습니다. `READ` 사용자는 동기화된 상태를 받지만 쓸 수 없습니다. 권한 강등이나 취소 시에는 기존 쓰기 권한 연결을 끊기 전에 복구 admission을 보존합니다.

컬렉션 권한을 제거한다고 모든 멤버 페이지의 협업을 무조건 비활성화하지는 않습니다. 서버는 먼저 권한이 박탈된 관리자가 만든 멤버 페이지 직접 권한을 제거한 뒤, 소유자가 독립적으로 만든 직접 권한까지 포함하여 페이지별 유효 공유 권한을 다시 계산합니다. 문서의 마지막 유효 공유 권한이 사라지고 승인된 모든 Yjs 업데이트가 안전하게 materialize된 경우에만 해당 문서의 협업 기록을 해제합니다.

## 백업 및 복원

현재 버전 5 백업은 `data.pageShares`와 함께 `data.collectionShares`를 요구합니다. 컬렉션 레코드는 컬렉션 ID, 안정적인 협업자 계정 ID, 사용자 이름, 권한, 생성 시각, 업데이트 시각을 보존합니다. 복원은 파괴적인 워크스페이스 교체 전에 협업자 신원을 검증하고, `page_collection_memberships`를 다시 구축하며, 원본 권한의 타임스탬프를 보존하면서 새 generation으로 컬렉션 권한을 재생성합니다.

명시적 `collectionShares`가 도입되기 전의 구버전 4 아카이브는 복원 후에도 남아 있는 컬렉션 ID에 대해 현재 유효한 컬렉션 권한을 조용히 삭제하지 않고 보존합니다. `updated_at`이 도입되기 전의 버전 4 컬렉션 레코드도 과거 타임스탬프 fallback으로 가져올 수 있습니다. v4 이전 백업은 컬렉션 공유 데이터를 선언할 수 없으며, v5가 엄격한 현재 내보내기 계약입니다.

## 문제 해결

### 버튼이 보이지 않음

먼저 **사용자 지정 컬렉션 이름**을 클릭했고 컬렉션 랜딩 뷰를 보고 있는지 확인하세요. 가장 흔한 경우는 컬렉션 안의 문서를 열었거나, 기본 컬렉션을 사용 중이거나, 소유자/`ADMIN`이 아니라 `READ`/`WRITE`로 로그인한 경우입니다.

### 직접 페이지 편집자가 읽기 전용이 됨

해당 계정에 컬렉션 수준 `READ` 권한도 있는지 확인하세요. 멤버 페이지에서는 컬렉션 권한이 우선하므로 컬렉션 권한이 존재하는 동안 `READ`가 의도적으로 직접 페이지 `EDIT` 권한을 덮어씁니다.

### 권한 변경 시 409 반환

공유 대화상자를 새로고침하거나 다시 연 뒤 최신 권한 generation으로 재시도하세요. 권한 변경과 제거는 generation 검사를 사용하므로 오래된 브라우저 동작이 더 새로운 접근 결정을 덮어쓸 수 없습니다.

### 대기 중인 협업 작업 때문에 접근 권한 제거가 차단됨

BrainVault는 협업 쓰기가 여전히 허용 중이거나 최신 승인 Yjs 상태가 안전하게 materialize되지 않았을 때 fail-closed로 동작합니다. 활성 문서가 동기화/materialize되도록 한 뒤 공유 변경을 다시 시도하세요.

## 구현 및 검증 참조

주요 구현 파일은 다음과 같습니다.

- `migrations/068_collection_sharing.sql`
- `src/lib/page-access.ts`
- `src/lib/collection-membership.ts`
- `src/routes/collection-sharing.routes.ts`
- `src/lib/collaboration-server.ts`
- `public/index.html`
- `public/app.js`
- `src/lib/data-transfer.ts`
- `tests/collection-sharing.node.test.mjs`

의존성 없는 집중 검사는 다음으로 실행할 수 있습니다.

```bash
node --test tests/collection-sharing.node.test.mjs
```

더 폭넓은 실시간 협업 검사는 `npm run verify:collaboration`과 루트 README에 설명된 일반 테스트 스위트를 사용하세요.
