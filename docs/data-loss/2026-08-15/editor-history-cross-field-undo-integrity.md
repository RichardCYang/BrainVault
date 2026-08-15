# Cross-field editor history data-integrity review

Date: 2026-08-15

## Scope

This audit reviewed BrainVault for durable user-data loss or deletion that can occur outside the user's intended mutation. The review covered direct page/block deletion, foreign-key cascades, local draft/save queues, page-version reset, collaboration/Yjs materialization and recovery, backup/restore and filesystem replacement, attachment/custom-icon cleanup, structured-block metadata, and the newest TreeView, Accordion, and editor undo/redo paths.

The review treated uncertainty as a loss boundary: ambiguous network outcomes, stale versions, restore races, filesystem errors, collaboration races, and undo grouping were checked for any path that could convert a recoverable or unrelated state into a durable overwrite/delete.

## Confirmed data-integrity defect

One additional reproducible loss defect was confirmed in the editor history added on 2026-08-15.

Editor history was keyed only by `block:<id>` and coalesced every change to that key that occurred within the 600 ms capture window. Structured blocks contain multiple independent editors inside one block. As a result, a change in one field and a later change in another field could become one undo entry.

Example:

1. A TreeView node memo changes from `old` to `important new`.
2. Within 600 ms, the user changes a different field, such as the node title from `A` to `Renamed`.
3. The history stack contains one entry whose `before` state is the state before both edits.
4. Undo intended for the title edit restores the memo to `old` as well.
5. If the user then makes a new edit, redo is cleared. Because the normal local-draft record represents the latest block snapshot rather than a permanent history of every intermediate keystroke, the unrelated memo change can then become unrecoverable if it had not reached server/version history.

This is an intent-boundary loss: the user asked to undo the second edit, but an earlier edit in another logical field could be overwritten with it.

## Deterministic reproduction

`scripts/reproduce-editor-history-cross-field-loss.mjs` exercises both call shapes against the real `createEditorHistory()` implementation.

Historical call shape:

- undo depth after the two rapid cross-field edits: `1`
- note restored by undo: `old`
- redo depth after a subsequent edit: `0`

Fixed call shape:

- undo depth after the same edits: `2`
- note preserved by undo: `important new`
- title restored by undo: `A`
- redo depth after a subsequent edit: `0`

The reproduction is deterministic and does not require a database, network, timing scheduler, or browser automation.

## Root cause

`public/editor-history.js` previously decided coalescing from only the block history key, capture epoch, and elapsed time. It had no concept of the logical input field that produced the change. `public/app.js` therefore sent every structured editor mutation in the same block to the same capture bucket.

## Fix

`public/editor-history.js` now stores a `captureGroup` on each history entry and coalesces only when the previous and next entries have the same history key **and** the same capture group. The capture group is included in retained-byte accounting.

`public/app.js` now identifies the active text input/textarea within the block and derives a stable per-render field group. Rapid typing in the same text field still coalesces as before. Edits from another field, checkbox/select interactions, and structural actions do not coalesce into the preceding text-field edit.

This preserves the useful typing behavior without allowing unrelated structured-block fields to share a destructive undo boundary.

## Regression coverage

The fix adds or extends:

- `tests/editor-history.node.test.mjs` — proves distinct fields in one block produce distinct undo entries.
- `tests/editor-history-integration.node.test.mjs` — proves app wiring derives field capture groups and disables coalescing when no text-field group exists.
- `scripts/reproduce-editor-history-cross-field-loss.mjs` — deterministic vulnerable-vs-fixed reproduction.
- `scripts/verify-data-loss-guards.mjs` — central data-loss guard now asserts the new protection and runs the reproducer.

## Broader audit findings

No second currently reproducible user-note/page/block content-loss defect was confirmed in the audited deletion, collaboration, backup/restore, attachment, custom-icon, page-version, draft/retry, TreeView, or Accordion paths. Existing protections observed during the audit include exact mutation receipts for ambiguous destructive retries, stale-version/draft-conflict fencing, collaboration recovery persistence before live application, restore generation/journal fencing, checksum validation for backup assets, and explicit parent handling around block deletion.

MariaDB DDL implicit-commit behavior was considered when reviewing migration safety, because DDL cannot be assumed to roll back merely because a migration runner opened a transaction. Foreign-key `ON DELETE` behavior was also treated as part of the destructive scope rather than as an isolated row delete. No new reproducible loss was found from those reviewed paths.

For collaboration, Yjs update merging properties were treated as synchronization semantics, not as a substitute for durable recovery. The client already persists its collaboration recovery mutation before applying the local mutation to the live document; no new reproducible loss was confirmed in that boundary.

A separate hypothesis involving native browser undo surviving a remote collaboration refresh was tested in the available Chromium. Programmatic replacement of the edited value did not allow the old native undo state to overwrite the remote value, so that hypothesis was rejected and was not reported as a defect.

## Validation

- Focused editor-history unit/integration suite after the fix: **10 passed, 0 failed**.
- Deterministic cross-field loss reproduction: **vulnerable state reproduced; fixed state proved**.
- Focused data-integrity regression set covering backup/restore, sharing identity, block create/delete retries, collaboration, page-version reset, recovery, TreeView, Accordion, and navigation races: **121 passed, 0 failed**.
- Full dependency-free Node sweep after the fix: **326 total, 321 passed, 5 failed**.
- The same five failures were present in the baseline environment before this fix. Four are caused by the sandbox's Node 22.16 TypeScript-to-`.js` module-resolution mismatch; one is a pre-existing stale textual assertion in `security-followup-remediation.node.test.mjs` that expects an older collaboration variable name.
- `scripts/verify-data-loss-guards.mjs` passes the newly added editor-history assertion/reproduction and later stops at the same pre-existing `src/utils/schemas.js` module-resolution failure.
- Syntax checks passed for every changed JavaScript file.

## Environment limitation

The project declares Node `^22.23.2 || ^24.18.1 || >=26.5.1`, while the provided sandbox has Node `22.16.0`. The repository also enables strict engine enforcement. Dependency installation was additionally blocked by sandbox npm DNS/network failure. For that reason a clean `npm ci`/full TypeScript build could not be completed here; dependency-free regression coverage and direct syntax/reproduction checks were used instead. No project engine setting was changed to work around the environment.

## Result

One reproducible cross-field undo data-loss bug was confirmed and fixed. The corrected editor history now preserves unrelated edits in separate logical fields, while retaining same-field typing coalescing. No additional currently reproducible user-content loss defect was confirmed in the broader audited persistence/destructive paths.
