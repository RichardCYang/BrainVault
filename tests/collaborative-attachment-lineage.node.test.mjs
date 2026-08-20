import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const blockRoute = readFileSync(new URL("../src/routes/block.routes.ts", import.meta.url), "utf8");
const collaborationServer = readFileSync(new URL("../src/lib/collaboration-server.ts", import.meta.url), "utf8");

function between(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
}

test("canonical attachment upload remains the narrow REST exception for collaborative pages", () => {
  const authorization = between(
    blockRoute,
    "async function authorizeAttachmentUploadTarget",
    "function requireAttachmentUploadTarget"
  );
  assert.doesNotMatch(authorization, /assertDirectBlockMutationAllowed\s*\(/);

  const attachmentRoute = between(
    blockRoute,
    'blockRouter.post(\r\n  "/pages/:pageId/attachments"',
    'blockRouter.get("/blocks/:blockId/attachment"'
  );
  assert.doesNotMatch(attachmentRoute, /assertDirectBlockMutationAllowed\s*\(/);
  assert.match(attachmentRoute, /lockedAccess\.shareCount > 0/);
  assert.match(
    attachmentRoute,
    /ensureCollaborationState\(pageId, client\)\)\.document_epoch/
  );
  assert.match(
    attachmentRoute,
    /broadcastCanonicalAttachment\(pageId, collaborationDocumentEpochAtWrite, payload\)/
  );

  const allDirectMutationGuards = blockRoute.match(/assertDirectBlockMutationAllowed\s*\(/g) ?? [];
  assert.ok(
    allDirectMutationGuards.length >= 4,
    "ordinary direct block mutation routes must retain collaboration guards"
  );
});

test("canonical attachment broadcast is fenced to the document generation that committed it", () => {
  const notify = between(
    collaborationServer,
    "async notifyCanonicalAttachment",
    "private reserveUpgrade"
  );
  assert.match(notify, /room\.documentEpoch !== documentEpoch/);
  assert.match(notify, /client\.documentEpoch !== documentEpoch/);
  assert.match(notify, /this\.rooms\.get\(pageId\) !== room/g);

  const broadcast = between(
    collaborationServer,
    "export async function broadcastCanonicalAttachment",
    "\r\n}"
  );
  assert.match(broadcast, /documentEpoch: string/);
  assert.match(
    broadcast,
    /hub\.notifyCanonicalAttachment\(pageId, documentEpoch, block\)/
  );
});
