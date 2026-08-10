# Complete uploaded-asset backup and restore review

Date: 2026-08-10

## Problem

Backup v2 externalized custom page-cover bytes and copied attachment bytes referenced by live `ATTACHMENT` blocks, but it did not guarantee a byte-for-byte capture of every file retained under `uploads/<userId>/`. A file deliberately kept after an ambiguous attachment database commit could therefore remain only on the server. Uploaded custom image icons also lived separately under `upload/icons/<userId>/` and were not included in the ZIP. Page/account icon fields could therefore point at files that existed only on the source server. A server-loss restore could recreate the database rows while leaving those icon URLs broken.

The custom-icon library also has two pieces of state that matter beyond the current page fields: active `custom_icons` rows and `custom_icon_library_removals` hashes. Removing a server-uploaded icon from the picker intentionally leaves its file on disk so existing page/history references remain valid. Backing up only active library rows would therefore still be lossy.

## Backup v3

Current exports use manifest version 3. In addition to the existing manifest and `page-covers/` entries, the exporter enumerates every regular file in the account's `uploads/<userId>/` attachment directory and every regular uploaded-icon file in `upload/icons/<userId>/` while holding the same user-row lock used by attachment/custom-icon mutations. Files referenced by live attachment blocks remain declared in `attachments`; additional attachment files retained on disk are declared in `retainedAttachments` and written under the same `attachments/<fileName>` ZIP namespace. This preserves intentional orphan/ambiguity-retention files without pretending they are live blocks. Every uploaded icon is staged and recorded as `custom-icons/<filename>` with byte size, CRC-32, SHA-256, detected media type, and optional active-library metadata. Attachment entries likewise carry byte size, CRC-32, and SHA-256. The manifest also records the complete custom-icon library-removal state.

Export fails closed if an active library row points outside the account directory, an active row has no corresponding file, an icon file has an unsupported name/type/size, or a page/default-collection icon references a local uploaded file that is not declared in the archive. Files removed from the picker but retained on disk are still exported with `library: null`.

## Restore and account-ID rebinding

Version 3 import validates allowed ZIP paths before staging, verifies CRC-32/SHA-256 and the actual PNG/JPEG/WebP/ICO signature, and rejects undeclared/missing icon entries. Local icon values use the source account ID in their URL, so restore rewrites `/upload/icons/<sourceUserId>/<file>` to `/upload/icons/<destinationUserId>/<file>`. Hashes in `custom_icon_library_removals` that correspond to those local paths are recomputed for the destination ID; hashes for non-local custom images remain unchanged.

This means a fresh server can create a replacement account and import the ZIP even when its internal user ID differs from the lost server. Security credentials, passkeys/MFA secrets, and the historical Yjs update log remain intentionally outside workspace backup scope, as documented in the existing backup contract.

## Crash-safe filesystem replacement

Restore journal version 4 tracks both attachment and custom-icon generations. Staged directories carry an operation marker. The database transaction records whether previous directories existed, swaps each live directory to a preserved sibling, promotes the staged generation, then writes the database commit marker. Recovery uses that marker to decide commit versus rollback.

If rollback races a later upload after the failed transaction releases its row lock, recovery preserves files whose names were not owned by the failed restore before reinstating the previous generation. The same generic recovery path is used for attachments and custom icons, so either asset class cannot be silently deleted by an interrupted rollback.

The restore conflict fingerprint now includes the live attachment/custom-icon filesystem generations in addition to active custom-icon rows and custom-icon library-removal rows, and the locked recheck selects the DB rows with `FOR UPDATE`. A newly retained attachment file, custom-icon upload/removal/touch, or orphan icon file that appears while restore is being prepared therefore makes the restore fail with `DATA_RESTORE_CONFLICT` instead of letting the restore overwrite the newer asset generation.

## Compatibility and limits

Version 1 and 2 archives remain importable. Only version 3 replaces custom-icon filesystem/library state because older archives never contained it. Version 3 also requires a `retainedAttachments` declaration, which may be empty. The 5,000 attachment-file cap is shared by live-block attachments and retained unlinked files, so ZIP admission remains bounded at 5,000 attachment files + 20,000 page covers + 20,000 custom icons + one manifest, with an 8 MiB central-directory ceiling.

## Repository preservation

The project archive supplied for this change contains `.git`. The implementation work does not rely on or rewrite the working repository metadata. Before producing the delivery archive, `.git` is restored from the original uploaded ZIP and verified file-by-file against that original archive.
