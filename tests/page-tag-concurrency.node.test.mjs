import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const pageRoutes = await fs.readFile(new URL("../src/routes/page.routes.ts", import.meta.url), "utf8");

test("tag replacement re-reads a concurrently-created tag with a locking/current read", () => {
  const start = pageRoutes.indexOf("async function replaceTags(");
  const end = pageRoutes.indexOf("\nasync function getBlocks(", start);
  assert.notEqual(start, -1, "replaceTags helper must exist");
  assert.notEqual(end, -1, "replaceTags helper boundary must exist");

  const helper = pageRoutes.slice(start, end);
  assert.match(helper, /INSERT IGNORE INTO tags/);
  assert.match(
    helper,
    /SELECT \* FROM tags WHERE name = \? FOR UPDATE/,
    "the post-INSERT lookup must not reuse an older REPEATABLE READ snapshot"
  );
});

test("reproduction model: stale snapshot lookup can drop the requested tag", () => {
  // T1 establishes a REPEATABLE READ snapshot before the shared tag exists.
  const t1Snapshot = new Map();
  // T2 inserts the same normalized tag and commits.
  const currentTags = new Map([["release", { id: "tag_t2", name: "release" }]]);

  // T1's INSERT IGNORE observes the duplicate in current state, so it inserts nothing.
  const insertedByT1 = !currentTags.has("release");
  assert.equal(insertedByT1, false);

  // A plain SELECT remains on T1's old snapshot and cannot resolve the tag id.
  assert.equal(t1Snapshot.get("release"), undefined);

  // A locking/current read resolves T2's committed row, allowing page_tags to link it.
  assert.equal(currentTags.get("release")?.id, "tag_t2");
});
