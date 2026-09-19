# BrainVault collaboration-save settlement audit

Date: 19 September 2026

Input: `BrainVault.zip`

Repository HEAD: `a83b35d0de22bd130aaf665c2c9c503949875604`

## Outcome and scope

Patched two collaborative direct-save entry points in `public/app.js` to prevent stale completions from overwriting newer visible input, acknowledging the wrong edit, or restoring a removed editor. Added 21 deterministic regression cases. Updated existing test harnesses without weakening authentication or data-retention assertions.

The newly added suite fails 13 of 21 cases against the exact uploaded `app.js`, and passes all 21 against the patched source. These are 13 failing regression scenarios, **not 13 independent vulnerabilities**. The final targeted run passes 118/118 checks. A separate native-runner fallback across 288 files passes 2,235 checks, with 11 failures attributable to missing dependencies or TypeScript module resolution; the same 11 failures and missing-module messages reproduce against the untouched upload.

This is not an end-to-end certification. The production build, official Vitest/tsx pipeline, live MariaDB integration, and full browser/Yjs/IndexedDB integration could not be completed in this environment. Exact blockers and failed-command logs are retained below and in `diagnostics.zip`.

## Git history and architectural intent

Git inspection used Python `subprocess` to invoke `git log`, `git show`, `git status`, `git diff`, `git ls-files`, and `git rev-parse`. Commands used `--no-optional-locks`, disabled optional filesystem monitoring/hooks/automatic GC through per-command configuration, and did not stage, commit, reset, check out, or change repository configuration.

Recent history includes HEAD `a83b35d` (stale-save callbacks and live-row/membership checks), `251dae0` (stale note saves), `33423a5` (admission revision checks), `117c70d` (page-deletion navigation ownership), and `3b3108f` (stale Yjs-room reuse). Those changes establish a consistent design: durable recovery before direct writes, latest-edit ownership, explicit authentication/page/session boundaries, and rejection of stale work rather than broad state replacement.

The upload reports many modified text files in raw Git status because its working tree uses CRLF while HEAD text uses LF. Before remediation, `git diff --ignore-space-at-eol` reported no substantive changes. The patch retains CRLF in all four modified existing files. Existing QA reports and embedded diagnostic archives are historical input and remain untouched; their claimed results are not counted as this audit's results.

### Files and boundaries reviewed

| Area | Core files | Review focus |
| --- | --- | --- |
| Browser editing and state | `public/app.js` | Direct/scheduled title and block saves, edit admission, live rows, navigation/authentication/session fences, deletion interaction |
| Recovery and queues | `public/save-queue.js`, `public/save-rebase.js`, `public/draft-store.js`, `public/collaboration-durability.js` | Latest-write ownership, persistence/recovery, acknowledgment and rebasing |
| Collaboration | `public/collaboration.js` | Local mutation promises and durability/session boundaries |
| Database and access | `src/lib/db.ts`, `src/lib/page-access.ts` | Transactions, current locking access checks, page/block identity and membership |
| Mutation/deletion routes | `src/routes/page.routes.ts`, `src/routes/block.routes.ts` | Auth-bound mutation admission, optimistic versions, mutation receipts, deletion guards |
| Import/recovery surfaces | `src/lib/data-transfer.ts` and related recovery/snapshot helpers | Existing validation and retention boundaries; no changes made |

The backend paths reviewed already use transactions, locked authorization/page state, optimistic concurrency tokens and replay handling. This audit does not claim an independently reproduced server-side database deletion bug. The confirmed findings concern browser completion ownership and its effect on visible data and recovery behavior.

## Confirmed findings and reproduction

### 1. Older direct collaborative failure can restore over newer input

Affected functions: `savePageTitleNow` and `saveBlockRow`.

Scheduled edits already register their mutation promises in `collaborationTitleMutationPromise` or `collaborationBlockMutationPromises`. The uploaded direct-save paths awaited the session mutation without joining those ownership slots. Their authentication/page/session checks distinguish sessions, but not successive edits in one session.

Deterministic reproduction:

1. Open a writable collaborative page with a ready session and an existing title/block.
2. Enter **A** and start a direct save; hold its local-mutation promise unresolved.
3. Enter **B** in the same editor and invoke the scheduled title/block edit path, leaving B pending.
4. Reject the older direct A promise while the same page/session remains active.
5. Observe the original title handler restore the previous title, or the original block handler invoke its editor-restore path over B. The patched code preserves B and leaves B's mutation tracked.

The title overwrite executes directly in the actual production function used by the test. The block test executes the actual production completion function but uses an explicit restore-handler double to observe and model canonical payload restoration. This is a deterministic callback reproduction, not a live browser/database crash experiment.

A related title variant enters a blank value after A without scheduling it. Originally A's rejection restores the earlier title over that deliberate blank. The patch checks the live input as well as promise ownership.

### 2. Older success can acknowledge the wrong edit

