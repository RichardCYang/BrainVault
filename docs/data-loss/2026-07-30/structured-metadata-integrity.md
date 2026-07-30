# BrainVault structured-block data-integrity deep audit and correction report

Audit date: 2026-07-30 (Asia/Seoul)  
Scope: complete uploaded `BrainVault.zip` working tree and preserved `.git` directory  
Baseline Git HEAD: `96ec2a6`  
Focus: preservation of authoritative structured-block data, Yjs relational materialization, destructive materialization order, and recovery of partially damaged data

## 1. Final conclusion

This follow-up audit identified and corrected two new data-integrity defects.

1. **High — successful writes silently truncated BOOKMARK and AI_CHAT metadata**
   - Direct block create/update and Yjs relational-materialization paths normalized original metadata and then stored the normalized result as authoritative database data.
   - Data beyond allowed length or count limits disappeared silently even though the request succeeded.
   - In the deterministic reproduction, an AI answer of 12,001 characters was stored as 12,000 characters, permanently losing one character.

2. **Medium — DATABASE fallback recovery created views referencing nonexistent properties**
   - When a `database` object existed but its properties or views were incomplete, normalization could leave only a `title` property while the default board view still referenced nonexistent `status` in both `groupPropertyId` and `hiddenPropertyIds`.
   - Row data was not deleted directly, but the recovered metadata became self-inconsistent. Grouping and hidden-field behavior could be wrong, and later edits could trigger unstable renormalization.

The correction enforces:

```text
successful structured-block save
    ⇒ authoritative request metadata remains in the database with identical byte meaning

input whose UI normalization would remove data
    ⇒ entire request or materialization fails closed before database/Yjs relational writes

all property references in a DATABASE fallback view
    ⇒ refer to properties that actually exist in the same normalized result
```

No separate new Critical or High permanent-loss path was identified after the corrections and regression checks. Live MariaDB crash injection and the full Vitest integration suite were not run in the sandbox because of the limitations below.

## 2. Audit scope and method

The source-level state-machine review covered:

- Metadata → derived Markdown/HTML → database order for direct block create/update
- Durable Yjs update log → server-authoritative materialization → SQL `UPDATE`/`DELETE`/`INSERT` order
- `slice`, duplicate removal, and reference-cleanup behavior in TABLE, KANBAN, DATABASE, BOOKMARK, and AI_CHAT normalizers
- Version snapshots, subtree locking, and detachment of surviving rows before foreign-key cascades in permanent page/block deletion
- Exclusive attachment publication, file/directory `fsync`, and file preservation when commit outcome is ambiguous
- SHA-256, CRC, staging, and generation-journal behavior in user ZIP backup/restore
- Browser durable-before-visible recovery order and cleanup after Yjs acknowledgement
- Multi-process stale-room and materialization-checkpoint fences

Verification combined:

1. Searching for every normalization call that could change authoritative data between request and storage
2. A dependency-free reproducer executing the project's real vulnerable normalizers
3. Node regression tests for exact limits, over-limit values, excessive counts, relationship references, and single JSON serialization
4. Random cross-checking of 4,000 normal normalized results: 1,000 each for TABLE, KANBAN, DATABASE, and AI_CHAT
5. Rerunning four existing data-loss reproducers plus durability and collaboration static guards
6. Syntax checks across 144 TypeScript and JavaScript files
7. Per-file comparison of the original ZIP and corrected tree
8. Recursive SHA-256 and byte comparison of the original and final `.git` directories

## 3. High defect: silent storage of truncated structured metadata

### 3.1 Vulnerable code path

The previous `prepareBlockContent()` in `src/routes/block.routes.ts` and `src/routes/collaboration.routes.ts` used:

```text
original metadata
→ normalizeBookmarkMetadata() or normalizeAiChatMetadata()
→ generate summary Markdown
→ store normalized metadata as authoritative database value
```

The normalizers are valid safety projections for display and search, but include destructive operations such as:

