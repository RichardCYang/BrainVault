import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.ok(endIndex > startIndex, `missing source marker after ${start}: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("a collaborative destructive snapshot cannot silently fall through to direct deletion", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const deletion = section(
    app,
    "async function deleteBlockWithVersionCheck",
    "\nfunction updateBlockInState"
  );

  const collaborativeBranch = deletion.indexOf("if (isCollaborativePage())");
  const crossModeFence = deletion.indexOf(
    "if (replacementBlock || expectedSourceBlock || expectedPromoteStructure)"
  );
  const directSnapshot = deletion.indexOf("const expectedVersions = getBlockVersionSnapshot");

  assert.ok(collaborativeBranch >= 0);
  assert.ok(crossModeFence > collaborativeBranch, "the cross-mode fence must run after the collaborative branch");
  assert.ok(directSnapshot > crossModeFence, "the cross-mode fence must run before any direct deletion snapshot");
  assert.match(crossModeFence >= 0 ? deletion.slice(crossModeFence, directSnapshot) : "", /sharing\.syncRequired/);
});

test("an attachment replacement that began collaborative preserves the source after a direct-mode transition", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const upload = section(app, "async function uploadAttachmentFromRow", "\nfunction requestAttachmentUpload");

  const fence = upload.indexOf("if (collaborativeAtStart && !isCollaborativePage())");
  const currentRevision = upload.indexOf("const currentEditRevision", fence);
  const directDelete = upload.indexOf("await deleteBlockWithVersionCheck(blockId", currentRevision);

  assert.ok(fence >= 0, "missing collaboration->direct attachment replacement fence");
  assert.ok(currentRevision > fence, "the mode-transition fence must run before replacement decisions");
  assert.match(
    upload.slice(fence, currentRevision),
    /reconcileCanonicalCreatedBlock\(pageId, data\.block, \{ authenticationScope \}\)/
  );
  assert.ok(
    directDelete === -1 || fence < directDelete,
    "the mode-transition fence must run before the direct source-delete branch"
  );
});

test("standalone reproduction demonstrates the former loss and the fixed preservation behavior", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-collaboration-mode-transition-delete-race.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.equal(result.vulnerableDelete.deleted, true);
  assert.equal(result.fixedDelete.deleted, false);
  assert.equal(result.vulnerableAttachmentReplacement.sourceDeleted, true);
  assert.equal(result.fixedAttachmentReplacement.sourceDeleted, false);
  assert.equal(result.fixedAttachmentReplacement.attachmentPreserved, true);
  assert.equal(result.fixedAttachmentReplacement.canonicalRefresh, true);
  assert.equal(result.peerEditedMarkdown, "important collaborator edit");
});
