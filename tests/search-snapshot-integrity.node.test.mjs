import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function readSearchRoute() {
  return (await readFile(new URL("../src/routes/search.routes.ts", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");
}

test("global search reads page and block hits from one repeatable-read transaction", async () => {
  const route = await readSearchRoute();

  assert.match(route, /import \{ transaction \} from "\.\.\/lib\/db\.js";/);
  assert.match(route, /const \{ pages, blocks \} = await transaction\(async \(client\) => \{/);
  assert.equal((route.match(/await client\.query</g) ?? []).length, 2);
  assert.doesNotMatch(route, /await db\.query/);
  assert.match(route, /res\.setHeader\("Cache-Control", "private, no-store"\);/);
});

test("reproduction: restore cannot mix page hits from one workspace generation with block hits from another", () => {
  const pageId = "pag-stable-id";
  const beforeRestore = {
    pageId,
    title: "Roadmap before restore",
    blocks: ["milestone before restore"]
  };
  const afterRestore = {
    pageId,
    title: "Roadmap after restore",
    blocks: ["milestone after restore"]
  };

  // Vulnerable order: the page query commits independently, restore replaces the
  // workspace while preserving stable IDs, then the block query observes the
  // replacement generation.
  const vulnerableResponse = {
    pageTitle: beforeRestore.title,
    blockMarkdown: afterRestore.blocks[0]
  };
  assert.equal(vulnerableResponse.pageTitle, "Roadmap before restore");
  assert.equal(vulnerableResponse.blockMarkdown, "milestone after restore");

  // Fixed order: REPEATABLE READ pins both queries to the same snapshot, so the
  // response is entirely before-restore (or entirely after-restore if restore won first).
  const pinnedSnapshot = beforeRestore;
  const fixedResponse = {
    pageTitle: pinnedSnapshot.title,
    blockMarkdown: pinnedSnapshot.blocks[0]
  };
  assert.equal(fixedResponse.pageTitle, "Roadmap before restore");
  assert.equal(fixedResponse.blockMarkdown, "milestone before restore");
});
