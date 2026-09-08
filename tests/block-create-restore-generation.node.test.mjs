import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const normalize = (value) => value.replace(/\r\n/g, "\n");

function section(text, start, end) {
  const startIndex = text.indexOf(start);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  const endIndex = text.indexOf(end, startIndex + start.length);
  assert.ok(endIndex > startIndex, `missing section end after: ${start}`);
  return text.slice(startIndex, endIndex);
}

test("ordinary block creation fences workspace restore and access-grant generations", () => {
  const route = normalize(
    readFileSync(new URL("../src/routes/block.routes.ts", import.meta.url), "utf8")
  );
  const create = section(
    route,
    'blockRouter.post("/pages/:pageId/blocks"',
    'blockRouter.patch("/blocks/:blockId"'
  );

  assert.match(create, /const admission = await capturePageMutationAdmission\(pageId, user\.id\)/);
  assert.match(create, /const ownerId = admission\.ownerId/);

  const userLock = create.indexOf("await lockBlockCreateUsers(client, [user.id, ownerId])");
  const authBoundary = create.indexOf("await assertCurrentAuthSessionBoundary(user.id, authScope, client)");
  const generationLock = create.indexOf("lockUserAttachmentGeneration(client, ownerId)");
  const generationFence = create.indexOf(
    "assertPageOwnerWorkspaceGeneration(admission.ownerWorkspaceGeneration, currentWorkspaceGeneration)"
  );
  const pageLock = create.indexOf(
    "getPageAccess(pageId, user.id, client, { lockPage: true, lockAccess: true })"
  );
  const shareFence = create.indexOf(
    "lockedAccess.shareGeneration !== admission.actorShareGeneration"
  );
  const blockInsert = create.indexOf("INSERT INTO blocks");

  assert.ok(
    userLock >= 0
      && authBoundary > userLock
      && generationLock > authBoundary
      && generationFence > generationLock
      && pageLock > generationFence
      && shareFence > pageLock
      && blockInsert > shareFence,
    "restore/share generation fences must execute before ordinary block insertion"
  );
});

test("race reproduction rejects a pre-restore block create after generation advances", () => {
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-block-create-restore-generation-race.mjs", import.meta.url))],
    { encoding: "utf8" }
  );
  const result = JSON.parse(output);

  assert.equal(result.scenario.basePageContentVersionRequired, false);
  assert.equal(result.vulnerable.ownerCheckPasses, true);
  assert.equal(result.vulnerable.outcome, "stale-block-committed");
  assert.equal(result.fixed.generationMatches, false);
  assert.equal(result.fixed.outcome, "rejected-workspace-restored");
  assert.deepEqual(result.sameGenerationControl, {
    generationMatches: true,
    outcome: "block-create-admitted"
  });
});
