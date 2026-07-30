# BrainVault backup stream integrity audit (2026-07-30)

## Conclusion

When generating an attachment backup ZIP, the previous implementation could finish the ZIP central directory without detecting that a staged file had been changed to different bytes of the **same size** after preflight validation. The ZIP headers and `brainvault.json` would contain the earlier CRC32 and SHA-256 values while the payload contained the changed bytes, so a later restore would reject the archive during integrity verification.

This defect did not immediately delete the original workspace. The normal application path does not rewrite staged files, so the likelihood was limited. However, local file tampering, storage faults, or accidental reuse by a future code path could make a download appear successful even though the backup was unusable. The issue was therefore classified as a backup-integrity risk with **high impact, low likelihood, and Medium overall severity**.

## Reproduction conditions

1. `prepareUserDataBackup()` stages an attachment and calculates its size, CRC32, and SHA-256.
2. The staged file bytes change after validation but before or during ZIP streaming.
3. The file size remains unchanged.
4. The previous `ZipWriter.add()` compares only the byte count and writes the precomputed CRC32 to the ZIP header.
5. Export completes, but restore rejects the archive because the CRC32 or SHA-256 does not match.

Reproduction command:

```bash
npm run reproduce:backup-stream-integrity-loss
```

## Correction

- `ZipWriter.add()` now recalculates CRC32 over every chunk it actually emits.
- Attachments also have the manifest SHA-256 recalculated during streaming.
- If the size, CRC32, or SHA-256 differs from the preflight value, the writer fails before completing the central directory.
- `writeUserDataBackup()` now passes the attachment's preflight SHA-256 to `ZipWriter`.
- Buffer entries no longer trust a caller-provided CRC32 and compare it with the measured value.

## Regression verification

- Dependency-free Node test that detects same-size staged-file changes
- Successful ZIP completion test for unchanged bytes
- Invalid buffer CRC32 rejection test
- Source guards and vulnerable/fixed-state reproduction integrated into `verify:data-loss`
- Collaboration-bootstrap reproduction corrected so it can locate and execute the historical vulnerable commit even when run from the currently fixed `HEAD`

## Operational impact

An error can still occur after HTTP streaming begins, so the response may terminate partway through. This is the intended fail-closed behavior and is safer than delivering a completed but unrestorable ZIP as a successful download. The user can retry the failed download, and the server does not modify the original workspace or attachment files.
