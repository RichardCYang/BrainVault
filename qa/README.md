# BrainVault: data-integrity audit and remediation

Date: 19 September 2026  
Input: `BrainVault.zip`  
Repository HEAD: `475290d635c0424a07a1d3e84fca4b4ef5249c51`  
Deliverable: `fixed_note_app.zip`

## Outcome

Two related classes of lost-edit defects were reproduced and patched in `public/app.js`: stale detached editor callbacks could replace newer recovery/server content, and saves waiting for recovery durability could bypass a newly raised edit conflict. Additional same-revision replacement and deletion-state cases were covered. Nine tests were added to the existing deterministic race suite. Against the original app, eight of those new tests fail; against the patched app, all 23 tests pass, including the original 14 cases and a positive equivalent-rebuild control.

This is a source-level and simulated-runtime repair with extensive native-runner regression checks, not a fully validated production release. Dependency installation, the official test/build pipeline, full TypeScript checking, and live browser/database validation could not all be completed in this environment. The exact limits and raw failures are recorded below.

The final ZIP contains the original `.git` entries, not the inspection workspace's Git index. All 28 Git files have identical SHA-256 hashes to the initial extraction, and metadata for all 44 Git archive entries matches the uploaded archive.

## Scope and architectural context

The upload contains 951 ZIP entries. The application uses an Express/TypeScript backend with MariaDB transactions, optimistic page/block versions, mutation IDs, browser recovery drafts, a latest-write queue, and a Yjs collaboration path. The initial extracted text matches Git HEAD when end-of-line differences are ignored: the archive's CRLF line endings differ from the Git checkout representation. Those existing line endings were preserved in both edited files.

Git history was inspected through ordinary Git CLI commands invoked by Python subprocesses, including status, log, show, diff, ls-files, and rev-parse. The recent commit `33423a5952e4c7423a518d4d4d05966438cc9fae` explicitly introduced pre-await revision capture and post-durability stale-save rejection. This patch extends that design; it does not replace recovery storage, mutation receipts, the save queue, or database transactions.

Core paths reviewed:

| Responsibility | Files |
|---|---|
| Editor state, recovery and save admission | `public/app.js`, `public/draft-store.js` |
| Save ordering and acknowledgment/rebasing | `public/save-queue.js`, `public/save-rebase.js` |
| Database transactions and uncertain outcomes | `src/lib/db.ts` |
| Page mutation/deletion and destructive snapshots | `src/routes/page.routes.ts`, `src/lib/page-delete-snapshot.ts` |
| Block changes/deletion and version checks | `src/routes/block.routes.ts` |
| Durable collaboration updates and materialization | `src/lib/collaboration-server.ts` |

A potential ordinary collaboration-update/delete race was examined and excluded as a confirmed finding: the existing `assertCollaborationMaterialized()` deletion guard already uses locked/current materialization checks. No backend fix is claimed for that hypothesis.

## Finding 1 — detached block callbacks can destroy a newer edit

**Impact:** loss of the newest browser recovery copy, or reversion of content that a newer request has already saved successfully. This is an integrity defect, not a demonstrated cross-user authorization bypass.

### Reproduction A: overwrite the durable draft before admission

1. Start with a block at server version 1.
2. Edit its content to A; the row has local edit revision 1.
3. Rebuild the editor row, retaining a pending callback's reference to the old row.
4. On the live row, edit the content to B; its revision becomes 2 and B is in the recovery store.
5. Invoke `saveBlockRow()` with the detached A row.
6. In the original code, save admission calculates a fresh revision from the row/store state and writes A over the B recovery draft **before** the post-await check. A later rejection of the network request is too late to protect crash recovery.

**Patched outcome:** the callback is rejected before any draft write; B and its autosave timer remain intact, with no request sent.

### Reproduction B: overwrite a newer completed server save

1. Perform steps 1–4 above.
2. Save B successfully. The server is now at version 2, and B's recovery draft is acknowledged/removed.
3. Invoke the pending callback with detached row A.
4. The original code can manufacture local revision 2 from the old row, matching the live row's revision, then borrow the newly acknowledged server version and send a valid PATCH for A.
5. The server reverts B to A even though its optimistic version check succeeds.

**Patched outcome:** the stale row is rejected before revision generation or persistence. The server remains B; no extra PATCH or replacement draft is created.

### Remediation

Before extracting/persisting a block payload, resolve its current rendered row. For a different row object, require matching revision, recovery-source identity and payload. Reject mismatches immediately. For an equivalent rebuild, use the live row so current conflict/deletion flags and recovery metadata govern the save. A block already marked for deletion is not admitted.

## Finding 2 — a paused save can bypass a newly raised conflict

**Impact:** a stale title or block draft can silently overwrite a newer remote edit after an intervening operation has already detected and surfaced the conflict.

### Deterministic reproduction (run once for title, once for block)