1. Start a direct collaborative save of A and hold its promise.
2. Enter and schedule B.
3. Resolve A before B.
4. Originally A can publish obsolete history or an old preview and clear block dirty/saving flags despite B remaining pending. The patch suppresses those UI acknowledgments.

The inverse ordering is also covered: schedule A, then directly save B. Both entry points now share one completion owner, so scheduled A cannot publish over the direct B save. An A → B → A case proves that equal text is insufficient; the newest promise must own the completion.

### 3. Completion can target a detached or removed block row

1. Begin a direct collaborative block save.
2. Before settlement, rebuild the editor row with the same payload, or remove/mark the block for deletion.
3. Resolve the mutation in the rebuilt-row case or reject it in a removal case.
4. Originally the success targets the detached row, or failure reaches the restore handler for a removed editor. The patch re-resolves the live row, checks current model membership/deletion state and payload equality, and updates only the eligible live editor.

All cases are implemented in `tests/collaboration-direct-save-settlement.node.test.mjs`.

## Applied patch

Only one production file changed: `public/app.js`.

Direct title/block saves now register their exact mutation promise in the existing scheduled-edit ownership slots before awaiting it. Completion can clear only its own slot. An obsolete success cannot publish UI state, history or previews; an obsolete failure preserves rejection to the initiating caller without restoring newer input. Existing authentication, page, session, writability, and recovery-storage checks remain in force.

Block settlement re-fetches the live row and validates current membership, deletion status and payload before restoration or acknowledgment. Title settlement preserves changed or blank live input, and current failures retain the existing recovery-storage failure path. Pending-write/unload protection is synchronized when ownership is registered and released.

Test changes:

| File | Change |
| --- | --- |
| `tests/collaboration-direct-save-settlement.node.test.mjs` | New 21-case deterministic production-function regression suite |
| `tests/authentication-credential-boundary.node.test.mjs` | Retains auth/page/session-fence assertions and adds ownership-before-await assertions; updates source anchors to the patched statements |
| `tests/save-admission-revision-race.node.test.mjs` | Freezes Date per test; prevents existing byte-for-byte draft assertions from depending on two real writes sharing a millisecond |
| `tests/helpers/wan-editing-harness.mjs` | Supplies the shared mutation-tracking map now used by the production function; no network/latency assertions removed |

The initial targeted run exposed the existing timestamp-sensitive assertion. A broad intermediate run also identified the missing global in the WAN VM harness. Both intermediate failures and their final passing reruns are retained in diagnostics. No dependencies, engine requirements, lockfile, database schema, SQL routes, or sanitizers were changed.

## Validation results

| Check | Result |
| --- | --- |
| New regression suite against exact original app | 21 cases: 8 pass, 13 fail (expected reproduction) |
| Same suite against final patched app | 21/21 pass |
| Final targeted settlement/admission/authentication/WAN run | 118/118 pass; no skipped/cancelled cases |
| Final broad native fallback | 288 files: 277 pass, 11 fail; 2,235 passing checks and 11 failed cases; no skipped/cancelled cases |
| All 11 broad failures against untouched baseline | Same missing-module errors reproduced in all 11 |
| Source syntax parsing with TypeScript 5.8.3 | 703 JS/TS source/test/script files; zero parse diagnostics; not type checking |
| Whitespace check restricted to modified existing files | Pass with `core.whitespace=cr-at-eol` |
| Lockfile registry policy check | Pass: 343 resolved URLs use approved registry hosts |
| Workspace Git integrity | All 28 regular-file SHA-256 checks match; recorded metadata for all Git paths unchanged |

The broad fallback command is `node --experimental-strip-types --test --test-reporter=tap <one test file>`. It is deliberately not presented as the repository's official test pipeline. Some files import dependencies or compiled `.js` paths from TypeScript; native stripping cannot replace tsx's resolution behavior.

The 11 affected files are:

- `ai-chat-timestamp-integrity.node.test.mjs`
- `authenticated-response-cache-policy.node.test.mjs`
- `backup-metadata-integrity.node.test.mjs`
- `backup-share-identity-integrity.node.test.mjs`
- `bcrypt-password-boundary.node.test.mjs`
- `custom-icon-resource-boundary.node.test.mjs`
- `page-cover-backup-integrity.node.test.mjs`
- `runtime-security-floor.node.test.mjs`
- `security-assessment-remediation.node.test.mjs`
- `structured-metadata-integrity.node.test.mjs`
- `theme-preference-persistence.node.test.mjs`

### Environment blockers and explicit non-results

The installed runtime is Node **22.16.0**, npm **10.9.2**. The repository requires Node `^22.23.2 || ^24.18.1 || >=26.5.1` with `engine-strict=true`. `npm ci --ignore-scripts --no-audit --no-fund --fetch-retries=0 --fetch-timeout=10000` exits with `EBADENGINE`. That safeguard was not disabled or lowered.

