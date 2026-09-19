# BrainVault follow-up data-integrity audit

**Date:** 19 September 2026  
**Input:** `BrainVault.zip`  
**Repository HEAD:** `251dae0acfc59af202a206d38cf57b557e7eef5f`  
**Deliverable:** `fixed_note_app.zip`

## Outcome

The uploaded code already includes the earlier stale-save admission repair and its historical `qa/` report. This audit preserves that work and adds live-editor ownership checks to the earlier dirty/scheduling entry points and to direct-save membership checks.

Twelve deterministic regression cases were added. With the uploaded, unmodified `public/app.js`, **25 of 35 tests pass and 10 fail**. With the patched app, **all 35 pass**. The 23 pre-existing cases continue to pass; the two additional positive controls verify ordinary and collaborative dirty/schedule flows. These are source-function and simulated-runtime tests, not live browser or MariaDB integration tests.

Exactly two original files changed: `public/app.js` and `tests/save-admission-revision-race.node.test.mjs`. No dependency, lockfile, runtime requirement, migration, SQL statement, route authorization, HTML renderer, or sanitizer was changed. All 871 other original non-Git files match the uploaded archive byte-for-byte. Historical QA artifacts remain untouched; this audit's additions are under `qa/followup-2026-09-19/`.

## Architectural context from Git and source

Git CLI inspection used Python `subprocess`, including `git log`, `git show`, `git status`, `git ls-files`, and `git diff`. Raw Git objects were never parsed or directly opened in Python. The latest commits explain the intended design: reject stale work, preserve durable recovery drafts, maintain optimistic version checks, and retain idempotent mutation receipts across retries and destructive operations.

Relevant history includes:

| Commit | Architectural intent |
| --- | --- |
| `251dae0` | Reject stale detached callbacks and revalidate save admission after recovery durability. |
| `33423a5` | Prevent older saves from borrowing newer edit revisions or acknowledged versions. |
| `117c70d` | Protect owner navigation state against stale page-delete snapshots. |
| `3b3108f` | Fence collaboration-room reuse after state replacement. |
| `5a0d3fe` | Protect newer custom-icon publications against stale page-delete snapshots. |

The main browser state/persistence paths are `public/app.js`, `public/save-queue.js`, `public/save-rebase.js`, and `public/draft-store.js`. Database transactions live in `src/lib/db.ts`; page/block access checks in `src/lib/page-access.ts`; mutation/delete flows in `src/routes/page.routes.ts` and `src/routes/block.routes.ts`.

The inspected backend block PATCH path performs session-boundary checks, resolves object access, locks page/access/block state, handles matching mutation replay, and checks the block's expected version before updating. Its DELETE path requires a mutation identifier and version snapshot. The database wrapper uses explicit transactions and records unknown commit outcomes separately. The repair stays within these existing boundaries; it does not replace server safeguards with browser checks.

## Confirmed boundary defects and reproduction scenarios

The following sequences are deterministic harness reproductions. They drive the application's actual extracted functions, real recovery store, real latest-write queue, and rebase helpers, while controlling browser state, network responses, and durability timing. Browser event timing and real database behavior were not exercised.

### 1. Detached dirty/scheduling callbacks overwrite recovery data and displace newer autosaves

**Affected functions:** `markBlockDirty()` and `scheduleBlockSave()`.

1. Edit block X to A. Persist its local draft at revision 1 and retain that editor row's callback.
2. Rebuild the editor row for the same block, as the app does for editor rerenders.
3. Edit the live replacement to B. Its recovery draft is now revision 2 and its autosave timer is scheduled.
4. Invoke the retained dirty or scheduling callback with the detached A row.
5. Before this patch, `markBlockDirty()` increments the detached row to revision 2 and writes A into the same recovery slot. `scheduleBlockSave()` also clears B's timer and stores the obsolete row as its replacement.

**Observed pre-patch:** the recovery payload becomes A, the live B timer is displaced, and obsolete input can enter undo history. The later direct-save guard is too late to prevent these earlier side effects. Losing B after a subsequent reload is a consequence of replacing B's recovery copy, not a separately executed browser-reload test.

A related reproduction invokes the detached callback after B has already been saved: it recreates an obsolete recovery draft. The collaborative variant submits the stale payload to the active session's `upsertBlock()` in the harness. A deleting row and a row absent from the selected page's block model also need rejection before dirty admission.

**Fix:** a dirty callback must be the current rendered row for a block still in the selected page, and the row must not be marked for deletion. Scheduling rejects detached/deleting callbacks before its failure branch can clear a timer keyed only by block ID. Unlike `saveBlockRow()`'s equivalent-rebuild path, dirty callbacks represent new input and cannot safely be transferred from an obsolete editor.

### 2. A previous page's direct callback acquires the new page's recovery scope

**Affected function:** `saveBlockRow()` before recovery persistence.

