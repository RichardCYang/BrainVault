import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const appUrl = new URL("../public/app.js", import.meta.url);
const collaborationUrl = new URL("../public/collaboration.js", import.meta.url);

function section(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start);
  assert.ok(start >= 0 && end > start, `missing source section: ${startNeedle}`);
  return source.slice(start, end);
}

test("page delete rechecks navigation after snapshot, transition, and request preflight waits", async () => {
  const source = (await readFile(appUrl, "utf8")).replace(/\r\n/g, "\n");
  const deletion = section(source, "async function deleteNavigationTarget", "\nfunction renderCollectionView");
  const snapshotIndex = deletion.indexOf("const deletionSnapshot = await api(");
  const taskIndex = deletion.indexOf("task = getPageDeleteTask", snapshotIndex);
  assert.ok(snapshotIndex >= 0 && taskIndex > snapshotIndex);
  assert.match(
    deletion.slice(snapshotIndex, taskIndex),
    /!isCurrentWorkspaceNavigation\(navigationGeneration\)/
  );

  const transitionIndex = deletion.indexOf('withWorkspacePersistenceTransition("page-delete"');
  const submitIndex = deletion.indexOf("submitPageDeleteTask(", transitionIndex);
  assert.ok(transitionIndex >= 0 && submitIndex > transitionIndex);
  assert.match(
    deletion.slice(transitionIndex, submitIndex),
    /!isCurrentWorkspaceNavigation\(navigationGeneration\)/
  );
  assert.match(
    deletion.slice(submitIndex, deletion.indexOf("\n    });", submitIndex) + 8),
    /requestGuard:\s*\(\) => isCurrentWorkspaceNavigation\(navigationGeneration\)/
  );

  const submit = section(source, "async function submitPageDeleteTask", "\nasync function deleteNavigationTarget");
  assert.match(submit, /beforeFetch:\s*\(\) => \{/);
  assert.match(submit, /requestGuard\?\.\(\) === false/);
  assert.match(submit, /task\.attempted = true;/);
});

test("block delete carries the initiating navigation through transition and request preflight waits", async () => {
  const source = (await readFile(appUrl, "utf8")).replace(/\r\n/g, "\n");
  const deletion = section(source, "async function deleteBlockWithVersionCheck", "\nfunction updateBlockInState");
  assert.match(deletion, /const navigationGeneration = options\.navigationGeneration \?\? null;/);
  assert.match(deletion, /const isDeleteNavigationCurrent = \(\) =>/);

  const transitionIndex = deletion.indexOf('withPagePersistenceTransition(pageId, "block-delete"');
  const submitIndex = deletion.indexOf("submitBlockDeleteTask(", transitionIndex);
  assert.ok(transitionIndex >= 0 && submitIndex > transitionIndex);
  assert.match(deletion.slice(transitionIndex, submitIndex), /!isDeleteNavigationCurrent\(\)/);
  assert.match(deletion.slice(submitIndex, submitIndex + 180), /requestGuard:\s*isDeleteNavigationCurrent/);

  const emptyDelete = section(source, "async function deleteEmptyBlock", "\nfunction focusPendingBlock");
  assert.match(
    emptyDelete,
    /deleteBlockWithVersionCheck\(blockId, \{[\s\S]*navigationGeneration[\s\S]*\}\);/
  );

  const menuStart = source.indexOf('if (button.dataset.action === "delete-block")');
  const menuEnd = source.indexOf("\n    }\n  } catch", menuStart);
  assert.ok(menuStart >= 0 && menuEnd > menuStart);
  assert.match(
    source.slice(menuStart, menuEnd),
    /deleteBlockWithVersionCheck\(blockId, \{ authenticationScope, navigationGeneration \}\)/
  );

  const submit = section(source, "async function submitBlockDeleteTask", "\nfunction getBlockMoveTask");
  assert.match(submit, /beforeFetch:\s*\(\) => \{/);
  assert.match(submit, /requestGuard\?\.\(\) === false/);
  assert.match(submit, /task\.attempted = true;/);
});

test("collaborative delete rechecks intent after its queued local-mutation wait", async () => {
  const source = (await readFile(appUrl, "utf8")).replace(/\r\n/g, "\n");
  const deletion = section(source, "async function deleteBlockWithVersionCheck", "\nfunction updateBlockInState");
  assert.match(deletion, /beforeCommit: isDeleteIntentCurrent/);

  const collaboration = (await readFile(collaborationUrl, "utf8")).replace(/\r\n/g, "\n");
  const commit = section(collaboration, "  commitLocalMutation(", "\n  clearLocalRecovery(");
  const queueIndex = commit.indexOf("this.localMutationQueue.then");
  const gateIndex = commit.indexOf("if (beforeCommit?.() === false) return false;");
  const prepareIndex = commit.indexOf("const prepared = this.prepareLocalMutationDoc();");
  assert.ok(queueIndex >= 0 && gateIndex > queueIndex && prepareIndex > gateIndex);

  const deleteBlock = section(
    collaboration,
    "  async deleteBlock(blockId",
    "\n  async replaceBlockWithAttachmentPreservingChildren"
  );
  assert.match(deleteBlock, /beforeCommit = null/);
  assert.match(deleteBlock, /\{ allowDisconnected, beforeCommit \}/);
});

test("api evaluates a destructive request gate synchronously at the transport dispatch boundary", async () => {
  const source = (await readFile(appUrl, "utf8")).replace(/\r\n/g, "\n");
  const api = section(source, "async function api(path, options = {})", "\nasync function fetchDatabaseUrlPreview");
  const preflightIndex = api.indexOf("await applyClientNetworkVerificationHeaders(headers);");
  const guardIndex = api.indexOf("const assertRequestDispatchCurrent = () =>", preflightIndex);
  const transportIndex = api.indexOf("await fetchApiResponseText(", guardIndex);
  const dispatchFenceIndex = api.indexOf(
    "beforeDispatch: assertRequestDispatchCurrent",
    transportIndex
  );
  assert.ok(
    preflightIndex >= 0
      && guardIndex > preflightIndex
      && transportIndex > guardIndex
      && dispatchFenceIndex > transportIndex
  );
  assert.match(
    api.slice(guardIndex, transportIndex),
    /assertAuthenticationScopeCurrent\(\);[\s\S]*beforeFetch\?\.\(\) === false/
  );
});

test("standalone page-delete reproduction covers every late pre-submit navigation window", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-page-delete-late-navigation-race.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  for (const stage of ["snapshot", "transition", "request-preflight"]) {
    assert.equal(result.vulnerable[stage].staleDeleteRequestSent, true);
    assert.equal(result.fixed[stage].staleDeleteRequestSent, false);
    assert.equal(result.fixed[stage].newerNavigationPreserved, true);
  }
});

test("standalone block-delete reproduction covers transition and request-preflight navigation windows", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-block-delete-late-navigation-race.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  for (const stage of ["transition", "request-preflight"]) {
    assert.equal(result.vulnerable[stage].staleDeleteRequestSent, true);
    assert.equal(result.fixed[stage].staleDeleteRequestSent, false);
    assert.equal(result.fixed[stage].newerNavigationPreserved, true);
  }
});

