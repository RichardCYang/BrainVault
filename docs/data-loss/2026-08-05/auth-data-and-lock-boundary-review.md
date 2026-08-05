# Authentication, account-data, and editor-lock boundary review

Date: 2026-08-05

## Executive conclusion

BrainVault already applies a consistent integrity policy to drafts, collaboration, profile changes, page covers, sharing, and navigation: an asynchronous result may update the browser only while the account, resource, and user intent that started it are still current.

A follow-up review found three remaining boundary groups where that policy was incomplete:

1. Boot-time cookie-session restoration, manual login, MFA completion, and authenticated-shell initialization could overlap and leave a stale identity or workspace result in browser state.
2. Backup export/import could finish after an authentication boundary, exposing an old account archive or applying old-account workspace results to the new account UI.
3. An old operation's `finally` block or retained browser transition lease could affect the editor lock state of a newly authenticated account.

All three groups were reproduced with controlled completion order and corrected without changing the server data model or the existing durable-draft policy.

## Intended design policy

The corrections extend the project's existing design rather than introducing a new convention:

- bind every asynchronous UI mutation to a generation and a stable account/resource key;
- invalidate in-flight work when authentication changes or the initiating surface closes;
- do not expose the authenticated workspace until its initial account-scoped page load has either completed or failed safely;
- preserve local drafts, but never preserve live lock counters, transition leases, or account-specific UI state across authentication;
- allow stale transport work to finish when it cannot be canceled safely, but prevent it from mutating the current browser state;
- serialize same-tab authentication mutations whose responses can update the browser-managed session cookie.

## Finding 1: boot restoration could outlive a newer manual login

### Reproduction

1. The application starts `GET /api/auth/me` to restore an HttpOnly-cookie session.
2. Before that request resolves, the user submits a manual login, which becomes the newer intent.
3. The manual login fails or is otherwise superseded before it commits a user.
4. The delayed boot request resolves and the vulnerable helper commits its old user to `state.authenticated` and `state.user`.
5. The browser can enter the shell for an identity that the current auth flow had already superseded.

### Correction

`public/session-bootstrap.js` now accepts an `isCurrent` predicate and treats restoration as an owned transaction:

- it checks currentness after user loading, authenticated UI initialization, and workspace loading;
- it snapshots the initial authentication state;
- if superseded after committing the boot user, it rolls back only when the state still contains that exact boot user;
- it never rolls back a newer manual login that has already committed another user.

`public/app.js` binds boot restoration to an auth-flow generation. The shell is rendered only after the initial page-list request settles, so a user cannot start workspace mutations while an older initialization response is still able to replace the page list.

## Finding 2: authentication and MFA completions were not fully serialized

Authentication endpoints set or clear an HttpOnly session cookie. Browser JavaScript cannot inspect the `Set-Cookie` response header, and ignoring a stale response body does not undo a cookie already processed by the user agent. Starting multiple same-tab login or MFA completion requests therefore creates a response-order risk that a UI-only generation check cannot fully solve.

### Correction

The client now:

- permits only one primary login/registration request at a time;
- disables login fields, mode switching, hash-driven mode changes, MFA method switching, and MFA cancellation while an authentication mutation is in flight;
- rechecks the auth generation between passkey options, the browser credential ceremony, server verification, and authenticated-shell completion;
- creates a separate authenticated-session initialization generation after login succeeds;
- invalidates that generation on logout, a 401 reset, or any other authentication boundary;
- fetches and commits the initial workspace page list before exposing the interactive shell;
- keeps a valid authenticated shell available with an error status if the initial workspace request fails.

The browser's native passkey prompt can still be canceled. The in-page MFA cancel control is disabled only while a server-side verification mutation is unresolved.

## Finding 3: backup transfer results could cross accounts

### Export reproduction

