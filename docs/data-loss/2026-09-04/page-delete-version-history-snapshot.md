# Permanent page deletion and version-history snapshot integrity

## Finding

Permanent page deletion validated a deterministic subtree snapshot before deleting pages, but that snapshot did not include `page_versions`. Version-history rows are user-visible data and are removed automatically by the `fk_page_versions_page ... ON DELETE CASCADE` foreign key.

The owner-only history reset intentionally restarts the displayed history at revision 1 without advancing the live page `edit_version` or `content_version`. Consequently, an already-issued permanent-deletion snapshot could remain valid after another session replaced the history.

## Reproduction

1. Open the permanent-delete confirmation for a page at edit version 7 and content version 11. The browser obtains snapshot **S1**.
2. In another authenticated owner session, reset that page's version history.
3. The reset deletes the old `page_versions` rows and inserts a new revision-1 `RESET` baseline. The page remains at edit version 7 and content version 11.
4. Submit the original permanent-delete request with **S1**.
5. Before this correction, all covered page, block, share, membership, collaboration, and comment generations still matched, so deletion succeeded and the foreign key cascaded through the newly created history.
6. After this correction, the current history-row digest differs from **S1**. The server returns `409 PAGE_EDIT_CONFLICT`; no page or history row is deleted.

## Correction

- The deletion-snapshot endpoint now includes every version-history row in its SHA-256 precondition.
- SQL computes a SHA-256 digest over every stored history field, while the application receives only row identity plus the digest rather than the full actors/change payload.
- The permanent-delete transaction reads those rows with `FOR UPDATE` after locking the owned page tree and before snapshot comparison.
- The deterministic application hash sorts and binds each digest to its page ID, row ID, and revision.
- No endpoint returns new user-authored HTML or history payload, and all database lookup IDs continue to use placeholders derived only from the already-authorized subtree.

## Regression coverage

`tests/page-delete-version-history-snapshot.node.test.mjs` verifies:

- a reset changes the permanent-deletion snapshot even when live page versions do not change;
- history ordering cannot change the hash;
- row identity and content digest are snapshot-bound;
- preview reads and hard deletion locks the same history source;
- snapshot validation precedes the destructive page-delete sink; and
- the reset implementation still preserves its existing monotonic page-version behavior.

## Validation performed

- Focused permanent-deletion regression suite: 39 tests passed, 0 failed.
- Complete dependency-free Node durability suite: 783 tests discovered; 773 passed. The same 10 tests failed before and after this patch because the isolated archive has no installed `tsx`/`zod` dependencies or compiled JavaScript siblings.
- Node syntax checks, TypeScript parse/transpile checks for both modified TypeScript files, and OpenAPI YAML parsing passed.
- `git fsck --full --no-reflogs` completed successfully.
- A metadata-only manifest of all `.git` entries remained unchanged throughout extraction, Git CLI inspection, patching, and testing.
