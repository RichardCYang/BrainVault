import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("workspace navigation applies only the latest page, collection, or home intent", async () => {
  const app = (await readFile(new URL("../public/app.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const start = app.indexOf("function isCurrentWorkspaceNavigation");
  const end = app.indexOf("async function boot", start);
  assert.ok(start >= 0 && end > start);
  const source = app.slice(start, end);

  assert.match(source, /navigationGeneration = \+\+workspaceNavigationGeneration/);
  assert.match(source, /const navigationGeneration = \+\+workspaceNavigationGeneration;/);
  assert.match(source, /data = await api\(`\/api\/pages\/\$\{pageId\}`\);/);
  assert.match(source, /catch \(error\) \{\n        if \(!isCurrentWorkspaceNavigation\(navigationGeneration\)\) return;\n        throw error;/);
  assert.match(source, /if \(!isCurrentWorkspaceNavigation\(navigationGeneration\)\) return;/);
  assert.match(source, /showCollection\(pageId, \{ skipFlush: true, navigationGeneration \}\)/);
  assert.match(source, /await destroyPageCollaboration\(\{ flush: false \}\);\n      if \(!isCurrentWorkspaceNavigation\(navigationGeneration\)\) return;/);
});

test("standalone reproduction proves a slow first click cannot overwrite the latest click", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-workspace-navigation-race.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.equal(result.vulnerable.slowerFirstClickOverwroteLatestIntent, true);
  assert.equal(result.vulnerable.staleFirstFailureSurfaced, true);
  assert.equal(result.fixed.latestClickPreserved, true);
  assert.equal(result.fixed.staleFirstFailureSuppressed, true);
  assert.equal(result.fixed.selectedPageId, "page-b");
});
