# Account profile authentication-boundary queue isolation review

Date: 2026-08-05

## Executive conclusion

The shared browser-side profile mutation queue correctly serialized same-account writes and suppressed stale results after logout or account replacement. However, queue invalidation advanced only a generation counter and retained the old promise tail. If an already-started account-A request never settled, the first account-B profile write was chained behind that invalidated request and could not start.

This violated the intended authentication boundary: old-account results were isolated, but old-account latency was still inherited by the new session.

## Reproducible sequence

1. Account A starts `PATCH /api/auth/profile`.
2. The request remains unresolved because the network connection stalls.
3. Authentication state is reset and account B becomes current.
4. Queue invalidation rejects application of account-A results.
5. Account B changes a profile preference.
6. The account-B operation is appended to the unresolved account-A promise tail and does not begin until the old request settles.

The defect is deterministic and does not require server or database access; it is reproduced with a deferred promise.

## Root cause

`invalidate()` incremented the queue generation but did not create a new scheduling tail. Generation checks protected state reconciliation and prevented queued old-account operations from issuing requests, yet the physical FIFO chain remained shared across generations.

## Correction

`invalidate()` now performs both authentication-boundary actions:

- increment the generation so old results and not-yet-started old operations remain suppressed;
- reset the active tail to a resolved promise so the next authenticated generation can schedule independently.

Already-started old operations retain their captured chain and settle safely. New-generation operations no longer wait for them, while same-generation FIFO ordering remains unchanged.

## Reproduction

```bash
npm run reproduce:account-profile-auth-boundary-stall
```

Expected decisive fields:

```json
{
  "vulnerable": {
    "newAccountStartedBeforeOldRelease": false,
    "newAccountBlockedByOldGeneration": true
  },
  "fixed": {
    "newAccountStartedBeforeOldRelease": true,
    "newAccountBlockedByOldGeneration": false
  }
}
```

## Regression coverage

`tests/account-profile-mutation-queue.node.test.mjs` now verifies that:

- a new account operation starts while the invalidated old-account operation is still unresolved;
- the old result remains suppressed after it eventually settles;
- the new result is applied normally;
- the standalone vulnerable-versus-fixed reproduction remains deterministic.

## Scope and safety

The change is isolated to browser profile mutation scheduling. It does not alter API payloads, server authorization, database writes, same-account FIFO semantics, or the existing generation checks.

## Verification result

- 135/135 dependency-free Node durability tests passed.
- 23/23 standalone reproduction scripts passed.
- Data-loss guard verification passed.
- Collaboration verification passed, including syntax validation for 255 files.
- Security-hardening verification passed.
- Lockfile registry portability verification passed for 346 resolved URLs.
- The focused vulnerable-versus-fixed reproduction confirmed that the new account starts before the old deferred operation is released.

## Validation-environment limitation

The project declares Node.js `^22.23.2 || ^24.18.1 || >=26.5.1` with strict engine enforcement. The audit sandbox provides Node.js `22.16.0`, so the normal dependency installation correctly stopped at the engine gate. A validation-only engine bypass then reached the sandbox package mirror, which did not contain the locked `zod@3.25.76` artifact. No `node_modules` directory was retained. Consequently, the dependency-backed TypeScript build and Vitest suite were not reported as executed; all checks listed above are the tests that completed in this environment.
