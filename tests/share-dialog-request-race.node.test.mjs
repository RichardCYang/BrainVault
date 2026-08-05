import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("share dialog results remain bound to the page and dialog generation that requested them", async () => {
  const app = (await readFile(new URL("../public/app.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const start = app.indexOf("function isCurrentSharePageRequest");
  const end = app.indexOf("async function setSelectedPageShareCount", start);
  assert.ok(start >= 0 && end > start);
  const source = app.slice(start, end);

  assert.match(source, /requestGeneration === sharePageRequestGeneration/);
  assert.match(source, /state\.selectedPage\?\.id === pageId/);
  assert.match(source, /api\(`\/api\/pages\/\$\{encodeURIComponent\(pageId\)\}\/shares`\)/);
  assert.match(source, /await flushPendingPageEdits\(\);[\s\S]*?state\.selectedPage\?\.id !== pageId/);
  assert.match(source, /const data = await api[\s\S]*?if \(!isCurrentSharePageRequest\(requestGeneration, pageId\)\) return;[\s\S]*?state\.sharePageEntries/);
  assert.match(source, /function closeSharePageDialog[\s\S]*?sharePageRequestGeneration \+= 1;/);
  assert.match(source, /state\.sharePageEntries = \[\];/);
});

test("standalone reproduction proves stale share lists can target the wrong current page", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-share-dialog-request-race.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.equal(result.vulnerable.stalePageAListRenderedForPageB, true);
  assert.equal(result.vulnerable.staleRemoveWouldTargetCurrentPage, true);
  assert.equal(result.fixed.latestPageListPreserved, true);
  assert.equal(result.fixed.staleRemoveTargetSuppressed, true);
});