- AI question maximum: 8,000 characters
- AI answer maximum: 12,000 characters
- AI model maximum: 120 characters
- BOOKMARK maximum: 50 items
- URL, title, description, and site-name length limits
- Duplicate URL removal
- Control-character and whitespace cleanup
- Replacement or removal of invalid provider, view, or URL values

The routes used the projection to replace the source rather than only deriving display output. A successful HTTP response or Yjs materialization therefore did not imply full data preservation.

### 3.2 Deterministic reproduction

Added command:

```bash
npm run reproduce:structured-metadata-loss
```

Core output:

```json
{
  "vulnerability": {
    "originalCharacters": 12001,
    "oldStoredCharacters": 12000,
    "silentlyLostCharacters": 1
  },
  "fixedBehavior": {
    "rejectedBeforeWrite": true,
    "rejectedPath": "metadata.aiChat.answer",
    "authoritativeMetadataIsNoLongerReplacedByTheProjection": true
  }
}
```

The reproducer executes the project's real `normalizeAiChatMetadata()` rather than a simplified model.

### 3.3 Permanent-loss conditions

The issue could be reproduced when UI limits were bypassed through:

- Direct API calls
- Browser developer tools or extensions
- Limit mismatches in an older or future client
- Metadata inserted into a Yjs document by external code
- Old or manually authored backup/API payloads

The server returned success and retained no copy of the source, so the excess data was unrecoverable when no separate backup existed.

## 4. High-defect correction

### 4.1 Authoritative metadata separated from derived projection

BOOKMARK and AI_CHAT storage now follows:

```text
original metadata ───────────────→ authoritative database metadata
       └→ get*Data() → summary Markdown / html_cache
```

- `getBookmarkData(metadata)` and `getAiChatData(metadata)` are used only to derive Markdown and HTML.
- The database `metadata` value is the validated original object, not the normalized projection.
- If a JSON column is returned as a string, the validator decodes it exactly once, and storage serializes it exactly once.
- Markdown/checked updates that omit metadata do not rewrite the existing metadata column, preventing double JSON encoding.
- Derived Markdown remains length-limited for search and preview but never overwrites authoritative source data.

### 4.2 Common fail-closed server validator

A new `src/lib/structured-metadata-integrity.ts` covers:

- TABLE
- KANBAN
- DATABASE
- BOOKMARK
- AI_CHAT

It validates:

- Maximum counts for rows, columns, cards, properties, options, views, filters, sorts, and bookmarks
- String-length limits
- Duplicate IDs, tags, and URLs
- Unsupported enum values
- References to nonexistent properties, options, or views
- NUL bytes, control characters, or noncanonical whitespace that normalization would remove
- URL scheme, credentials, fragments, and canonical form
- Exact `YYYY-MM-DDTHH:mm` format for AI `answeredAt`

On validation failure:

- Direct save returns `400 BLOCK_METADATA_WOULD_TRUNCATE`.
- Collaboration materialization returns `409 COLLABORATION_METADATA_WOULD_TRUNCATE`.
- The first lossy path is included in `details.path`.
- The entire transaction stops before any database write.

### 4.3 Validation before destructive collaboration materialization

A collaboration snapshot now validates structured metadata for every materialized block before:

- Locking existing rows
- Detaching surviving child rows
- Deleting obsolete blocks
- Performing `UPDATE` or `INSERT`
- Advancing the materialization checkpoint

One invalid structured block therefore cannot cause valid blocks to be deleted first or create a partially applied materialization.

## 5. Medium defect: dangling references in DATABASE fallback views

### 5.1 Cause

`getDatabaseData()` first normalized the actual property set when recovering partially damaged metadata. When no valid view remained, it reused two views from a complete default database without adapting them to the normalized properties.

A partial result could become:

```json
{
  "properties": [
    { "id": "title", "type": "title" }
  ],
  "views": [
    {
      "id": "board-view",
      "groupPropertyId": "status",
      "hiddenPropertyIds": ["status"]
    }
  ]
}
```

Because `status` did not exist, the result violated its own reference integrity.

### 5.2 Correction

Fallback views are reconciled against the current `propertyById`:

