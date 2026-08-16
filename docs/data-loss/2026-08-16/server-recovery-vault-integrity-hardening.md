# Server recovery vault integrity hardening

Date: 2026-08-16

## Scope

This change hardens the last-resort server recovery vault without changing normal note editing, collaboration, upload admission, deduplication, or recovery quota semantics.

## Destructive authorization

A recovery candidate is durable custody for `principal_id`. Page ownership (`owner_id`) may continue to grant read/download visibility where the existing product semantics require it, but it no longer grants destructive authority over another principal's recovery candidate.

`deleteRecoveryCandidate()` now deletes only when both candidate ID and authenticated `principal_id` match. This prevents a page owner from deleting a collaborator's candidate after the collaborator's browser has handed off and removed its local orphaned recovery copy.

## End-to-end payload integrity

Recovery uploads already record SHA-256 at admission. The read path now recomputes SHA-256 over the stored BLOB before returning it. If the stored digest is malformed or the bytes no longer match, the server raises `RECOVERY_CANDIDATE_INTEGRITY_FAILED` and does not return the payload.

The browser independently hashes the actual response bytes with Web Crypto before creating the download. It requires the actual SHA-256, the candidate-list SHA-256, and the response `X-BrainVault-Recovery-SHA256` header to match exactly. Any mismatch fails closed and no download is triggered.

## Regression invariants

- Candidate owner and recovery principal may be different.
- Only the recovery principal can delete that candidate.
- A corrupt stored BLOB is rejected before server response payload delivery.
- A response whose bytes or SHA-256 header disagree with the candidate metadata is rejected before browser download.
- Local orphaned recovery remains removed only after successful durable server handoff, preserving the existing handoff ordering.
