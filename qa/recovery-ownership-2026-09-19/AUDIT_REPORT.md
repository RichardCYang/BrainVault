# BrainVault — recovery ownership audit and remediation

**Audit date:** 2026-09-19  
**Input:** `BrainVault.zip`  
**Output:** `fixed_note_app.zip`  
**Repository HEAD:** `10009d80c07b5fd7fa2763b0e6613ed11bc225f6` (unchanged)

## Result

Patched two asynchronous editor-recovery callbacks in `public/app.js`. An earlier local-storage operation could previously act on a replacement editor that happened to reuse the same page/block identifier and recovery sequence. Its success could remove a newer write's pending-protection indicator, while its failure could restore older content, cancel a replacement block's autosave, or rerender a different page and erase its visible unsaved title.

The patch captures the originating editor, authenticated session/workspace scope, navigation generation, edit revision, recovery source, sequence, and value/payload. It revalidates ownership before starting the operation, at success, before recovery refresh, and after refresh. Obsolete callbacks no longer complete or roll back a replacement editor. Current-operation success and failure behavior remains covered by tests.

**Scope of demonstrated loss:** visible in-progress input and recovery/durability bookkeeping in deterministic production-function tests. This audit did not demonstrate deletion of persisted database rows or unauthorized cross-user database access. It does not certify the entire application free of vulnerabilities.

## 1. Preservation and Git context

The original ZIP was checked for traversal paths and symlinks before extraction. All history inspection used Git CLI invoked by Python `subprocess`: `git status`, `git log`, `git show`, `git ls-files`, `git diff`, `git rev-parse`, and `git fsck`. Optional index refreshes were disabled with `GIT_OPTIONAL_LOCKS=0` / `--no-optional-locks`; filesystem-monitor hooks, hooks, and automatic maintenance were disabled for these invocations. No commit, checkout, reset, staging, cleanup, or Git configuration writes were performed. Python did not directly read or parse raw Git objects.

The archive was already a non-clean worktree: many text files have CRLF line endings while Git's stored versions use LF. The initial status listed extensive changes before remediation. Those were not reverted or normalized. The authoritative comparison is against the uploaded ZIP, not an assumption that `HEAD` equals the uploaded source.

Recent architectural intent from actual commits:

| Commit | Intent in the commit subject |
|---|---|
| `10009d8` | Prevent stale collaboration saves from overwriting newer edits. |
| `a83b35d` | Prevent stale note saves from overwriting newer state. |
| `251dae0` | Prevent stale note saves from overwriting newer state. |
| `33423a5` | Prevent stale note saves from overwriting newer edits. |
| `117c70d` | Prevent stale page deletes from overwriting newer navigation state. |

The patch extends those existing ownership/generation fences to visible local-recovery settlement rather than replacing the save architecture.

Integrity checks performed:

- All **28 regular files** in `.git` retain identical SHA-256 hashes from initial extraction to the final packaged extraction.
- All **44 `.git/` ZIP entries**, including directories, retain original timestamps, attributes, CRC, sizes, compression flags/type, extra fields, and local-header offsets.
- `cmp` confirms the first **44,505,085 bytes** of the original and output ZIP are byte-identical. This contiguous prefix contains every `.git` entry, including compressed object packs.
- `git fsck --full` completed with exit code 0; Git diff whitespace check passed.
- All **881 other original non-Git files** remain byte-identical. Only the original `public/app.js` changed; no original file was removed.

Packaging starts with a copy of the original ZIP and updates only explicit source/test/QA members. `.git` is never passed as an update target. The clean deliverable retains the original worktree and history; no new commit was created because that would modify `.git`.

## 2. Core architecture audited

| Area | Files | Relevant behavior |
|---|---|---|
| Browser state and mutation orchestration | `public/app.js` | Selected page, title revisions, rendered block rows, authentication/navigation generations, autosave timers, recovery restoration, delete/reorder flows. |
| Direct-save scheduling | `public/save-queue.js` | Serialized generation-scoped writes, admission checks, retries, pinned commit tokens, discarded-write settlement. |
| Local recovery | `public/draft-store.js`, `public/indexeddb-recovery-storage.js` | Account/page/source-scoped drafts, acknowledgments, asynchronous flush/refresh and transaction durability. |
| Collaborative editing | `public/collaboration.js` and collaboration settlement paths in `public/app.js` | Yjs-backed editing and isolation from direct-save mode. |
| Database transactions | `src/lib/db.ts` | Explicit REPEATABLE READ transactions, rollback, unknown commit-outcome classification, exact-range handling of version counters. |
| Object authorization | `src/lib/page-access.ts` | Owner/admin/editor/reader capabilities and current share/access lookups. |
| Note/block mutation and deletion | `src/routes/page.routes.ts`, `src/routes/block.routes.ts` | Authentication-boundary checks, scoped object access, expected version/snapshot requirements, locking reads, mutation receipts and replay protection. |

