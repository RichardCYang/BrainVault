# BrainVault backup stream and transport integrity review (2026-07-30)

## Conclusion

Two recovery-integrity failure modes were reproduced and are now closed.

1. A staged attachment could previously change to different bytes of the same size after preflight inspection, allowing the ZIP stream to finish with payload bytes that disagreed with the recorded CRC32 and SHA-256.
2. The export response previously did not declare the exact ZIP representation length. A server, reverse proxy, or intermediary that gracefully ended and reframed a shortened `200 OK` body could therefore deliver a truncated archive that the browser accepted as a completed download.

Neither defect immediately deleted the live workspace. Both could, however, create a false successful-backup signal and leave the user without a usable recovery artifact. The transport defect is classified as **Medium severity**: recovery impact is high, but exploitation requires an abnormal server or intermediary truncation that still produces a syntactically complete HTTP response.

No new Critical or High normal-use data-loss path was reproduced in the current attached workspace.

## Reproduction conditions

### Stream-time staged-file mutation

1. `prepareUserDataBackup()` stages an attachment and calculates its size, CRC32, and SHA-256.
2. The staged bytes change after validation but before or during ZIP streaming.
3. The file size remains unchanged.
4. A writer that checks only the byte count can complete the ZIP with stale checksums.
5. Restore later rejects the archive.

Reproduction command:

```bash
npm run reproduce:backup-stream-integrity-loss
```

### Gracefully truncated transport response

1. The server knows the complete archive size but omits it from the response.
2. A server path or intermediary emits only a prefix of the ZIP and cleanly terminates or reframes the response as complete.
3. The old browser path reads the body as a Blob and downloads it without comparing it with an authoritative expected size.
4. The user receives a truncated ZIP with no application-level error.

Reproduction command:

```bash
npm run reproduce:backup-transport-truncation
```

The dependency-free reproducer demonstrates both states:

- A complete HTTP response with no declared archive length is accepted even though it contains only a ZIP prefix.
- The same shortened response is rejected when the exact `Content-Length` is retained.

This reproducer intentionally models a graceful, reframed truncation. A raw connection failure in the middle of a valid chunked response is already incomplete at the HTTP layer and is not the missing-length case addressed here.

## Correction

### ZIP byte integrity

- `ZipWriter.add()` recalculates CRC32 over every chunk it emits.
- Attachment SHA-256 is recalculated during streaming.
- Size, CRC32, or SHA-256 mismatch stops export before central-directory completion.
- Buffer entries no longer trust caller-provided CRC32 values.

### Exact archive length

- `calculateZipArchiveSize()` computes the exact STORE-mode ZIP length before response headers are sent.
- The calculation includes UTF-8 entry names, local headers, central-directory records, ZIP64 extra fields, ZIP64 end records, and sentinel boundaries.
- `prepareUserDataBackup()` stores the calculated length in the export plan.
- `/api/data/export` sends that value as `Content-Length` and enables Node.js `strictContentLength` verification.
- The response includes `Cache-Control: private, no-store, no-transform` so intermediaries must not transform the ZIP representation.
- The browser requires a decimal `Content-Length` and compares it with the final Blob size before creating a downloadable object URL.

## Regression verification

- Regular ZIP measurement matches the actual bytes emitted by `ZipWriter`.
- ZIP64 sentinel-boundary measurement includes all required records.
- Same-size staged-file mutation is rejected.
- SHA-256 mismatch is rejected even when the streamed CRC32 matches.
- Gracefully shortened no-length response reproduces the false-success state.
- Gracefully shortened length-framed response is rejected by the client.
- Source wiring and vulnerable/corrected-state reproduction are integrated into `verify:data-loss`.

## Operational impact

Export remains streaming and does not require buffering the entire backup in memory or writing a second complete archive to disk. If a source changes or a transfer ends early, the declared length makes the response incomplete instead of allowing a shortened ZIP to appear successful. The live workspace and attachment files are not modified by backup export.

## Official references

- RFC 9112, HTTP/1.1 message-body length and incomplete-message rules: https://www.rfc-editor.org/rfc/rfc9112.html
- RFC 9111, `no-transform` response directive: https://www.rfc-editor.org/rfc/rfc9111.html
- Node.js HTTP API, `response.strictContentLength`: https://nodejs.org/api/http.html
