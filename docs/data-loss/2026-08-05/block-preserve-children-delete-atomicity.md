# 빈 부모 블록 삭제의 자식 보존 원자성

검토일: 2026-08-05

## 재현된 결함

비협업 편집에서 자식이 있는 빈 블록을 Backspace/Delete로 제거하면 브라우저가 먼저 `POST /blocks/reorder`로 자식을 상위 형제 목록에 승격한 뒤, 별도의 `DELETE /blocks/:id` 요청으로 빈 부모를 삭제했습니다.

첫 요청이 커밋된 뒤 두 번째 요청이 인증 만료, 버전 충돌, 전송 중단 등으로 확정 실패하면 다음 상태가 영구적으로 남았습니다.

- 삭제 대상 빈 부모는 그대로 존재함
- 자식은 이미 상위 계층으로 이동함
- 형제 순서는 첫 요청 결과로 바뀜
- 사용자가 의도한 한 번의 삭제가 부분 적용됨

`npm run reproduce:block-preserve-children-delete`는 이 두 요청 모델의 부분 커밋과 단일 트랜잭션 모델의 전체 롤백을 독립적으로 재현합니다.

## 수정

- 브라우저의 선행 reorder 요청을 제거했습니다.
- `DELETE /api/blocks/:blockId`에 `preserveChildren` 및 `expectedPageContentVersion` 보호 조건을 추가했습니다.
- 서버는 페이지 행과 전체 블록 계층을 잠근 뒤 다음을 하나의 SQL 트랜잭션에서 수행합니다.
  1. 대상 하위 트리의 정확한 edit version 스냅샷 확인
  2. 페이지 content version 확인으로 형제 목록의 오래된 스냅샷 차단
  3. 즉시 자식을 대상 부모 위치로 승격하고 형제 순서 재번호화
  4. 대상 블록 삭제
  5. 페이지 콘텐츠 버전 및 버전 이력 기록
- 중간 단계가 실패하면 트랜잭션 전체가 롤백됩니다.
- 보존된 자식의 브라우저 초안은 삭제하지 않고 실제로 제거된 대상 블록의 초안만 정리합니다.
- 협업 모드는 자식 승격과 대상 삭제를 하나의 Yjs 로컬 mutation으로 합쳤습니다.

## 회귀 보호

- `tests/block-preserve-children-delete.node.test.mjs`
- `scripts/reproduce-block-preserve-children-delete-race.mjs`
- `scripts/verify-data-loss-guards.mjs`의 정적 원자성 검사
