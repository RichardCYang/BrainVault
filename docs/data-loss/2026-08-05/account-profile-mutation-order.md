# Account profile mutation ordering and preference race review

Date: 2026-08-05

## Executive conclusion

A reproducible browser-side race existed across every client mutation that writes through `PATCH /api/auth/profile`: display name/avatar, preferred language, theme, and the default collection icon.

Each event handler started its own asynchronous request. A later user choice could therefore reach the server and finish first, after which an older request could finish last and become the durable database value. Full `user` responses were also assigned directly to client state, so stale success or failure handling could revert the visible theme or language.

## Vulnerable sequence

1. The user changes the theme from light to dark.
2. Before the first request completes, the user changes it back to light.
3. The light request completes first and stores the newest choice.
4. The older dark request completes later.
5. The database and browser state end on dark even though light was the latest intent.

The same ordering hazard applied when different account-setting controls wrote the shared profile resource at nearly the same time.

## Root cause

- Browser event dispatch does not serialize asynchronous event-handler completion.
- Profile PATCH callers had no shared write-order boundary.
- Language and theme handlers had no latest-operation guard.
- Failure rollback used values captured before other pending profile mutations were confirmed.
- A queued request from an old authenticated account needed to be prevented from starting after logout or account replacement.

## Correction

- Added `public/account-profile-mutation-queue.js`.
- Routed every browser call to `PATCH /api/auth/profile` through one account-scoped FIFO queue.
- Included language's pending-page flush inside the queued operation so event order cannot be inverted before the PATCH starts.
- Added independent latest-operation guards for language and theme UI reconciliation.
- Successful serialized responses update the confirmed user state, while only the latest same-field operation changes visible controls and status messages.
- Error rollback now uses the latest confirmed server-backed preference rather than a stale value captured before pending writes completed.
- Authentication reset invalidates the queue and both preference guards. In-flight old-account results are ignored, and not-yet-started old-account operations are cancelled before issuing a request.

## Reproduction

```bash
npm run reproduce:account-preference-race
```

The script forces hostile completion timing. Expected results:

```json
{
  "vulnerable": {
    "finalTheme": "dark",
    "latestSelectionLost": true
  },
  "fixed": {
    "finalTheme": "light",
    "latestSelectionPreserved": true,
    "laterWriteStartedBeforeEarlierCompleted": false
  }
}
```

## Regression coverage

Added `tests/account-profile-mutation-queue.node.test.mjs`, covering:

- FIFO execution when a later operation is ready to finish first;
- continuation after a failed mutation;
- suppression of in-flight results after an authentication boundary;
- cancellation of queued old-account writes;
- one shared queue for every profile PATCH caller;
- deterministic vulnerable and corrected preference-race reproduction.

## Verification result

- 133/133 dependency-free Node durability tests passed.
- 22/22 standalone reproduction scripts passed.
- Data-loss guard verification passed.
- Collaboration verification passed.
- Security-hardening verification passed.
- JavaScript syntax validation passed for all inspected browser, script, and Node-test modules.
- Lockfile registry portability verification passed.
