import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = async (path) => (await readFile(new URL(`../${path}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");

function unguardedEdit(row, body) {
  row.body = body;
}

function guardedEdit(row, expectedVersion, body) {
  if (row.version !== expectedVersion) return false;
  row.body = body;
  row.version += 1;
  return true;
}

function guardedDelete(row, expectedVersion) {
  if (row.version !== expectedVersion) return false;
  row.deleted = true;
  return true;
}

test("reproduction: a delayed unversioned request overwrites a newer comment", () => {
  const row = { body: "original", version: 1 };
  const delayedDraft = { body: "stale tab draft" };

  unguardedEdit(row, "newer tab edit");
  unguardedEdit(row, delayedDraft.body);

  assert.equal(row.body, "stale tab draft");
});

test("regression: exact comment generations reject stale edit and delete requests", () => {
  const row = { body: "original", version: 1, deleted: false };
  const staleVersion = row.version;

  assert.equal(guardedEdit(row, staleVersion, "newer tab edit"), true);
  assert.equal(row.version, 2);
  assert.equal(guardedEdit(row, staleVersion, "stale tab draft"), false);
  assert.equal(guardedDelete(row, staleVersion), false);
  assert.deepEqual(row, { body: "newer tab edit", version: 2, deleted: false });
});

test("regression: restore assigns a fresh generation before delayed requests resume", () => {
  const staleVersion = 7;
  const restored = { body: "restored backup text", version: 1_000_007, deleted: false };

  assert.equal(guardedEdit(restored, staleVersion, "pre-restore draft"), false);
  assert.equal(guardedDelete(restored, staleVersion), false);
  assert.deepEqual(restored, {
    body: "restored backup text",
    version: 1_000_007,
    deleted: false
  });
});

test("implementation binds API, browser draft, restore, and hard-delete snapshot to versions", async () => {
  const [route, app, transfer, deletionSnapshot, migration] = await Promise.all([
    read("src/routes/collaboration.routes.ts"),
    read("public/app.js"),
    read("src/lib/data-transfer.ts"),
    read("src/lib/page-delete-snapshot.ts"),
    read("migrations/070_page_comment_edit_versions.sql")
  ]);

  assert.match(migration, /edit_version BIGINT UNSIGNED NOT NULL DEFAULT 1/);
  assert.match(route, /version: Number\(row\.edit_version\)/);
  assert.match(route, /WHERE page_id = \? AND id = \? AND edit_version = \?/);
  assert.match(route, /PAGE_COMMENT_EDIT_CONFLICT/);
  assert.match(app, /state\.pageComments\.editingVersion = editingVersion/);
  assert.match(app, /body: \{ body, expectedVersion \}/);
  assert.match(app, /method: "DELETE",\s*body: \{ expectedVersion \}/);
  assert.match(transfer, /restoreVersion, comment\.createdAt, comment\.updatedAt/);
  assert.match(deletionSnapshot, /Number\(comment\.edit_version \?\? 1\)/);
});