test("attachment replacement keeps destructive follow-up bound to the upload navigation and auth scope", async () => {
  const source = (await readFile(appUrl, "utf8")).replace(/\r\n/g, "\n");
  const upload = section(source, "async function uploadAttachmentFromRow", "\nfunction requestAttachmentUpload");

  assert.match(upload, /const navigationGeneration = workspaceNavigationGeneration;/);

  const uploadCommitIndex = upload.indexOf("applyAuthoritativePageContentVersion(pageId, data);");
  const firstNavigationFenceIndex = upload.indexOf(
    "!isCurrentWorkspaceNavigation(navigationGeneration)",
    uploadCommitIndex
  );
  const canonicalReconcileIndex = upload.indexOf(
    "shouldReconcileCanonicalCreatedBlockOrder(data)",
    uploadCommitIndex
  );
  assert.ok(
    uploadCommitIndex >= 0
      && firstNavigationFenceIndex > uploadCommitIndex
      && canonicalReconcileIndex > firstNavigationFenceIndex
  );

  assert.match(
    upload,
    /deleteBlockWithVersionCheck\(blockId, \{[\s\S]*?preserveChildren: true,[\s\S]*?authenticationScope,[\s\S]*?navigationGeneration,[\s\S]*?replacementBlock:/
  );
  assert.match(
    upload,
    /deleteBlockWithVersionCheck\(blockId, \{\s*includeDescendants: false,\s*authenticationScope,\s*navigationGeneration\s*\}\);/
  );

  const discardIndex = upload.indexOf("await discardBlockSave(blockId);");
  const directDeleteIndex = upload.indexOf("await deleteBlockWithVersionCheck(blockId", discardIndex);
  assert.ok(discardIndex >= 0 && directDeleteIndex > discardIndex);
  assert.match(
    upload.slice(discardIndex, directDeleteIndex),
    /!isCurrentWorkspaceNavigation\(navigationGeneration\)/
  );

  assert.match(
    upload,
    /if \(isCurrentWorkspaceNavigation\(navigationGeneration\) && state\.selectedPage\?\.id === pageId\) \{\s*await reconcileCanonicalCreatedBlock/
  );
});

test("standalone attachment replacement reproduction covers late navigation and auth rotation", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-attachment-replacement-delete-race.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.equal(result.vulnerable.navigation.staleSourceDeleteSent, true);
  assert.equal(result.fixed.navigation.staleSourceDeleteSent, false);
  assert.equal(result.fixed.navigation.newerNavigationPreserved, true);

  assert.equal(result.vulnerable.authentication.staleSourceDeleteSent, true);
  assert.equal(result.fixed.authentication.staleSourceDeleteSent, false);
  assert.notEqual(
    result.fixed.authentication.deletionAuthenticationGeneration,
    result.fixed.authentication.authenticationGeneration
  );
});
