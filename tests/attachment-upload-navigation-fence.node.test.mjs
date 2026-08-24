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

test("attachment upload binds the create POST to the initiating page navigation", async () => {
  const source = (await readFile(appUrl, "utf8")).replace(/\r\n/g, "\n");
  const submit = section(
    source,
    "async function submitAttachmentCreateTask",
    "\nasync function uploadAttachmentFromRow"
  );
  const upload = section(
    source,
    "async function uploadAttachmentFromRow",
    "\nfunction requestAttachmentUpload"
  );

  assert.match(
    submit,
    /authenticationScope,\s*\{ requestGuard = null \} = \{\}/
  );
  assert.match(submit, /if \(requestGuard\?\.\(\) === false\) return skippedApiRequest;/);
  assert.match(
    submit,
    /beforeFetch:\s*\(\) => \(\s*isCurrentAuthenticatedSessionScope\(authenticationScope\)\s*&& requestGuard\?\.\(\) !== false\s*\)/
  );
  assert.match(
    submit,
    /pendingAttachmentCreateTasks\.set\(task\.taskKey, task\);\s*return skippedApiRequest;/
  );

  assert.match(upload, /const navigationGeneration = workspaceNavigationGeneration;/);
  assert.match(
    upload,
    /const isUploadIntentCurrent = \(\) => \(\s*isCurrentAuthenticatedSessionScope\(authenticationScope\)\s*&& isCurrentWorkspaceNavigation\(navigationGeneration\)\s*&& state\.workspaceView === "page"\s*&& state\.selectedPage\?\.id === pageId\s*\);/
  );

  const flushIndex = upload.indexOf("await blockSaveQueues.get(blockId).flush();");
  const intentFenceIndex = upload.indexOf("if (!isUploadIntentCurrent()) return null;", flushIndex);
  const taskIndex = upload.indexOf("const task = getAttachmentCreateTask", intentFenceIndex);
  assert.ok(flushIndex >= 0 && intentFenceIndex > flushIndex && taskIndex > intentFenceIndex);

  assert.match(
    upload,
    /submitAttachmentCreateTask\(task, authenticationScope, \{\s*requestGuard: isUploadIntentCurrent\s*\}\)/
  );
  assert.match(
    upload,
    /data === skippedApiRequest\s*\|\| !data\s*\|\| !isCurrentAuthenticatedSessionScope\(authenticationScope\)/
  );
});

test("standalone reproduction covers both attachment pre-submit navigation windows", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-attachment-upload-navigation-race.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  for (const stage of ["block-flush", "request-preflight"]) {
    assert.equal(result.vulnerable[stage].staleAttachmentCreateRequestSent, true);
    assert.equal(result.fixed[stage].staleAttachmentCreateRequestSent, false);
    assert.equal(result.fixed[stage].newerNavigationPreserved, true);
  }
});
