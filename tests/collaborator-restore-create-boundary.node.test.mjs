import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("attachment admission captures authorization and the page owner's workspace generation in one read", () => {
  const source = readFileSync(new URL("../src/routes/block.routes.ts", import.meta.url), "utf8")
    .replace(/\r\n/g, "\n");
  const admission = section(
    source,
    "async function capturePageMutationAdmission",
    "function assertPageOwnerWorkspaceGeneration"
  );

  assert.match(admission, /SELECT p\.owner_id, u\.attachment_generation, p\.is_archived/);
  assert.match(admission, /INNER JOIN users u ON u\.id = p\.owner_id/);
  assert.match(admission, /p\.owner_id = \?/);
  assert.match(admission, /ps\.user_id = \?[\s\S]*ps\.permission = 'EDIT'/);
  assert.match(admission, /ownerWorkspaceGeneration/);
});

test("attachment creation rejects an upload that crossed the page owner's restore generation", () => {
  const source = readFileSync(new URL("../src/routes/block.routes.ts", import.meta.url), "utf8")
    .replace(/\r\n/g, "\n");
  const authorization = section(
    source,
    "type AttachmentUploadTarget",
    "function requireAttachmentUploadTarget"
  );
  assert.match(authorization, /ownerWorkspaceGeneration: admission\.ownerWorkspaceGeneration/);

  const route = section(
    source,
    '"/pages/:pageId/attachments"',
    'blockRouter.get("/blocks/:blockId/attachment"'
  );

  const generationReadIndex = route.indexOf("lockUserAttachmentGeneration(client, ownerId)");
  const generationFenceIndex = route.indexOf(
    "assertPageOwnerWorkspaceGeneration(target.ownerWorkspaceGeneration, attachmentGeneration)"
  );
  const pageLockIndex = route.indexOf("getPageAccess(pageId, user.id, client, { lockPage: true })");
  const fileMoveIndex = route.indexOf("moveAttachmentFile(file.path, ownerId, id)");
  const insertIndex = route.indexOf("INSERT INTO blocks");

  assert.ok(
    generationReadIndex >= 0
      && generationFenceIndex > generationReadIndex
      && pageLockIndex > generationFenceIndex
      && fileMoveIndex > pageLockIndex
      && insertIndex > pageLockIndex,
    "the owner generation must be rechecked under the owner-user lock before page locking, file movement, or block insertion"
  );
});

test("race model proves a stale collaborator attachment could cross restore before the owner-generation fence", () => {
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-collaborator-restore-create-race.mjs", import.meta.url))],
    { encoding: "utf8" }
  );
  const result = JSON.parse(output);

  assert.deepEqual(result.staleCollaboratorAttachmentCreate, {
    vulnerable: { outcome: "committed", createdBlocks: 1, movedFiles: 1 },
    fixed: { outcome: "rejected-owner-generation", createdBlocks: 0, movedFiles: 0 }
  });
  assert.deepEqual(
    result.sameGenerationAttachmentCreate,
    { outcome: "committed", createdBlocks: 1, movedFiles: 1 }
  );
});
