import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createPageDeletionSnapshot } from "../src/lib/page-delete-snapshot.ts";

const pages = [{ id: "page_1", parent_page_id: null, edit_version: 4, content_version: 8 }];
const blocks = [{ id: "block_1", page_id: "page_1", edit_version: 3 }];
const shares = [{
  page_id: "page_1",
  user_id: "user_admin",
  permission: "COLLECTION:ADMIN",
  generation: "share_generation_1"
}];

function snapshot(ownerId, generation) {
  return createPageDeletionSnapshot(
    pages,
    blocks,
    shares,
    [],
    [],
    [{ page_id: "page_1", collection_id: "page_1" }],
    [],
    { ownerId, generation }
  );
}

test("an owner workspace restore invalidates an otherwise identical admin deletion snapshot", () => {
  // Reproduction model:
  // 1. Collection admin previews permanent deletion in owner generation 12.
  // 2. The owner restores a byte-for-byte-equivalent workspace snapshot; stable
  //    page/block/share ids and edit versions can all reappear, while the owner
  //    workspace generation advances to 13.
  // 3. The old admin confirmation must no longer match the destructive snapshot.
  const beforeRestore = snapshot("user_owner", 12);
  const afterRestore = snapshot("user_owner", 13);

  assert.notEqual(afterRestore, beforeRestore);
  assert.notEqual(snapshot("different_owner", 12), beforeRestore);
});

test("page deletion preview and final sink both bind the owner workspace generation", () => {
  const route = readFileSync(new URL("../src/routes/page.routes.ts", import.meta.url), "utf8")
    .replace(/\r\n/g, "\n");
  const snapshotSource = readFileSync(new URL("../src/lib/page-delete-snapshot.ts", import.meta.url), "utf8")
    .replace(/\r\n/g, "\n");

  const previewStart = route.indexOf('pageRouter.get(\n  "/:pageId/deletion-snapshot"');
  const previewEnd = route.indexOf('pageRouter.patch("/:pageId"', previewStart);
  const deleteStart = route.indexOf('pageRouter.delete(\n  "/:pageId"');
  const deleteEnd = route.indexOf('pageRouter.put("/:pageId/tags"', deleteStart);
  assert.ok(previewStart >= 0 && previewEnd > previewStart);
  assert.ok(deleteStart >= 0 && deleteEnd > deleteStart);

  const preview = route.slice(previewStart, previewEnd);
  const deletion = route.slice(deleteStart, deleteEnd);
  assert.match(snapshotSource, /hash\.update\(`workspace\\0\$\{workspace\.ownerId\}\\0\$\{workspace\.generation\}\\n`\)/);
  assert.match(preview, /getPageDeletionWorkspaceGeneration\(client, access\.page\.owner_id\)/);
  assert.match(preview, /ownerId: access\.page\.owner_id, generation: workspaceGeneration/);
  assert.match(deletion, /assertPageDeletionSnapshot\([\s\S]*workspaceOwnerId,[\s\S]*attachmentGeneration/);
});