1. Give a block on page A a draft and retain its row, including its expected-version metadata.
2. Replace the selected page and rendered row with page B's state in the harness, advancing navigation generation.
3. Invoke `saveBlockRow()` with the retained page-A row after that transition.
4. Previously, the function captured page B as the new save's scope. Since no current rendered row matched A's block ID, the conditional detached-row comparison was skipped.
5. The function could write a page-B recovery entry for page A's block and send `PATCH /api/blocks/<A-block-id>` using the retained version.

**Observed pre-patch:** the mock endpoint receives and commits the old block's payload despite page B being selected. This is a frontend ownership/scope failure; it is not proof of an authorization bypass between different users. Whether a particular browser workflow exposes that callback ordering depends on its outer transition guards.

**Fix:** direct admission now requires both a current rendered row for the block ID and membership in the selected page's block model. Equivalent rebuilt rows remain supported by the existing revision/source/payload comparison.

### 3. The post-durability fallback accepts a removed editor or block

**Affected function:** `saveBlockRow()` after awaiting durable recovery storage.

1. Edit a live block and start saving it.
2. Hold the recovery-durability promise before the task enters its save queue.
3. Remove its rendered row, or remove the block from the selected model while leaving the row in place, without changing the harness's page/navigation identity.
4. Resolve the durability promise.
5. Previously, the absent-row case fell back to the initiating detached row; the absent-model case was not checked. Both could still send a PATCH and acknowledge the recovery draft.

**Fix:** revalidate current row and model membership after the await. An absent editor or block returns without queue admission or recovery acknowledgment. Existing conflict, deletion, revision, source, payload, authentication, and navigation checks remain in place.

## Patch inventory

| File | Added lines | Removed lines | Purpose |
| --- | ---: | ---: | --- |
| `public/app.js` | 23 | 2 | Dirty/scheduler live-row guards and pre/post-await direct-save membership guards. |
| `tests/save-admission-revision-race.node.test.mjs` | 186 | 1 | Twelve cases, production dirty/scheduling function extraction, navigation/removal controls, and collaboration harness support. |

The complete patch is `followup-fixes.patch` in this directory. The uploaded CRLF line-ending convention is retained in both edited files. Git whitespace validation passes. Some unrefreshed Git stat output labels unchanged binary entries as changed; the authoritative archive-to-workspace SHA-256 comparison found only the two changes listed above. Those untouched binary entries are not rewritten in the delivered ZIP.

## Validation results

| Check | Actual result |
| --- | --- |
| Existing targeted suite before this work | 23 passed, 0 failed. |
| Expanded suite against original uploaded app | 35 tests: 25 passed, 10 failed; exit 1. |
| Expanded suite against patched app | 35 tests: 35 passed, 0 failed; exit 0. |
| Native fallback suite | 287 files completed: 276 passed; 11 had dependency/module-loader failures. |
| Native fallback TAP totals | 2,225 reported checks: 2,214 passed, 11 failed; zero skips/cancellations. |
| All 11 failing files rerun against original sources | All 11 also fail without this patch. |
| `node --check` on both changed files | Passed. |
| Syntax-only JS/TS scan | 702 files, TypeScript 5.8.3, zero parse diagnostics. |
| `git diff --check` | Passed. |
| Lockfile registry check | Passed: 343 approved portable registry URLs. |

The broad command was `node --experimental-strip-types --test --test-reporter=tap tests/<file>.node.test.mjs`, run independently for each file. This is a fallback, **not** the repository's official `tsx`/Vitest pipeline. Totals come from complete TAP summaries and recorded subprocess exit codes. Passing native checks include source-contract and simulated-runtime tests; their quantity is not a substitute for live integration coverage.

The 11 nonzero files are:

| File | Missing dependency / unresolved import in fallback |
| --- | --- |
| `ai-chat-timestamp-integrity.node.test.mjs` | `src/lib/summary-prefix.js` |
| `authenticated-response-cache-policy.node.test.mjs` | `tsx` |
| `backup-metadata-integrity.node.test.mjs` | `src/config/ai-chat-limits.js` |
| `backup-share-identity-integrity.node.test.mjs` | `tsx` |
| `bcrypt-password-boundary.node.test.mjs` | `tsx` |
| `custom-icon-resource-boundary.node.test.mjs` | `src/lib/attachments.js` |
| `page-cover-backup-integrity.node.test.mjs` | `tsx` |
| `runtime-security-floor.node.test.mjs` | `tsx` |
| `security-assessment-remediation.node.test.mjs` | `src/lib/http.js` |
| `structured-metadata-integrity.node.test.mjs` | `zod` |
| `theme-preference-persistence.node.test.mjs` | `src/lib/markdown.js` |

### Official pipeline and environment limitations

The available runtime is Node `v22.16.0`, npm `10.9.2`. The repository requires Node `^22.23.2 || ^24.18.1 || >=26.5.1` and has `engine-strict=true`.