1. Create a local draft against server version 1.
2. Begin a save and pause it while awaiting durable recovery storage.
3. Simulate another writer committing different content at server version 2.
4. Start a second save of the local draft. Its stale expected version produces the existing page/block conflict error, and the real save function marks the draft conflicted.
5. Refresh canonical version metadata to the server's new version without granting overwrite consent or resolving the local conflict.
6. Release the first save's durability barrier.
7. The original revision-only admission guard accepts it because the local revision did not change. The queued task can then use the fresh canonical version and overwrite the remote content.

**Patched outcome:** the delayed save returns without dispatching another request; the remote content, recovery draft and conflict indication remain intact.

### Remediation

After durability resolves, a block save now revalidates local revision, recovery source, payload, conflict state and deletion state together. A title save also requires the current normalized nonblank title and no active conflict, in addition to its existing revision/source checks. Same-revision content/source replacements therefore cannot be treated as consent to save an older snapshot. The live admitted block row is used for subsequent history/acknowledgment behavior.

## Patch inventory

Only two original files were changed:

| File | Changes |
|---|---|
| `public/app.js` | 34 added lines, 1 removed line; admission guards described above |
| `tests/save-admission-revision-race.node.test.mjs` | 149 added lines, 5 removed lines; nine new cases and harness support |

The complete unified diff is `qa/brainvault_fixes.patch`. New QA artifacts are confined to `qa/`. No package, lockfile, engine requirement, migration, route, SQL statement, authorization rule, HTML rendering sink, or escaping behavior was changed.

The test harness now accepts `BRAINVAULT_QA_APP_SOURCE`, allowing the identical tests to exercise the uploaded pre-patch app without checking out or modifying Git state. Its mock HTTP endpoint returns realistic page/block conflict errors instead of an expected-version assertion; the application's real save/conflict handlers process those errors.

## Regression results

| Check | Observed result |
|---|---|
| Extended race suite against original source | 23 tests; 15 pass, 8 fail; exit 1 |
| Same suite against patched source | 23 tests; 23 pass, 0 fail; exit 0 |
| Existing Node-native files, individually run | 287 complete TAP logs; 276 files entirely passing |
| Aggregate native-runner TAP counters | 2,213 reported checks: 2,202 passes, 11 dependency/loader failures; no skips or cancellations |
| JavaScript syntax checks for both edited files | Pass |
| Syntax-only scan of JS/TS under public/src/tests/scripts | 702 files; zero parse diagnostics using TypeScript 5.8.3 |
| Lockfile registry check | Pass: 343 resolved URLs use approved portable registry hosts |

The native fallback command was `node --experimental-strip-types --test --test-reporter=tap tests/<file>.node.test.mjs`. It is **not** the repository's official `tsx`/Vitest pipeline. Counts were reconstructed from complete final per-file TAP summaries: the batch supervisor ended before writing its exit-code summary. No unavailable exit codes have been invented. The two resource stress files initially exceeded a 13-second parallel-run limit; isolated reruns completed with exit 0, and their final logs/results replace the incomplete ones in the final aggregate.

The harness executes the actual extracted save functions, draft store, latest-write queue and rebase code. DOM controls, recovery-durability timing and the HTTP/server endpoint are simulated. Consequently, the race reproductions demonstrate the code paths and preservation invariants but are not live IndexedDB, browser, network or MariaDB integration tests.

Existing passing checks include authentication credential boundaries (21), security remediation (28), security follow-up remediation (9), reverse-proxy boundaries (4), attachment admission (4), and passkey direct-login security (3). Those results are limited to the scopes of the corresponding source/unit tests; they do not establish absence of all IDOR, XSS or other vulnerabilities.

### Dependency/loader failures in the native fallback

These 11 failure entries remain failures in the recorded totals, not hidden skips or passes. Some are whole-file module-load failures and therefore do not enumerate all tests that a correctly installed environment would execute.

| Test file | Missing package or unresolved module |
|---|---|
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

### Environment and official-pipeline limitations

The available runtime was Node `v22.16.0` / npm `10.9.2`. The app declares Node `^22.23.2 || ^24.18.1 || >=26.5.1` and enforces its requirement through `engine-strict=true`.

- `npm ci --ignore-scripts --offline --no-audit --no-fund`: failed with `EBADENGINE`; the security/runtime floor was not weakened.
- Registry connectivity: the container could not resolve `registry.npmjs.org`.
- `npm test`: passed the lockfile check, then stopped because `vitest` was not installed.
- `npm run build`: stopped at the Mermaid vendoring fetch with a registry DNS failure, before compilation.
- `tsc --noEmit -p tsconfig.json`: failed because `node` and `vitest/globals` type definitions were missing. The syntax-only scan is not a substitute for this check.
- `node scripts/verify-data-loss-guards.mjs`: reached an auxiliary reproduction requiring missing `tsx`, then failed.
- No live browser, real IndexedDB or MariaDB integration run was completed. No production-readiness or complete-security certification is claimed.