In the reviewed block-delete route, the server requires a mutation ID and expected block-version snapshot, checks access, locks the current page/hierarchy, validates the subtree snapshot, and scopes deletion by both block ID and page ID. Permanent page deletion similarly requires an expected snapshot and mutation ID and has ownership/session and replay checks. Those protections were preserved, not relaxed. A real MariaDB concurrency run was not available, so this is source review plus existing runnable regression coverage, not an end-to-end authorization certification.

## 3. Confirmed issues and strict reproduction scenarios

The new suite executes extracted **actual production functions** in a Node VM with an explicitly modeled DOM and independently controlled `flush()` / `refresh()` promises. It includes the production block-restoration function; surrounding DOM rendering, timers, and storage are controlled harness components. These are deterministic reproductions, not claims of a live-browser demonstration.

### A. Stale title/block completion claims or rolls back a replacement edit

1. Open a directly edited, non-collaborative page and begin recovery admission for edit A. Keep its recovery flush pending.
2. Rebuild the editor, or navigate away and back to the same page. The page/block ID can be the same while its numeric admission counter restarts at 1.
3. Type replacement value B, and mark B's own recovery admission pending. Keep B unresolved.
4. Resolve A's old flush successfully. Before the patch, a matching reused sequence can clear B's `recovery-admission-pending` / `aria-busy`; the title callback can also record B as the last durable value even though B has not completed recovery persistence.
5. In the failure variant, reject A's flush instead. Before the patch, stale refresh/restore logic can replace B with an older durable/canonical value or cancel the replacement block autosave.
6. With the patch, A's callback fails the original-session/navigation/editor/revision/source/value ownership check and does not settle or restore B. B retains its pending fence until its own operation settles.

This is not a claim that every pair of rapid keystrokes triggers the success bug: counter/identity reuse is the important boundary. The tests separately cover new edits, rebuilt elements, changed authentication, workspace restore, same-page navigation, collaborative-mode transitions, and changed recovery sources.

### B. Failed recovery on a detached old block resets another page's title

1. On page P1, begin a block recovery flush and leave it pending.
2. Navigate to P2 so the old P1 row is detached and no longer belongs to the selected page.
3. Enter an unsaved title on P2, distinct from P2's canonical title.
4. Reject the outstanding P1 flush.
5. Before the patch, the callback could fall back to the detached old row. The production restoration path then called `renderSelectedPage()` because the original block was unavailable/disconnected; the selected page was now P2, so its visible title was reset.
6. With the patch, page/navigation/row ownership is rejected before refresh or restore; P2's in-progress title remains untouched.

Test: `a detached old block failure cannot rerender and erase another page's in-progress title`.

### C. Ownership changes while recovery refresh is pending

1. Start a recovery admission that is current, then reject its flush.
2. Let failure handling enter `recoveryStorage.refresh()` but pause refresh completion.
3. Replace the editor or change authentication/navigation/persistence mode and begin a new pending admission.
4. Resolve the old refresh.
5. Before the patch, the old callback could resume restoration against the replacement state. The patch revalidates ownership **after** the await and leaves the replacement input, pending marker, and autosave alone.

## 4. Applied source changes

`public/app.js` changes are limited to `scheduleDirectTitleRecoveryAdmission` and `scheduleDirectBlockRecoveryAdmission`, beginning near lines 8003 and 8050 in the delivered file. The source delta is **58 inserted and 14 removed lines**, preserving the existing CRLF convention and all bytes outside the edited region.

Title settlement now uses the captured input and value rather than reading a later editor value. Block settlement requires the exact current rendered row, current block membership, a non-deleting state, and an unchanged payload. Both callbacks use the application's existing authenticated-session and navigation helpers. The detached-row fallback was removed. Both success and failure paths check ownership, including on both sides of the refresh await.

Added `tests/recovery-visibility-ownership.node.test.mjs` with **49 tests**. The existing `test:durability` script already discovers `tests/*.node.test.mjs`, so the new suite is included in the project's normal test workflow without changing package scripts.

No database schema, migration, SQL statement, API payload, access-control rule, sharing rule, sanitizer, dependency, lockfile, or runtime security requirement was changed. The patch introduces no HTML insertion or SQL construction path. Current successful recovery, current storage failure, refresh failure, source-specific durable fallback, and a blank title remain tested.

## 5. Validation results

| Validation performed in this workspace | Actual result |
|---|---|
| Existing targeted tests before patch | **70/70 pass**. |
| New tests against the untouched uploaded `app.js` | **10 pass, 39 fail**: deterministic baseline reproductions. |
| New tests against patched `app.js` | **49/49 pass**. |
| Combined new + existing targeted suite | **119/119 pass**. |
| Native fallback scan of all 289 `*.node.test.mjs` files | **2,284 pass, 11 fail**, 0 skipped/cancelled; all files completed. |
| Untouched-source comparison for the 11 failing files | The same 11 failures and identical missing-module/package causes reproduce in an independent original extraction. |
| TypeScript parser syntax scan | **704 JS/TS files, 0 parse diagnostics**. This is not a semantic typecheck. |
| `node --check` on patched app and new suite | Pass. |
| Lockfile registry consistency | Pass. |
| Patch dry run against original extracted worktree | Pass; preserves the uploaded app's CRLF context. |
| Git integrity and ZIP preservation | Pass as described above. |