`npm ci --ignore-scripts --no-audit --no-fund` was attempted with bounded network settings and failed with `EBADENGINE`. Registry and official Node download-host probes failed DNS resolution. No engine floor or package version was weakened to bypass that failure.

`npm test` passed the lockfile check and stopped because the local Vitest executable is unavailable. An initial unprivileged shell reported `Permission denied` while searching unrelated PATH entries; rerunning with an accessible PATH produced the accurate `vitest: not found` diagnostic. Both logs are retained.

`npm run build` failed fetching the integrity-pinned Mermaid package because the registry could not be resolved, before TypeScript compilation. `tsc --noEmit -p tsconfig.json` failed for missing `node` and `vitest/globals` type definitions. The syntax-only scan does not establish semantic type correctness.

`verify:data-loss`, `verify:collaboration`, and `verify:security` were attempted and stopped on missing `tsx`. No live browser, IndexedDB, MariaDB, multi-user IDOR integration, or deployed XSS run was completed. The artifact is a tested source-level repair with these explicit limits, not a production-readiness or complete-security certification.

## Run the targeted before/after reproduction

From the extracted final app directory:

```sh
node --test tests/save-admission-revision-race.node.test.mjs
# 35 pass, 0 fail.

unzip -p qa/followup-2026-09-19/diagnostics.zip original-app.js   > /tmp/brainvault-before-followup.js
BRAINVAULT_QA_APP_SOURCE=/tmp/brainvault-before-followup.js   node --test tests/save-admission-revision-race.node.test.mjs
# 25 pass, 10 fail; exit 1 is intentional reproduction evidence.
```

The fixture is the app source from this upload at `251dae0`, not the earlier historical fixture inside `qa/diagnostics.zip`. No Git checkout, reset, index write, or object parsing is needed to reproduce the comparison.

With the declared runtime and dependencies available, the outstanding full checks are `npm ci`, `npm run build`, `npm test`, `npm run verify:data-loss`, `npm run verify:collaboration`, and `npm run verify:security`, followed by the configured live integration checks.

## Git preservation: actual evidence and disclosed exception

**There was a process exception in the initial disposable inspection copy.** Its `.git/index` hash changed during the initial read-oriented Git inspection despite `GIT_OPTIONAL_LOCKS=0` and `--no-optional-locks`. The exact triggering subprocess was not isolated. The other 27 Git file hashes did not change. It would be incorrect to claim that the first inspection copy met the read-only requirement throughout.

That copy was excluded from delivery. A fresh workspace was extracted from the original upload. All subsequent Git and test processes for the deliverable ran under an unprivileged UID without write permission on the root-owned `.git`; optional refresh, hooks and maintenance were also disabled. Patches were confined to non-Git source files.

For the protected deliverable workspace, **all 28 Git file hashes and all recorded file/directory permissions, ownership, sizes, modification times and change times remain unchanged**. Read-access timestamps are deliberately excluded from that filesystem comparison. The original archive has 44 `.git/` entries, including directories.

Final packaging starts with a copy of the original ZIP and updates only the two patched files plus new QA files. Therefore `.git` is retained from the original archive, not regenerated from either inspection workspace. Packaging verification compares all 28 original/final Git file streams with standard `unzip`/`cmp` utilities and checks every Git ZIP entry's stored metadata. Final archive results are supplied in the separately published package-integrity JSON. No raw Git object is read directly with Python during these checks.

## Security review and official references

The patch introduces no new endpoint, SQL, permission, user-controlled identifier syntax, or HTML insertion. Existing object authorization and output handling remain unchanged. The added checks fail closed at browser mutation admission, but do not purport to replace server-side object authorization or HTML output defenses.

The web references below informed the review. Local code and test logs, rather than these general references, substantiate the application-specific findings.

1. Git, `git-status`, “BACKGROUND REFRESH”: status can write cached index information; `--no-optional-locks` is documented for suppressing optional status refresh. https://git-scm.com/docs/git-status
2. OWASP, Insecure Direct Object Reference Prevention Cheat Sheet: enforce authorization for each object and test users with different access scopes. https://cheatsheetseries.owasp.org/cheatsheets/Insecure_Direct_Object_Reference_Prevention_Cheat_Sheet.html
3. OWASP, Cross Site Scripting Prevention Cheat Sheet: preserve context-appropriate encoding, sanitization and safe sinks. https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html
4. MariaDB, `FOR UPDATE`: row locking is used within transactional scope. https://mariadb.com/docs/server/reference/sql-statements/data-manipulation/selecting-data/for-update

## Evidence inventory

`diagnostics.zip` includes the original app fixture, complete targeted before/after TAP logs, all 287 native-suite logs and their JSON counters/exit codes, all 11 original-source loader-failure reruns, official build/test/check failures, syntax-scan results, source-integrity hashes, original and protected-workspace Git hashes/metadata, and Git history/inspection outputs. Historical diagnostics already present in the upload are retained separately and have not been substituted for this run's results.