On an environment satisfying the repository's declared runtime requirements and with dependency/network access, the normal follow-through remains `npm ci`, `npm run build`, `npm test`, `npm run verify:data-loss`, `npm run verify:collaboration`, and the application's configured integration/security checks. No test bypass or dependency shim is shipped.

## Reproducing the targeted before/after evidence

From the extracted patched application directory:

```sh
node --test tests/save-admission-revision-race.node.test.mjs
# Expected: 23 pass, 0 fail.

# Export the pre-patch non-Git source retained only as a QA fixture.
mkdir -p /tmp/brainvault-before
unzip -q qa/diagnostics.zip original-app.js -d /tmp/brainvault-before
BRAINVAULT_QA_APP_SOURCE=/tmp/brainvault-before/original-app.js \
  node --test tests/save-admission-revision-race.node.test.mjs
# Expected: 15 pass, 8 fail. The nonzero exit is intentional reproduction evidence.
```

The fixture was exported from the uploaded ZIP's `public/app.js`; it was not obtained by parsing raw Git objects. `new-regressions-before.tap` and `new-regressions-after.tap` contain the observed outputs. All final native logs are in `node-suite-logs/` inside `qa/diagnostics.zip`. `node-suite-summary.json` explains aggregation and `node-suite-results.json` lists per-file counters. The older truncated aggregate and reconstructed interim results are retained as historical diagnostics, not used as final success evidence.

## Security review boundaries and references

The patch adds no new endpoints, user-controlled identifier parsing, permissions, HTML insertion or template behavior. Existing server-side authorization and output-handling boundaries are left intact. The admission checks fail closed: stale callbacks return without sending a new request, erasing a recovery draft, recording stale history, or canceling the newer block timer. This is consistent with retaining per-object authorization and context-appropriate output handling, rather than treating frontend checks as replacements for security controls.

Official references consulted:

1. Git `git-status`, “BACKGROUND REFRESH”: optional status refresh can write the index; Git documents `--no-optional-locks` for avoiding that refresh. `https://git-scm.com/docs/git-status`
2. OWASP, Insecure Direct Object Reference Prevention Cheat Sheet: authorization must be checked for the accessed object. `https://cheatsheetseries.owasp.org/cheatsheets/Insecure_Direct_Object_Reference_Prevention_Cheat_Sheet.html`
3. OWASP, Cross Site Scripting Prevention Cheat Sheet: context-appropriate encoding/sanitization and safe sinks remain required. `https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html`

These references informed the review; the local test logs, not those references, substantiate the app-specific findings.

## Git preservation and a disclosed process exception

**The strict workspace read-only requirement was not fully met.** A before/after audit detected that the inspection workspace's `.git/index` had changed and the `.git` directory mtime had changed. The other 27 Git file hashes were unchanged. The exact originating subprocess was not conclusively identified. Read-only-oriented Git configuration and `GIT_OPTIONAL_LOCKS=0` were used for inspection/testing, but the observed hash difference takes precedence over that intention. It would be inaccurate to claim the workspace remained perfectly immutable.

**The delivered archive does preserve the original Git folder.** Packaging began by copying the untouched uploaded ZIP, then the ZIP CLI replaced only the two explicitly named non-Git source entries and added QA artifacts. The changed workspace index was never inserted into the deliverable. The uploaded ZIP itself was not edited. No commit, checkout, reset, repository repair, or history rewrite was needed for packaging.

Verification evidence:

- 44 original `.git` archive entries retained, including all 28 regular files.
- Git entry names, CRCs, sizes, compression methods, timestamps, permissions/attributes, extra fields and comments match the original ZIP metadata.
- An external `unzip` extraction of the packaged Git entries followed by external `sha256sum` produced an exact match to the initial 28-file manifest.
- Initial, workspace-after and packaged manifests are provided as `git-before.sha256`, `git-after.sha256`, and `git-packaged.sha256`.
- `git-preservation.json` explicitly records both the workspace index exception and the successful final artifact preservation.
- Raw Git objects were never parsed or read through Python file manipulation. Git history was accessed through Git CLI; integrity hashing used external tools.

The final artifact verification also checks ZIP integrity, exact byte identity of every untouched non-Git input file, and that only the two declared source entries plus QA additions differ. See the separately delivered `brainvault_package_verification.json` for that final check and archive SHA-256.

## QA contents

`qa/README.md` is this report. `qa/brainvault_fixes.patch` is the complete code/test diff. `qa/diagnostics.zip` contains the before/after reproductions, 287 final per-file TAP logs, dependency/build/type-check errors, syntax and registry checks, Git CLI outputs and preservation manifests. Some exploratory runner/patch scripts retain their original workspace paths and are diagnostic records, not required build tooling. The executable application remains in the original top-level layout.
