# Account security and UI request-scope review

Date: 2026-08-05

## Executive conclusion

The attached working tree already used generation guards for avatar, profile, language, theme, page-cover, icon-picker, search, version-history, and collaboration operations. The account-security panel, page-share dialog, and primary workspace navigation did not consistently apply the same target-and-generation rule.

Three deterministic async races were reproduced and corrected:

1. Account-A login history, passkey names, MFA status, or a TOTP setup secret could remain visible or arrive late after account B became current.
2. A delayed share-list response for page A could overwrite the open share dialog for page B. A remove action built from that stale list would then use the current page-B URL with an account-A collaborator ID.
3. A slow first page request could complete after a faster second page request and replace the user’s latest navigation choice.

Authentication reset also left native page-version and page-cover dialogs outside the explicit close/reset sequence. Those dialogs are now closed at the authentication boundary.

## Intended design policy

The recent project history establishes a consistent browser-side policy:

- an async operation is bound to the account or page that initiated it;
- closing a surface or crossing an authentication boundary invalidates in-flight UI reconciliation;
- newer user intent supersedes older unresolved intent;
- sensitive account state is cleared before another identity can render the same controls;
- stale responses may finish at the transport/server layer, but they cannot mutate current browser state.

The corrections below extend that existing policy rather than introducing a new architecture.

## Finding 1: account-security state crossed authentication boundaries

### Reproduction

The vulnerable sequence is deterministic:

1. Account A opens Security and starts login-history, MFA-status, or TOTP-setup requests.
2. The settings surface closes or authentication is reset.
3. Account B becomes current and opens the same controls.
4. Before B’s fresh responses arrive, retained account-A login attempts and passkey names are rendered from shared state.
5. A delayed account-A response arrives after B’s response and overwrites B’s current data.
6. A delayed TOTP setup response can populate account A’s enrollment secret in the account-B settings surface.

`npm run reproduce:account-security-auth-boundary` emits both the vulnerable and corrected outcomes.

### Correction

`public/app.js` now:

- owns independent generation guards for login history, MFA status, password change, TOTP setup/verification/disable, and passkey registration;
- validates both operation generation and current account ID before every sensitive response is applied;
- checks the account again between the passkey options request, the asynchronous WebAuthn credential ceremony, and challenge verification;
- keeps passkey registration controls disabled while that ceremony is in flight, even if a concurrent MFA-status render completes;
- invalidates every account-security operation when settings close or authentication resets;
- clears login history, MFA status, passkey names, TOTP setup token, QR image, and secret text before another account can render them;
- closes page-version history, page-cover picker, and cover-position controls during authentication reset, and clears retained version-detail state;
- prevents a delayed password-change response from re-entering the authenticated shell after its originating account surface is no longer current.

## Finding 2: page-share list could be applied to the wrong page

### Reproduction

1. Open page A’s share dialog and delay `GET /api/pages/page-a/shares`.
2. Navigate to page B and open its share dialog.
3. Resolve page B’s request first, then page A’s request.
4. The vulnerable client renders page A’s collaborators while page B is selected.
5. Clicking Remove constructs a page-B route using the stale page-A collaborator ID.

`npm run reproduce:share-dialog-request-race` proves the wrong-page route and the corrected result.

### Correction

The share dialog now binds every load to:

- the captured page ID;
- the current dialog-open state;
- ownership of that same current page;
- a monotonically increasing dialog request generation.

Closing the dialog or changing pages invalidates the generation and clears the list. The page is rechecked after pending edits flush and again after the network response. Stale success and error responses are ignored.

## Finding 3: slower navigation could overwrite the latest click

### Reproduction

1. Click page A and delay its page request.
2. Click page B and resolve B first.
3. Resolve A afterward.
4. The vulnerable client ends on page A even though page B was the latest intent.

`npm run reproduce:workspace-navigation-race` demonstrates the ordering failure and correction.

### Correction

Home, collection, and page navigation now share one workspace navigation generation. The generation is checked:

- before navigation side effects;
- after page fetches;
- after collaboration teardown;
- before final status and draft reconciliation;
- when a fetched page redirects into collection navigation.

A stale first request can finish, but it cannot replace the state selected by a newer navigation. A failure from a superseded page request is also suppressed instead of replacing the current page’s status with an obsolete error.

## Why generation guards were used

The browser Fetch API can be canceled with `AbortController`, but the existing project API wrapper and operation-guard conventions are generation based. Generation checks also protect non-fetch asynchronous stages, including the WebAuthn credential ceremony, which returns a promise and can outlive the initiating UI state. The correction therefore follows the project’s established guard pattern and verifies state at every async boundary.

The review method also follows OWASP race-testing guidance by deliberately controlling simultaneous request completion order and checking for unexpected state changes.

## Regression coverage

New dependency-free tests:

- `tests/account-security-auth-boundary.node.test.mjs`
- `tests/share-dialog-request-race.node.test.mjs`
- `tests/workspace-navigation-race.node.test.mjs`

New deterministic reproductions:

- `scripts/reproduce-account-security-auth-boundary.mjs`
- `scripts/reproduce-share-dialog-request-race.mjs`
- `scripts/reproduce-workspace-navigation-race.mjs`

## Verification result

- 141/141 dependency-free Node durability tests passed.
- All three new vulnerable-versus-fixed reproduction scripts passed.
- Lockfile registry portability check passed for 346 resolved URLs.
- Data-loss guard verification passed.
- Collaboration/source/protocol verification passed, including syntax checks for 261 files.
- Security-hardening verification passed.
- `public/app.js` and all new JavaScript modules passed Node syntax checks.

## Validation-environment limitation

The project declares Node.js `^22.23.2 || ^24.18.1 || >=26.5.1` and enables npm `engine-strict`. The audit container provides Node.js `22.16.0`, so normal installation correctly stops at the engine gate. A validation-only forced install then reached the sandbox package mirror, which did not contain locked dependency artifacts including `zod@3.25.76` and `yjs@13.6.31`.

No `node_modules` directory was retained. The dependency-backed TypeScript build and Vitest suite are therefore not reported as executed. The dependency-free suite, deterministic reproductions, syntax checks, and project verifiers listed above are the checks completed in this environment.

## Repository preservation

The `.git` directory was not edited, deleted, regenerated, or pruned. Its complete file manifest and SHA-256 digest set were compared with the extracted baseline before packaging.
