# Page-cover interaction, PDF, and restore-ambiguity review

Date: 2026-08-05

## Scope and intended behavior

This follow-up review traced the page-cover feature through dialog cancellation, asynchronous custom-image preparation, focal-point editing, page navigation, full-bleed screen layout, PDF export measurement, and complete ZIP restore.

The intended behavior was derived from the repository documentation and the latest full-bleed cover commit:

- cover changes and position drafts remain scoped to the page where the user started them;
- dismissing a picker cancels unfinished picker intent;
- full-bleed screen styling must not change PDF export geometry;
- backup restore must reject contradictory declarations instead of silently choosing one representation;
- the repository's existing `.git` history and tracked file bytes remain intact apart from deliberate fixes.

## Reproduced defects and corrections

### 1. Escape could close the cover picker without canceling asynchronous work

The picker close button and backdrop used `closePageCoverDialog()`, which invalidates the active custom-cover operation. Native dialog cancellation through Escape did not use that path. A custom image could therefore finish decoding and optimization after the dialog had disappeared and still be persisted.

The dialog now handles `cancel`, prevents the browser's implicit close, and routes dismissal through the same invalidating close helper.

Reproduce with:

```bash
npm run reproduce:page-cover-operation-scope
```

### 2. A focal-position draft could cross a page boundary

The position editor stored a page ID, but preview mutation and Save only checked that a draft existed. Navigating from page A to page B while the editor was open could leave A's draft active, mutate it while B was rendered, and submit its coordinates to B.

A shared page-scope predicate now protects preview mutation, rendering, control synchronization, and Save. Stale drafts are closed whenever the selected page changes or the page is no longer editable.

### 3. Full-bleed screen layout leaked into PDF measurement

The latest screen layout intentionally widens `.page-view` to the full main pane while constraining normal content to 960px. PDF export measured the page before adding `pdf-export-mode`, so the new screen width entered the PDF scale calculation even though the commit explicitly intended PDF styling to remain unchanged.

A deterministic wide-screen reproduction uses a 1,400px main pane and the existing A4-landscape printable width of approximately 1,046.93 CSS pixels:

- vulnerable measurement: 1,400px page width, scale 0.7478;
- corrected measurement: legacy 960px page width, scale 1.0000.

PDF mode is now applied before the animation-frame boundary and before layout measurement, excluding the screen-only full-bleed rule from PDF geometry.

Reproduce with:

```bash
npm run reproduce:page-cover-pdf-layout
```

### 4. Contradictory v2 cover declarations were restored ambiguously

A malformed v2 backup could declare a built-in or remote `cover_url` inline and also include an authenticated `page-covers/<pageId>` ZIP entry. Relation validation rejected this only when the inline value was a custom data URL. Restore then silently preferred the ZIP entry, discarding the inline declaration.

Every page-cover ZIP entry now requires the corresponding manifest `cover_url` to be `null`. Any inline value plus an external entry is rejected before workspace replacement begins.

The existing page-cover backup reproduction now also proves the vulnerable silent override and the corrected fail-closed behavior:

```bash
npm run reproduce:page-cover-backup-manifest
```

## Archive integrity handling

The uploaded ZIP contained the full `.git` directory. Comparison against the Git object database found that 323 tracked text files had been mechanically expanded from LF to CRLF while their repository blobs remained unchanged; binary assets matched. Before applying the fixes, tracked files were restored byte-for-byte from `HEAD` so the output does not turn an archive line-ending artifact into a repository-wide source change.

The final packaging procedure restores `.git` from the untouched extracted snapshot and verifies every `.git` file hash before creating the corrected ZIP.

## Verification evidence

```text
Dependency-free native tests: 118 passed, 0 failed
Page-cover operation reproducer: vulnerable and fixed states verified
Page-cover PDF layout reproducer: vulnerable and fixed states verified
Page-cover backup reproducer: manifest-limit and ambiguous-restore states verified
Data-loss verifier: PASS
Collaboration verifier: PASS
Security-hardening verifier: PASS
Modified JavaScript syntax checks: PASS
```

The dependency-backed Vitest/build and MariaDB integration paths were not executed in this review environment. The project enforces Node.js `^22.23.2 || ^24.18.1 || >=26.5.1` with `engine-strict=true`, while the available runtime is Node.js 22.16.0, and the package registry was unavailable. The declared 22.23.2 floor is retained rather than bypassed.
