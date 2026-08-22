import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test("workspace restore invalidates pending mutation tasks from the replaced generation", async () => {
  const app = (await readFile(new URL("../public/app.js", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");

  const restoreApply = section(
    app,
    "async function applyRestoredWorkspaceData",
    "async function restoreWorkspaceSnapshotClient"
  );

  assert.match(app, /function clearWorkspaceScopedPendingMutationTasks\(\)/);
  for (const mapName of [
    "pendingWorkspaceCreateTasks",
    "pendingPageVersionResetTasks",
    "pendingBlockCreateTasks",
    "pendingBlockDeleteTasks",
    "pendingBlockMoveTasks",
    "pendingPageDeleteTasks",
    "pendingAttachmentCreateTasks"
  ]) {
    assert.match(
      app,
      new RegExp(`${mapName}\\.clear\\(\\);`),
      `${mapName} must be invalidated when a workspace generation is replaced`
    );
  }

  const clearIndex = restoreApply.indexOf("clearWorkspaceScopedPendingMutationTasks();");
  const installUserIndex = restoreApply.indexOf("state.user = data.user;");
  assert.ok(
    clearIndex >= 0 && installUserIndex > clearIndex,
    "old-generation retry state must be dropped before the restored workspace becomes current"
  );
});

test("pending mutation task identity includes workspace generation", async () => {
  const app = (await readFile(new URL("../public/app.js", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");

  const versionReset = section(
    app,
    "function getPageVersionResetTaskKey",
    "function renderPageVersionHistoryList"
  );
  assert.match(versionReset, /scope\.workspaceGeneration/);

  const pageDelete = section(
    app,
    "function findPendingPageDeleteTask",
    "async function submitPageDeleteTask"
  );
  assert.match(pageDelete, /task\.workspaceGeneration === authenticationScope\.workspaceGeneration/);
  assert.match(pageDelete, /authenticationScope\.workspaceGeneration/);

  const blockDelete = section(
    app,
    "function getBlockDeleteTask",
    "async function submitBlockDeleteTask"
  );
  assert.match(blockDelete, /authenticationScope\.workspaceGeneration/);

  const blockMove = section(
    app,
    "function getBlockMoveTask",
    "async function submitBlockMoveTask"
  );
  assert.match(blockMove, /authenticationScope\.workspaceGeneration/);

  const attachmentCreate = section(
    app,
    "function getAttachmentCreateTask",
    "async function submitAttachmentCreateTask"
  );
  assert.match(attachmentCreate, /authenticationScope\.workspaceGeneration/);

  const blockCreate = section(
    app,
    "function getBlockCreateTask",
    "async function submitBlockCreateTask"
  );
  assert.match(blockCreate, /authenticationScope\.workspaceGeneration/);

  const workspaceCreate = section(
    app,
    "function getWorkspaceCreateTask",
    "async function submitWorkspacePageCreate"
  );
  assert.match(workspaceCreate, /authenticationScope\.workspaceGeneration/);
});

test("workspace generation separates otherwise identical retry identities", () => {
  const key = (scope, pageId) =>
    `${scope.generation}\0${scope.targetKey}\0${scope.workspaceGeneration}\0${pageId}`;

  const beforeRestore = {
    generation: 9,
    targetKey: "account:user-1",
    workspaceGeneration: 17
  };
  const afterRestore = {
    ...beforeRestore,
    workspaceGeneration: 18
  };

  assert.notEqual(
    key(beforeRestore, "pag_same_id"),
    key(afterRestore, "pag_same_id"),
    "a restored page id must not adopt a retry task from the pre-restore generation"
  );
});