- Board grouping is allowed only for an existing property of type `select` or `checkbox`.
- A nonexistent group becomes `null`.
- Hidden properties are retained only when they exist and are not the title property.
- The active view is selected from the cleaned view set.

The defect reproduced immediately in the random normalization/validation cross-check before the fix. After correction, all 4,000 normalized results—1,000 each for TABLE, KANBAN, DATABASE, and AI_CHAT—passed the new integrity validator.

## 6. Existing major defenses revalidated

The review confirmed current wiring and regression coverage for:

- MariaDB transaction and row-lock serialization for page, owner, and block operations
- Distinguishing ambiguous commit outcomes from ordinary rollback failure
- Attachment hard-link exclusive publication and file/directory `fsync`
- Preservation of moved attachment files when the database commit result is unknown
- Owner lock and database-existence recheck immediately before attachment cleanup
- Durable Yjs log as the sole authority for relational materialization
- Rejection of writes and compaction from stale process-local rooms
- Materialization-version and exact-update checkpoint fences
- Reconciliation that prevents stale SQL positions from overwriting acknowledged Yjs attachment positions
- Durable-before-visible browser editing
- Exact version snapshots and subtree validation before permanent page/block deletion
- Detachment of surviving child blocks and attachments before foreign-key cascades
- Backup manifest fingerprints, attachment SHA-256/CRC, staging, and restore-generation journals
- Marker/journal startup recovery when restore commit outcome is ambiguous

## 7. Verification results

### 7.1 Passed

```text
lockfile registry check:                   PASS
Node durability tests:                     19/19 PASS
structured metadata reproduction:          PASS
verify:data-loss:                          PASS
verify:collaboration:                       PASS
source syntax check:                       144 files PASS
new TS strict subset compile:               PASS
normalization/validator random crosscheck: 4,000/4,000 PASS
existing loss reproductions:                4/4 PASS
```

Existing reproducers covered:

- Forged collaboration materialization
- Cross-instance compaction
- Browser recovery-write failure
- Stale SQL attachment position

Each reproduced the loss window in the vulnerable model and demonstrated blocking in the current corrected model.

### 7.2 Execution-environment limitations

Full `npm ci`, `npm run build`, and the Vitest integration suite could not complete.

Cause:

- The sandbox's forced internal npm mirror returned `404` for the lockfile's `zod` package version.
- Direct access to the public npm registry failed with DNS `EAI_AGAIN`.

This was a package-download limitation, not a project-code failure. Before deployment, rerun in an environment with normal package and database access:

```bash
npm ci
npm run check
```

Additional recommended operational tests:

- Force process termination immediately before and after MariaDB commit.
- Inject disk-full, read-only, and `fsync` failures.
- Stop the server immediately after attachment movement and verify startup recovery.
- Force multi-tab browser termination.
- Inject independent database and filesystem failures during backup restore.
- Run long-duration Yjs reconnect and compaction tests through the production proxy.

## 8. Changed files

Core product code:

- `src/lib/structured-metadata-integrity.ts` — new fail-closed structured-metadata validator
- `src/routes/block.routes.ts` — preserve direct-save source and validate before write
- `src/routes/collaboration.routes.ts` — validate the complete snapshot before destructive materialization
- `src/lib/database.ts` — repair fallback-view reference integrity

Reproduction and regression:

- `scripts/reproduce-structured-metadata-truncation.mjs`
- `tests/structured-metadata-integrity.node.test.mjs`
- `scripts/verify-data-loss-guards.mjs`
- `package.json`

Documentation:

- This report
- Documentation index

`package-lock.json` and dependency versions were not changed.

## 9. `.git` preservation

Because read-only Git commands can update index stat-cache fields, the original `.git` content from the uploaded ZIP was overlaid byte-for-byte at the same paths before final packaging.

Final verification required:

- `.git` directory present
- Identical recursive `.git` file inventory in original and corrected copies
- Identical SHA-256 for every `.git` file
- Identical results after extracting the final ZIP

Git history was not modified, rewritten, or committed.
