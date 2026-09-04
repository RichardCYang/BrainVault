# Permanent collection deletion cascade-closure integrity

## Finding

`page_collection_memberships` has two foreign keys to `pages`, and both use `ON DELETE CASCADE`: one on `page_id` and one on `collection_id`. The permanent-deletion snapshot previously selected membership rows only when `page_id` belonged to the confirmed subtree.

That left a reverse-edge gap. If a stale, legacy, manually repaired, or otherwise inconsistent membership linked a surviving page to a collection being deleted, MariaDB would remove that membership through the `collection_id` cascade even though the surviving page was outside the user's confirmed deletion scope. The row was absent from both the preview snapshot and the locked validation read.

Normal application writes rebuild membership from the owner-scoped page tree, but destructive code must fail closed when persisted relationships violate that invariant rather than extending a database cascade beyond the authorized subtree.

## Reproduction

1. Create collection `collection_a` with child `page_child`.
2. Obtain a permanent-deletion snapshot for `collection_a`; the confirmed subtree contains those two page IDs.
3. Introduce or retain an inconsistent row `(page_id = outside_page, collection_id = collection_a)`, where `outside_page` is not a descendant of `collection_a` and remains otherwise valid.
4. Submit the deletion using the previously issued snapshot.
5. Before this correction, the snapshot query saw only the two rows whose `page_id` was in the subtree. Deleting `collection_a` caused the database to cascade through `collection_id` and silently removed `outside_page`'s membership as well.
6. After this correction, preview and permanent deletion read the reverse `collection_id` edge. The server returns `409 PAGE_EDIT_CONFLICT` before destructive SQL, and no page or membership row is deleted.

## Correction

- Membership discovery now reads both foreign-key directions in bounded, indexed batches.
- Rows returned by both directions are de-duplicated by the table's `page_id` primary key before snapshot hashing.
- Preview refuses to issue a deletion snapshot when a reverse membership escapes the confirmed subtree.
- Permanent deletion performs the same reverse read with `FOR UPDATE`, checks closure before the snapshot fence, and therefore cannot race across the previously invisible cascade edge.
- The conflict response does not disclose the surviving page ID, which may belong to another workspace.
- SQL values remain parameterized and authorization still occurs before relationship inspection; no HTML-producing path was added or changed.

## Regression coverage

`tests/page-delete-collection-cascade-closure.node.test.mjs` verifies the reverse-FK reproduction, valid contained relationships, both query directions, locking, and guard placement before snapshot creation and destructive page SQL.

## Validation performed

- Focused permanent-deletion suite: 35 tests passed, 0 failed.
- Focused authorization, sharing-generation, and safe-rendering suite: 52 tests passed, 0 failed.
- Dependency-free durability suite: 786 tests discovered; 776 passed. The same 10 environment-dependent tests fail because this isolated workspace cannot install `tsx`, `zod`, or generated JavaScript siblings without package-registry access.
- TypeScript parse/transpile checks for both modified TypeScript files passed with 0 errors.