`npm run build` stops during Mermaid vendoring because DNS resolution for `registry.npmjs.org` fails (`EAI_AGAIN`). `npm test` passes the registry check, then cannot execute Vitest (`Permission denied`, exit 127 in this environment); the project dependencies were not installed. `npm run verify:data-loss`, `npm run verify:collaboration`, and `npm run verify:security` stop on missing `tsx`. No successful production build, complete Vitest run, live MariaDB application run, or complete security verification is claimed.

The broad initial orchestration hit the external command time limit before producing its overall summary. Full logs were retained, the runner was updated to persist per-file exit metadata, and all 288 files were subsequently rerun in completed batches against the final patch. Use `native_summary.json` and `native_final_batch1/2/3`, not the incomplete `native_final` directory, for final totals.

An unrestricted Git whitespace check also reports existing whitespace in unchanged CSS/historical QA files. The earlier default whitespace log additionally treats CRLF as trailing whitespace. Neither was fixed by normalizing the upload or changing unrelated files; the final modified-file check passes with CRLF handled explicitly.

## Re-running the deterministic checks

From the patched app root:

```sh
node --test --test-reporter=tap \
  tests/collaboration-direct-save-settlement.node.test.mjs \
  tests/save-admission-revision-race.node.test.mjs \
  tests/authentication-credential-boundary.node.test.mjs \
  tests/wan-editing-latency.node.test.mjs
```

Expected result: 118 passing tests. These checks do not require installing the missing third-party dependencies.

To reproduce the original failures, extract `original-app.js` from this audit's `diagnostics.zip` into an external scratch location and run:

```sh
BRAINVAULT_QA_APP_SOURCE=/absolute/path/to/original-app.js \
node --test --test-reporter=tap \
  tests/collaboration-direct-save-settlement.node.test.mjs
```

Expected result: 8 pass, 13 fail, exit 1. The original fixture is a copy of the uploaded non-Git source, not a reconstruction of raw Git objects. The full patch is `collaboration_settlement_fixes.patch`; it is formatted with LF for review while patched existing source retains CRLF.

For the full application pipeline, use the repository-declared Node range, registry access, installed dependencies, and the project's configured MariaDB environment. The commands attempted here remain unmodified in `package.json`.

## Security review

The patch does not add endpoints, trust client identifiers as authorization, change server access predicates, introduce HTML/string rendering sinks, or bypass sanitization. Authentication/page/session fences remain ahead of completion-driven UI publication. Existing authorization assertions and the WAN checks for HTTP 401/403/404 behavior remain passing.

Client-side completion fences are not substitutes for server-side object authorization. OWASP's IDOR guidance calls for authorization checks on each requested object. Its XSS guidance likewise distinguishes context-appropriate encoding/sanitization from merely validating input. Those boundaries were reviewed and retained; they are not certified by the callback tests alone. See the external references below.

## Immutable Git and packaging

No Git objects were decoded/read directly through Python. Git content/history inspection used Git CLI; integrity hashing used external checksum tools. Non-Git files alone were patched. Tests ran as an unprivileged user while `.git` remained root-owned and non-writable to that user.

There are **44 original `.git` ZIP entries, including 28 regular files**. Workspace checks preserve their contents and recorded mode, owner/group, size, modification time and change time. Access times are not an immutability claim because reads may update them. Archive-level verification separately checks the original ZIP's Git payload hashes and stored metadata against the delivered ZIP.

The output is created by copying the entire input ZIP and updating only four changed source/test entries plus the new test and this audit's QA artifacts. Original `.git` entries are retained from the input archive rather than reconstructed. No original file is deleted. Beyond the four intended changes, all 873 other original non-Git regular files are byte-identical. Original configuration, lockfile, history, prior QA artifacts and assets remain included.

The external `package_integrity.json` records final ZIP validation, preservation comparisons, file count, size and SHA-256. `workspace_integrity.json` records the prepackaging file hashes and changes. No commit was created: doing so would violate the read-only `.git` constraint.

## Diagnostic contents

`diagnostics.zip` contains the complete captured Git/test/build/install outputs, command exit metadata, original source fixture, reproduction and patching scripts, final batch summaries, baseline-failure comparisons, and Git integrity records. The report and full patch are also copied into this directory. Earlier/intermediate failures are kept rather than hidden. Npm cache files are omitted because they are not application artifacts; the captured installation/command errors are included.

## External reference material

These primary sources informed boundary review and Git handling, not the local test counts:

1. Git, `git-status` manual, “BACKGROUND REFRESH”: https://git-scm.com/docs/git-status — optional index refresh can be disabled with `--no-optional-locks`.
2. OWASP, Insecure Direct Object Reference Prevention Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Insecure_Direct_Object_Reference_Prevention_Cheat_Sheet.html
3. OWASP, Cross Site Scripting Prevention Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html
4. MariaDB, `FOR UPDATE`: https://mariadb.com/docs/server/reference/sql-statements/data-manipulation/selecting-data/for-update
