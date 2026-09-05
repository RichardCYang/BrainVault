import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { hasPageDeletionMembershipOutsideCollectionScope } from "../src/lib/page-delete-snapshot.ts";

const movedSubtree = [
  { id: "page_a" },
  { id: "private_child" }
];

test("reproduction: collection-admin move rejects a descendant materialized outside the authorizing collection", () => {
  // Reproduction:
  // 1. page_a is in collection_a, where the actor has ADMIN.
  // 2. A malformed/legacy hierarchy edge keeps private_child below page_a,
  //    while private_child is actually materialized in collection_b.
  // 3. Moving page_a within collection_a traverses both hierarchy rows.
  // 4. The old move path rewrote every traversed membership to collection_a,
  //    silently modifying private_child outside the actor's authorization.
  const memberships = [
    { page_id: "page_a", collection_id: "collection_a" },
    { page_id: "private_child", collection_id: "collection_b" }
  ];

  assert.equal(
    hasPageDeletionMembershipOutsideCollectionScope(
      movedSubtree,
      memberships,
      "collection_a"
    ),
    true,
    "the move must fail closed before rewriting the unauthorized descendant"
  );
  assert.equal(
    hasPageDeletionMembershipOutsideCollectionScope(
      movedSubtree,
      [{ page_id: "page_a", collection_id: "collection_a" }],
      "collection_a"
    ),
    true,
    "a missing descendant membership must also fail closed"
  );
  assert.equal(
    hasPageDeletionMembershipOutsideCollectionScope(
      movedSubtree,
      [
        { page_id: "page_a", collection_id: "collection_a" },
        { page_id: "private_child", collection_id: "collection_a" }
      ],
      "collection_a"
    ),
    false,
    "a consistently materialized subtree remains movable"
  );
});

test("page PATCH validates the full locked subtree before parent or membership mutation", () => {
  const route = readFileSync(
    new URL("../src/routes/page.routes.ts", import.meta.url),
    "utf8"
  ).replace(/\r\n/g, "\n");

  const patchStart = route.indexOf('pageRouter.patch("/:pageId"');
  const deleteStart = route.indexOf('pageRouter.delete(\n  "/:pageId"', patchStart);
  assert.ok(patchStart >= 0 && deleteStart > patchStart);
  const patchRoute = route.slice(patchStart, deleteStart);

  const replay = patchRoute.indexOf("isMatchingMutationReplay(");
  const hierarchyValidation = patchRoute.indexOf(
    "assertPageParentFromLockedRows(pageId, updates.parentPageId, lockedRows)"
  );
  const subtreeRead = patchRoute.indexOf(
    "const subtreeRows = getPageSubtreeRows(pageId, lockedRows);",
    hierarchyValidation
  );
  const membershipRead = patchRoute.indexOf(
    "getPageDeletionCollectionMemberships(",
    subtreeRead
  );
  const lockingArgument = patchRoute.indexOf(
    "true\n          );",
    membershipRead
  );
  const scopeValidation = patchRoute.indexOf(
    "assertPageMoveAuthorizationScope(initialAccess, subtreeRows, membershipRows)",
    membershipRead
  );
  const parentUpdate = patchRoute.indexOf("UPDATE pages SET", scopeValidation);
  const membershipRewrite = patchRoute.indexOf(
    "replacePageSubtreeCollectionMembership(",
    scopeValidation
  );

  assert.ok(replay >= 0 && hierarchyValidation > replay,
    "exact response-loss replay handling must remain first");
  assert.ok(subtreeRead > hierarchyValidation,
    "authorization must use the owner-locked hierarchy");
  assert.ok(membershipRead > subtreeRead && lockingArgument > membershipRead,
    "membership authorization must use a current SELECT ... FOR UPDATE read");
  assert.ok(scopeValidation > lockingArgument,
    "the full subtree must be authorized after current membership capture");
  assert.ok(parentUpdate > scopeValidation,
    "the parent edge must not change before subtree authorization");
  assert.ok(membershipRewrite > scopeValidation,
    "collection memberships must not be rewritten before subtree authorization");

  assert.match(
    route,
    /function assertPageMoveAuthorizationScope[\s\S]*access\.role !== "ADMIN"[\s\S]*access\.scope === "COLLECTION"[\s\S]*hasPageDeletionMembershipOutsideCollectionScope/
  );
});
