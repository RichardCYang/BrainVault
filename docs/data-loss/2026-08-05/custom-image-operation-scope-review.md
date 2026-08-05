# Custom image operation scope and stale-intent review

Date: 2026-08-05

## Executive conclusion

Two reproducible browser-side race conditions conflicted with BrainVault's existing latest-intent, page-scoped mutation, and durable-state design:

1. A custom icon file selected for one page could be applied to another page if the file read completed after the icon picker was closed and reopened for a different target.
2. Avatar image preparation could outlive avatar removal, settings closure, or an account boundary. The profile save action also remained available while the selected avatar was still being prepared, so it could persist the previous avatar state instead of the newly selected file.

Both paths now use explicit operation generations and stable target keys. Superseded work may finish internally, but it cannot mutate a replacement target or overwrite replacement UI intent.

## Why this contradicted the project direction

The repository already treats stale asynchronous completion as a data-integrity problem. Page transitions, search, collaboration, block saves, bookmarks, session restoration, and page-cover preparation all use request IDs, transition locks, version checks, or latest-operation guards. The custom icon and avatar paths were exceptions: they awaited browser image/file work and then consulted mutable global state without proving that the originating target and intent were still current.

The correction follows the existing page-cover operation-scope pattern rather than introducing a new optimistic behavior.

## Finding 1: custom icon cross-target write

### Vulnerable sequence

1. Open page one's icon picker and select a custom image file.
2. `FileReader.readAsDataURL()` starts.
3. Before the read completes, close the picker and open page two's icon picker.
4. The original read completes.
5. The previous implementation called `saveEmojiSelection()` only after completion, so that function captured the now-current page-two picker target.
6. Page one's file could therefore be PATCHed as page two's icon.

The same missing latest-intent check allowed an older file read to win after a newer selection and allowed an old save response to close or focus a replacement picker.

### Correction

- Added `public/icon-picker-operation.js`.
- Every file read owns an immutable generation and stable picker-target key.
- Closing/reopening the picker, changing tabs, selecting a replacement file, or beginning another icon save invalidates older intent.
- A stale file read is rejected before PATCH.
- A save that was already submitted still updates the correct returned page model, but stale completion cannot close, focus, or write an error into a replacement picker.
- Reopening a picker no longer clears the global in-flight save flag; replacement controls remain disabled until the submitted save settles.

### Reproducer

```bash
node scripts/reproduce-icon-picker-operation-scope.mjs
```

Expected corrected fields:

```json
{
  "crossPageWriteAccepted": false,
  "supersededReadAccepted": false,
  "latestReadAccepted": true,
  "closedPickerCompletionCanCloseReplacementPicker": false
}
```

## Finding 2: stale avatar preparation and premature profile save

### Vulnerable sequences

Removal/settings sequence:

1. Select an avatar file.
2. Image decoding/canvas preparation starts.
3. Remove the avatar, close settings, or cross an authentication boundary.
4. The old promise completes and writes its result to `state.pendingAvatarData` and the current settings preview.

Premature-save sequence:

1. Select a new avatar file.
2. Before preparation completes, submit the profile form.
3. The previous `pendingAvatarData` value is sent, even though the UI action was initiated for the newly selected file.

### Correction

- Added `public/account-avatar-operation.js` with user-scoped operation generations.
- Opening/closing account settings and removing an avatar invalidate older preparation.
- Completion checks both settings visibility and the authenticated user key before changing pending state or messages.
- Avatar input, removal, and profile save controls are disabled while preparation is current.
- The profile submit handler also rejects programmatic submission while preparation is active.

### Reproducer

```bash
node scripts/reproduce-account-avatar-operation-scope.mjs
```

Expected corrected fields:

```json
{
  "removedAvatarWouldReappear": false,
  "crossAccountAvatarAccepted": false,
  "profileSaveAllowedWhilePreparing": false
}
```

## Regression coverage

Added:

- `tests/icon-picker-operation.node.test.mjs` — 4 tests
- `tests/account-avatar-operation.node.test.mjs` — 3 tests

These tests cover operation-key behavior, invalidation, source wiring, stale UI completion, deterministic reproductions, and prevention of profile submission during avatar preparation.

## Validation results

Commands executed after the correction:

```bash
node --check public/app.js
node --check public/icon-picker-operation.js
node --check public/account-avatar-operation.js
node --experimental-strip-types --test tests/*.node.test.mjs
node scripts/verify-data-loss-guards.mjs
node --experimental-strip-types scripts/verify-collaboration.mjs
node --experimental-strip-types scripts/verify-security-hardening.mjs
git diff --check
```

Results:

- Native Node test suite: **125 passed, 0 failed**.
- Data-loss guards: **OK**.
- Collaboration verifier: **OK**.
- Security-hardening verifier: **PASS**.
- JavaScript syntax checks: **PASS**.
- Diff whitespace check: **PASS**.

## Dependency-backed validation boundary

The project deliberately enforces a patched runtime floor of Node `^22.23.2 || ^24.18.1 || >=26.5.1`. The available audit runtime was Node `22.16.0`, so an ordinary `npm ci` correctly failed its engine gate. A temporary engine override was used only to investigate whether dependency-backed checks could be run; the provided registry did not contain the lockfile's exact `zod@3.25.76`, while direct public-registry access was unavailable in the sandbox. No dependency version, engine requirement, package manifest, or lockfile was weakened or changed.

Therefore the completed evidence is the repository's full dependency-free native suite plus all three source verifiers. Dependency-backed build/Vitest execution remains an environment limitation, not a reported pass.

## Git preservation

The final archive retains the uploaded repository's `.git` directory. Temporary `node_modules` artifacts created during installation attempts are excluded. The archive is checked for unsafe paths and symlinks before delivery.
