# Page-cover integrity and regression review

Date: 2026-08-04

## Scope and intended behavior

This review followed the page-cover feature from browser selection and focal-point editing through API persistence, public mapping, version history, complete workspace backup/restore, static verification, and native durability tests. The intended behavior is taken from the root README and feature documentation: built-in and custom covers must remain page-scoped, survive complete ZIP backup/restore, preserve their focal position, and avoid weakening existing durability and security checks.

## Reproduced defects

### 1. Valid custom covers could make complete backup impossible

The previous backup format embedded custom cover data URLs directly in `brainvault-backup.json`. Six valid covers at the 2 MiB per-cover limit produced a 16,779,369-byte JSON manifest, exceeding the default 16 MiB manifest ceiling before attachments or normal note content were considered.

Reproduce with:

```bash
npm run reproduce:page-cover-backup-manifest
```

The corrected v2 manifest in the same reproduction is 3,084 bytes because cover bytes are stored as authenticated ZIP entries under `page-covers/`. Version 1 backups remain importable.

### 2. Asynchronous custom-cover preparation was not page-scoped

Image decoding and canvas optimization complete asynchronously. The old change handler looked up `state.selectedPage` only after that work, so navigating to another page during conversion could apply the original file to the newly selected page. A newer built-in-cover choice could also be overwritten by an older conversion that finished later.

A latest-operation guard now captures the originating page before preparation, invalidates superseded intent, and rechecks the page both before PATCH and before applying the response to browser state.

### 3. Failed focal-position saves left an uncommitted preview visible

The position editor closed before PATCH. When the request failed, the dragged preview stayed visible even though the persisted page still contained the old coordinates. The persistence path now re-renders the authoritative selected page on failure.

### 4. `pointercancel` could introduce a final coordinate jump

The old handler treated `pointercancel` like `pointerup` and sampled its final coordinates. Cancellation events are no longer used to update the focal point; only the last valid pointer movement is retained.

### 5. The closed cover picker eagerly fetched full-size artwork

Five PNGs totaling 10,860,071 bytes (10.357 MiB) had unconditional `src` attributes in the initially closed dialog. The picker now defers image assignment until it opens and uses five WebP previews totaling 71,040 bytes (69.375 KiB). The original PNGs remain the actual selected cover assets.

### 6. A new runtime dependency broke the native durability suite

`src/lib/mappers.ts` gained a runtime import from the Zod-bearing page-cover module. The project's native `--experimental-strip-types` durability runner imports `mappers.ts` directly and could no longer resolve that source `.js` specifier, causing the theme-persistence test to fail before assertions ran. Public cover URL mapping is now kept dependency-free in the mapper, restoring the existing test contract.

### 7. Static verification scripts had drifted behind the feature

The security verifier still required the retired HTTP-only cover schema. The data-loss and collaboration verifiers also matched exact source fragments that changed when page-cover backup files were added. The guards now validate the actual cover signature, size, credential-free URL, external ZIP-entry, archive-length, and restore-order invariants instead of obsolete implementation text.

## Backup v2 integrity rules

- Custom PNG, JPEG, and WebP bytes are staged under the same consistent page lock used by complete backup.
- The manifest stores page ID, ZIP path, MIME type, byte size, CRC32, and SHA-256 for each custom cover.
- Export size accounting and exact ZIP `Content-Length` include cover entries.
- Import rejects undeclared, missing, duplicate, oversized, CRC-mismatched, SHA-mismatched, MIME-mismatched, or signature-invalid cover entries before replacing workspace rows.
- Version 2 forbids inline custom cover data in JSON; version 1 inline-cover backups remain accepted for backward import compatibility.
- Cover bytes are reconstructed one page at a time inside the restore transaction, while attachment-generation recovery semantics remain unchanged.

## Verification evidence

```text
Native durability tests: 114 passed, 0 failed
Data-loss verifier: PASS
Collaboration verifier: PASS
Security-hardening verifier: PASS
Page-cover reproduction: vulnerable state reproduced; corrected state verified
Browser JavaScript and modified TypeScript syntax checks: PASS
```

The complete dependency-backed Vitest/build path still requires a successful `npm ci` with the project-declared Node.js security floor and all registry packages available.