These totals overlap: the 119 targeted checks and the new 49 are included in the broad native run; they must not be added to 2,284 as independent checks.

The two slower resource suites completed successfully when rerun individually: `editor-batch-resource` **68/68** and `resource-utilization` **76/76**. Earlier shorter execution windows interrupted them; those interruptions are not counted as final test failures.

### Environment blockers and limits

The workspace has Node **22.16.0**, below the project's unchanged engine requirement `^22.23.2 || ^24.18.1 || >=26.5.1`; npm is **10.9.2**. `npm ci` fails with `EBADENGINE`. Network-backed package/vendor retrieval also encountered `EAI_AGAIN`. No security floor was downgraded and no dependencies were fabricated or replaced.

`npm run build` failed while fetching the Mermaid vendor bundle, before compilation. `npm test` passed the lockfile check but could not launch missing Vitest. `verify:security`, `verify:data-loss`, and `verify:collaboration` could not complete because `tsx` was unavailable. Native fallback uses `node --experimental-strip-types --test`; it is not equivalent to the project's supported `tsx`/Vitest execution and cannot resolve some `.js` imports to `.ts` sources.

The 11 native failing files concern AI-chat timestamps, authenticated response caching, backup metadata, backup share identity, bcrypt boundaries, custom icons, page-cover backup, runtime security floor, security assessment, structured metadata, and theme persistence. Their full errors and original-source comparisons are included. Missing `tsx`, `zod`, and TypeScript import resolution are the observed causes; these are not presented as passing checks.

No live MariaDB/browser end-to-end run, physical storage fault injection, complete semantic typecheck, successful production build, or live IDOR/XSS penetration test was performed. Consequently the patched package is a tested source remediation, **not a fully validated release build**. Run the unchanged official CI workflow with the supported runtime, installed dependencies, network/vendor prerequisites, and database service before deployment.

## 6. Reproduce and rerun

From the extracted delivered application root:

```sh
# Dependency-free focused regression suite, against patched production code:
node --test tests/recovery-visibility-ownership.node.test.mjs

# Combined focused regression checks:
node --test tests/recovery-visibility-ownership.node.test.mjs \
  tests/save-admission-revision-race.node.test.mjs \
  tests/collaboration-direct-save-settlement.node.test.mjs \
  tests/direct-recovery-boundary.node.test.mjs \
  tests/direct-recovery-durability.node.test.mjs \
  tests/block-save-admission-fence.node.test.mjs \
  tests/page-title-save-admission-fence.node.test.mjs

# Unpack the complete diagnostic record, including the untouched app fixture:
unzip -q qa/recovery-ownership-2026-09-19/diagnostics.zip \
  -d qa/recovery-ownership-2026-09-19/diagnostics

# Baseline reproduction: deliberately expected to fail 39 of the 49 tests.
BRAINVAULT_QA_APP_SOURCE="$PWD/qa/recovery-ownership-2026-09-19/diagnostics/original-app.js" \
  node --test tests/recovery-visibility-ownership.node.test.mjs
```

On a supported Node version with dependencies and the normal test services available, run the existing `npm ci`, `npm run check`, and `npm run verify:security`. Those are deployment validation instructions, not successful results claimed for this workspace. The Node suite can also select a specific scenario via `--test-name-pattern` before its file argument.

## 7. Included evidence

`qa/recovery-ownership-2026-09-19/` contains this report, the complete applicable source/test patch, integrity metadata, and a ZIP of full diagnostics. The diagnostic bundle includes all native TAP logs, prepatch and postpatch test output, official command failures, baseline comparisons, Git CLI transcripts, Git SHA-256 manifests, syntax results, patch-application dry run, and the untouched non-Git application source fixture. No raw Git object contents are copied into the diagnostic bundle.

The full patched production source is `public/app.js`; no excerpt or placeholder replaces it. The final application ZIP retains all original members, including prior QA records.

## 8. External primary references used

- Git, **git-status / Background Refresh**: optional status refresh can write the index; no-optional-locks disables that write. https://git-scm.com/docs/git-status
- W3C, **Indexed Database API 3.0**: transaction lifecycle and durability semantics informed the distinction between asynchronous recovery settlement and current visible editor state. https://w3c.github.io/IndexedDB/
- OWASP, **Insecure Direct Object Reference Prevention Cheat Sheet**: object authorization must remain server-side; browser ownership guards do not substitute for it. https://cheatsheetseries.owasp.org/cheatsheets/Insecure_Direct_Object_Reference_Prevention_Cheat_Sheet.html
- OWASP, **Cross Site Scripting Prevention Cheat Sheet**: preserve context-appropriate encoding/sanitization and avoid introducing unsafe output sinks. https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html

External references support the review principles. Application-specific findings and all test counts come from the attached code and this run's included evidence, not from those external sites.
