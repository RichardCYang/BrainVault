import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const appUrl = new URL("../public/app.js", import.meta.url);

function section(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start);
  assert.ok(start >= 0 && end > start, `missing source section: ${startNeedle}`);
  return source.slice(start, end);
}

test("block delete cleans only the exact recovery records captured before dispatch", async () => {
  const source = (await readFile(appUrl, "utf8")).replace(/\r\n/g, "\n");
  const deletion = section(source, "async function deleteBlockWithVersionCheck", "\nfunction updateBlockInState");

  assert.match(
    deletion,
    /const sourceDraftRecord = scope\s*\?\s*pageDraftStore\.loadPage\(\s*scope\.userId,\s*scope\.pageId,\s*pageDraftSourceId\s*\)\s*:\s*null;/s
  );
  assert.match(deletion, /const sourceDraftCleanupOrigins = deletedVersions/);
  assert.match(deletion, /sourceBlockOrderMutationId/);
  assert.match(deletion, /pageDraftStore\.removeBlockIfUnchanged\(\{/);
  assert.match(deletion, /pageDraftStore\.acknowledgeBlockOrder\(\{/);
  assert.doesNotMatch(
    deletion,
    /pageDraftStore\.removeBlocks\(/,
    "a successful delete must not blanket-delete a recovery record that may have changed while the request was in flight"
  );

  const responseIndex = deletion.indexOf(
    "const data = await submitBlockDeleteTask(task, authenticationScope, {"
  );
  const renderCleanupIndex = deletion.indexOf("blockDraftRenderSources.delete", responseIndex);
  const navigationFenceIndex = deletion.lastIndexOf(
    "if (isDeleteNavigationCurrent()) {",
    renderCleanupIndex
  );
  assert.ok(
    responseIndex >= 0
      && navigationFenceIndex > responseIndex
      && renderCleanupIndex > navigationFenceIndex,
    "render-only recovery metadata must not be cleared by a response from a superseded navigation"
  );
});

test("standalone reproduction preserves a newer same-source block draft and order", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-block-delete-recovery-cleanup-race.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.equal(result.vulnerable.newerBlockDraftPreserved, false);
  assert.equal(result.vulnerable.newerBlockOrderPreserved, false);
  assert.equal(result.fixed.newerBlockDraftPreserved, true);
  assert.equal(result.fixed.newerBlockOrderPreserved, true);
  assert.equal(result.fixed.blockMarkdown, "newer recovery edit");
  assert.equal(result.fixed.blockOrderMutationId, "order-new");
});
