# Custom icon library filesystem-uncertainty integrity

Date: 2026-08-14

## Scope

This audit focused on durable user-state loss across note/page/block mutation, permanent deletion, restore/import, collaboration materialization, backup/restore, attachments, and custom-icon library state. Existing restore-generation, mutation-receipt, navigation, share, block-order, asset-journal, and backup guards were reviewed alongside targeted reproduction tests.

## Confirmed data-integrity defect

`src/lib/custom-icons.ts` treated every `lstat()` failure while listing the custom-icon library as proof that the icon file was gone. The affected flow collected the row ID in `missingIds` and then permanently deleted that row from `custom_icons`.

That assumption is unsafe because errors such as `EIO`, `EACCES`, `EMFILE`, `ENFILE`, or similar transient/uncertain filesystem failures do not prove absence. A temporary storage or descriptor failure could therefore become a durable database mutation and erase the user's custom-icon library binding even when the underlying icon file still existed.

The same uncertainty problem existed in `restoreCustomIconToLibrary()`: it deleted the library-removal tombstone first, then swallowed any `lstat()` error. An uncertain filesystem failure could therefore commit a state transition that reported restoration while failing to recreate the library row.

## Reproduction

The pre-fix behavioral model classifies transient failures such as `EIO`, `EACCES`, and `EMFILE` as missing files and consequently as row-deletion candidates. This is reproduced by `scripts/reproduce-custom-icon-library-fs-error-loss.mjs`.

## Fix

A shared classifier was added in `src/lib/filesystem-presence.ts`. Only `ENOENT` and `ENOTDIR` are treated as definitive path absence. Other filesystem errors are propagated.

`listCustomIcons()` now deletes a stale database row only when absence is definitive (or the resolved entry exists but is not a regular file). Uncertain filesystem failures abort the operation instead of converting uncertainty into a durable `DELETE`.

`restoreCustomIconToLibrary()` now also propagates uncertain filesystem failures. Because the operation runs under the existing database transaction/lock wrapper, propagation rolls back the preceding tombstone deletion rather than committing a partial library restore.

## Reproduction-harness hardening

Two existing restore-loss reproduction scripts assumed that Git `HEAD` was the vulnerable baseline and tried to prove that the current source still lacked the corresponding fixes. That made the reproductions fail once the fixes were already present. They were changed to use explicit embedded pre-fix models for the vulnerable side and the current working source for the fixed side, making the reproductions deterministic and independent of repository `HEAD` state.

## Validation

- New filesystem-presence integrity tests: 2 passed, 0 failed.
- Focused data-integrity regression suite: 44 passed, 0 failed.
- Full dependency-free Node test sweep after changes: 297 total, 292 passed, 5 failed. The same five failures were already present in the baseline environment; two pre-existing restore-reproduction failures disappeared and the two new tests passed.
- Baseline full sweep: 295 total, 288 passed, 7 failed.
- The remaining failures are attributable to the sandbox runtime/dependency-resolution state (Node 22.16.0 versus the project's declared Node `^22.23.2 || ^24.18.1 || >=26.5.1`, plus incomplete unavailable dependencies) and one pre-existing stale textual security assertion. They were not introduced by this change.
- The central data-loss guard runs through the new custom-icon and corrected restore reproductions, then reaches the already-known TypeScript-to-`.js` module-resolution failure in the sandbox runtime.
- Syntax checks passed for every changed TypeScript/JavaScript source file involved in this fix.

## Result

One additional durable-state-loss bug was confirmed and fixed: custom-icon library metadata could be deleted or left inconsistently restored when filesystem presence was uncertain. No additional currently reproducible note/page/block content-loss defect was confirmed in the audited core mutation, restore, collaboration, attachment, or backup paths after the focused regression set passed.