1. Account A starts backup export.
2. Authentication resets and account B becomes current before the response body is consumed.
3. The vulnerable client creates a download link from account A's delayed archive.
4. Account A's backup is downloaded while account B is the visible identity.

### Import reproduction

1. Account A starts backup import.
2. Account B becomes current while import or the subsequent page-list request is pending.
3. The vulnerable client applies account A's returned user and page list after account B is current.
4. A late `loadPages()` completion can overwrite account B workspace state even when a final stale check exists, because the mutation has already occurred inside `loadPages()`.

### Correction

Export and import now use an account-data operation guard keyed by user ID:

- account settings cannot close normally while a transfer is in progress, but authentication reset can force-close it;
- authentication reset invalidates the transfer generation and restores all transfer controls;
- export checks the account after workspace enumeration and after the full length-framed blob is received, before creating a download link;
- import checks the account before the upload, after the server response, after language application, after page fetching, and after returning home;
- the imported user ID must match the account that started the operation;
- page summaries are fetched into a local value and committed only after the account check, rather than using a helper that mutates global state before stale detection.

Server-side work that was already authorized may still complete for the originating account, but it cannot reconcile into a different account's browser state or trigger an old-account download.

## Finding 4: old lock finalizers could unlock a new account

### Reproduction

1. An account-A operation increments `state.pageEditLockDepth` and awaits network or persistence work.
2. Authentication reset sets the depth to zero.
3. Account B starts a new protected operation, setting the depth to one.
4. Account A's old `finally` block runs and decrements the shared depth to zero.
5. Editing becomes enabled while account B's protected operation is still active.

A related issue existed for `activePageTransitionLease`: retaining the old lease reference after authentication could make a new account appear permanently busy until the old callback completed.

### Correction

- Every page-edit lock captures `pageEditLockGeneration` when acquired.
- Authentication reset increments the generation and clears the depth.
- `unlockPageEdits()` ignores finalizers from an older generation.
- Authentication reset releases the owned durable transition record and clears `activePageTransitionLease`.
- The old callback still holds its authoritative Web Lock until it exits, so another tab cannot enter the same old-account transition merely because the browser UI reference was cleared.

## Deterministic reproduction and regression coverage

Added reproduction:

- `scripts/reproduce-auth-data-lock-boundary-races.mjs`
- `npm run reproduce:auth-data-lock-boundary`

Added dependency-free regression coverage:

- `tests/auth-data-lock-boundary.node.test.mjs`
- four additional supersession/ownership cases in `tests/auth-session-bootstrap.node.test.mjs`
- updated data-loss source verifiers and Vitest source assertions for guarded backup function signatures

The standalone script compares vulnerable and corrected outcomes for:

- stale boot-session commit;
- out-of-order authentication completion and MFA cancellation during verification;
- old-account backup download and import reconciliation;
- old-generation lock finalization and retained transition state.

## Verification result

- Dependency-free Node durability suite: **149/149 passed**.
- New follow-up regression cases: **8/8 passed**.
- Lockfile registry portability: **346 resolved URLs passed**.
- Data-loss guard verification: passed.
- Collaboration, protocol, and source verification: passed, including syntax checks for **263 files**.
- Security-hardening verification: passed, including **11/11** dependency-free remediation tests.
- Changed JavaScript modules and reproduction scripts: Node syntax checks passed.

## Validation-environment limitation

The project declares Node.js `^22.23.2 || ^24.18.1 || >=26.5.1` with npm `engine-strict`, while the review container provides Node.js `22.16.0`. A validation-only forced install also could not resolve locked artifacts from the sandbox package mirror, including `zod@3.25.76`.

The TypeScript build and dependency-backed Vitest suite are therefore not reported as executed. No `node_modules` directory is included in the corrected archive.

## Repository preservation

The `.git` directory is retained. Before packaging, its complete path list, file sizes, and SHA-256 digests are compared with the original uploaded archive so review commands cannot accidentally change repository metadata in the delivered copy.
