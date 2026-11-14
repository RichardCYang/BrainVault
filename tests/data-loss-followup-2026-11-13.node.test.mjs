// Regression guards for the 2026-11-13 data-loss review: undoing an insert,
// database property type changes, unsent comments across an ended session,
// automatic pre-restore snapshots, blank-item deletion, and read-mode to-dos.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { planDatabasePropertyTypeChange } from "../public/database-block.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8").then((text) => text.replace(/\r\n/g, "\n"));
const [app, gantt, timetable, database, snapshots, dataTransfer, dataRoutes, snapshotRoutes, migration, i18n] = await Promise.all([
  read("public/app.js"),
  read("public/gantt-block.js"),
  read("public/timetable-block.js"),
  read("public/database-block.js"),
  read("src/lib/workspace-snapshots.ts"),
  read("src/lib/data-transfer.ts"),
  read("src/routes/data.routes.ts"),
  read("src/routes/snapshot.routes.ts"),
  read("migrations/086_workspace_snapshot_kind.sql"),
  read("public/i18n.js")
]);

function functionSource(source, name, nextName) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.notEqual(start, -1, `${name} must exist`);
  const end = source.indexOf(`function ${nextName}(`, start + 1);
  assert.notEqual(end, -1, `${nextName} must follow ${name}`);
  return source.slice(start, end);
}

function databaseWith(type, values, options = []) {
  return {
    properties: [{ id: "p", name: "Prop", type, options }],
    rows: values.map((value, index) => ({ id: `r${index}`, values: { p: value } })),
    views: []
  };
}

test("undoing a menu insert only removes a block that is still empty", () => {
  const remove = functionSource(app, "removeBlockForEditorHistory", "restoreBlockForEditorHistory");
  assert.match(remove, /const expected = meta\.snapshot \?\? \{/);
  assert.match(remove, /markdown: ""/);
  assert.match(remove, /snapshot\.markdown !== expected\.markdown/);
  assert.match(remove, /jsonValuesMatch\(snapshot\.metadata \?\? null, expected\.metadata \?\? null\)/);
  assert.ok(remove.indexOf('return { status: "stale" }', remove.indexOf("expected.markdown")) < remove.indexOf("deleteEmptyBlock("));
  assert.match(app, /op: "create",\s*blockId: inserted\.block\.id,\s*snapshot: null,\s*insertedType:[^,]+,\s*insertedMetadata:/);
});

test("select to multi-select keeps every chosen option", () => {
  const options = [{ id: "a", name: "Alpha", color: "gray" }];
  const plan = planDatabasePropertyTypeChange(databaseWith("select", ["a", ""], options), databaseWith("select", [], options).properties[0], "multi_select");
  assert.deepEqual(plan.values, [["a"], []]);
  assert.equal(plan.lostCount, 0);
  assert.deepEqual(plan.nextProperty.options.map((option) => option.id), ["a"]);
});

test("multi-select to select keeps the first option", () => {
  const options = [{ id: "a", name: "Alpha", color: "gray" }, { id: "b", name: "Beta", color: "gray" }];
  const data = databaseWith("multi_select", [["b", "a"]], options);
  const plan = planDatabasePropertyTypeChange(data, data.properties[0], "select");
  assert.deepEqual(plan.values, ["b"]);
  assert.equal(plan.lostCount, 0);
});

test("choices become their names, not internal ids, in text", () => {
  const options = [{ id: "a", name: "Alpha", color: "gray" }, { id: "b", name: "Beta", color: "gray" }];
  const data = databaseWith("multi_select", [["a", "b"]], options);
  const plan = planDatabasePropertyTypeChange(data, data.properties[0], "text");
  assert.deepEqual(plan.values, ["Alpha, Beta"]);
  assert.equal(plan.lostCount, 0);
});

test("numbers survive a change to text", () => {
  const data = databaseWith("number", [12.5, 0, null]);
  const plan = planDatabasePropertyTypeChange(data, data.properties[0], "text");
  assert.deepEqual(plan.values, ["12.5", "0", ""]);
  assert.equal(plan.lostCount, 0);
});

test("values a new type cannot hold are counted so the change asks first", () => {
  const text = databaseWith("text", ["12", "twelve", "", "  "]);
  const toNumber = planDatabasePropertyTypeChange(text, text.properties[0], "number");
  assert.deepEqual(toNumber.values, [12, null, null, null]);
  assert.equal(toNumber.lostCount, 1);
  const toCheckbox = planDatabasePropertyTypeChange(text, text.properties[0], "checkbox");
  assert.equal(toCheckbox.lostCount, 2);
  const toSelect = planDatabasePropertyTypeChange(text, text.properties[0], "select");
  assert.equal(toSelect.lostCount, 2);
});

test("planning a type change never touches the database", () => {
  const data = databaseWith("text", ["keep me"]);
  planDatabasePropertyTypeChange(data, data.properties[0], "number");
  assert.equal(data.properties[0].type, "text");
  assert.equal(data.rows[0].values.p, "keep me");
});

test("the type control confirms before clearing values and re-plans after the dialog", () => {
  const handler = database.slice(database.indexOf('type.addEventListener("change"'), database.indexOf("item.append(name, type);"));
  assert.match(handler, /if \(plan\.lostCount === 0\) \{\s*apply\(\);\s*return;\s*\}/);
  assert.match(handler, /showConfirmDialog\(\{\s*message: t\("database\.confirmPropertyTypeChange"/);
  assert.match(handler, /const current = planDatabasePropertyTypeChange\(database, property, type\.value\)/);
  assert.match(handler, /type\.value = property\.type/);
});

test("a database row with a chosen option or ticked box asks before deletion", () => {
  const remove = database.slice(database.indexOf('action === "database-delete-row"'), database.indexOf('action === "database-remove-filter"'));
  assert.match(remove, /prefilledPropertyIds = new Set\(\s*database\.views\.map\(\(view\) => view\.groupPropertyId\)/);
  assert.match(remove, /return !hasDatabaseCellContent\(dataRow\.values\?\.\[property\.id\]\)/);
  assert.doesNotMatch(remove, /if \(property\.type === "select" \|\| property\.type === "checkbox"\) return true;/);
});

test("a scheduled Gantt task or moved time slot asks before deletion", () => {
  assert.match(gantt, /untouchedNewGanttTaskDates\.set\(task\.id, \{ start: task\.start, end: task\.end \}\)/);
  assert.match(gantt, /addedDates\?\.start === task\.start\s*&& addedDates\?\.end === task\.end/);
  assert.match(timetable, /untouchedNewTimetableEntrySlots\.set\(entry\.id, timetableEntrySlotKey\(entry\)\)/);
  assert.match(timetable, /untouchedNewTimetableEntrySlots\.get\(entry\.id\) === timetableEntrySlotKey\(entry\)/);
});

test("an ended session keeps unsent comments for the same account only", () => {
  const reset = functionSource(app, "resetAuthenticationSessionState", "setAccountMessage");
  assert.match(reset, /clearCommentDrafts = false/);
  assert.match(reset, /if \(clearCommentDrafts\) clearPageCommentDrafts\(\);\s*else retainPageCommentDraftsAcrossSignIn\(\);/);
  assert.match(functionSource(app, "logout", "sortByRecent"), /resetAuthenticationSessionState\(\{ clearCommentDrafts: true \}\)/);
  assert.match(functionSource(app, "completeAuthenticatedLogin", "logout"), /adoptPageCommentDraftsForUser\(data\.user\?\.id \?\? null\)/);
  const stash = functionSource(app, "stashPageCommentDraft", "clearPageCommentDrafts");
  assert.match(stash, /if \(pageCommentDraftOwnerId !== state\.user\.id\) \{\s*pageCommentDrafts\.clear\(\);/);
  const adopt = functionSource(app, "adoptPageCommentDraftsForUser", "clearPageCommentEditor");
  assert.match(adopt, /pageCommentDraftOwnerId && pageCommentDraftOwnerId !== userId/);
  assert.match(functionSource(app, "hasUnsentPageCommentDraft", "stashPageCommentDraft"), /if \(!state\.user\) return pageCommentDrafts\.size > 0;/);
});

test("a restore saves the current workspace first and stops if it cannot", () => {
  assert.match(migration, /ADD COLUMN kind ENUM\('MANUAL', 'PRE_RESTORE'\) NOT NULL DEFAULT 'MANUAL'/);
  assert.match(snapshots, /WHERE user_id = \? AND kind = 'MANUAL'/);
  assert.match(snapshots, /createWorkspaceSnapshot\(userId, authScope, "PRE_RESTORE"\)/);
  assert.match(snapshots, /"RESTORE_SAFETY_SNAPSHOT_FAILED"/);
  // The hook runs after validation and the completed-retry replay, before the destructive transaction.
  const hook = dataTransfer.indexOf("await options.beforeReplace?.();");
  assert.ok(hook > dataTransfer.indexOf("if (completed) return completed;"));
  assert.ok(hook > dataTransfer.indexOf("await writeRestoreGenerationMarker(stagedAttachmentDir, operationId);"));
  assert.ok(hook < dataTransfer.indexOf("let movedOldAttachments = false;"));
  assert.match(dataRoutes, /beforeReplace: safetySnapshot/);
  assert.match(snapshotRoutes, /safetySnapshot: !wantsRestoreWithoutSafetySnapshot/);
  // Old automatic snapshots go only after success, never the restored source.
  // A committed restore advances the workspace generation; pruning must use the new one
  // (found by an end-to-end run against MariaDB, where the old scope was rejected).
  assert.match(snapshots, /pruneAutomaticSnapshots\(userId, authScopeAfterRestore\(authScope, result\.user\), \[safetySnapshotId, row\.id\]\)/);
  assert.match(dataRoutes, /pruneAutomaticSnapshots\(user\.id, authScopeAfterRestore\(authScope, result\.user\), \[safetySnapshotId\]\)/);
  const submit = functionSource(app, "submitWorkspaceRestore", "submitWorkspaceRestoreAttempt");
  assert.match(submit, /RESTORE_SAFETY_SNAPSHOT_FAILED/);
  assert.match(submit, /skipSafetySnapshot: true/);
});

test("read-mode to-do ticks that failed can be saved again without editing", () => {
  assert.match(app, /async function retryReadModeTodoSaves\(\)/);
  assert.match(app, /if \(isPageReadOnly\(\) && hasPendingReadModeTodoSaves\(\)\) \{\s*await saveReadModeTodosNow\(\);/);
  assert.match(app, /if \(hasPendingReadModeTodoSaves\(\)\) \{\s*void saveReadModeTodosNow\(\);/);
});

test("every new string exists in every locale", () => {
  for (const key of [
    "confirmPropertyTypeChange",
    "changePropertyType",
    "restoreWithoutSafetySnapshotConfirm",
    "restoreWithoutSafetySnapshot",
    "safetySnapshotSaved",
    "snapshotKindPreRestore",
    "RESTORE_SAFETY_SNAPSHOT_FAILED"
  ]) {
    const nested = (i18n.match(new RegExp(`^\\s+${key}: `, "gm")) ?? []).length;
    const flat = (i18n.match(new RegExp(`"(?:database|account|errors)\\.${key}": `, "g")) ?? []).length;
    assert.equal(nested + flat, 7, key);
  }
});

// ---------------------------------------------------------------------------
// Found by driving headless Edge against MariaDB (2026-11-13). Each of these
// passed every source/unit test before and failed in a real browser.
// ---------------------------------------------------------------------------
const collaborationModule = await import("../public/collaboration.js");
const [collaborationSource, recoveryStorageSource] = await Promise.all([
  read("public/collaboration.js"),
  read("public/indexeddb-recovery-storage.js")
]);

test("a peer's update re-render does not save the stale focused field back", () => {
  const handlerStart = app.indexOf('elements.blockList.addEventListener("focusout", (event) => {\n  // Applying a peer');
  assert.notEqual(handlerStart, -1);
  const body = app.slice(handlerStart, app.indexOf("\n});", handlerStart));
  assert.ok(body.indexOf("if (state.applyingCollaborationSnapshot) return;") < body.indexOf("saveBlockRow("));
});

test("a local edit is re-applied on top of text a peer added meanwhile", () => {
  const { rebaseTextEdit, transformTextCaret } = collaborationModule;
  const cases = [
    ["first line", "Xfirst line", "first line1", "Xfirst line1"],
    ["first line", "first line1", "Xfirst line", "Xfirst line1"],
    ["abc", "abXc", "abc", "abXc"],
    ["hello world", "hello brave world", "hello world!", "hello brave world!"],
    ["hello world", "hello", "hi world", "hi"],
    ["one two", "one 2", "one two three", "one 2 three"],
    ["", "B", "A", "AB"]
  ];
  for (const [base, live, next, expected] of cases) assert.equal(rebaseTextEdit(base, live, next), expected, JSON.stringify({ base, live, next }));
  assert.equal(transformTextCaret("abc", "Xabc", 3), 4);
  assert.equal(transformTextCaret("abc", "abcX", 3), 3);
  assert.equal(transformTextCaret("hello", "he", 4), 2);
});

test("collaborative block edits carry the text they were made against", () => {
  assert.match(collaborationSource, /upsertBlock\(block, \{\s*allowDisconnected = false,\s*beforeCommit = null,\s*baseMarkdown = null,\s*baseMetadata = undefined\s*\} = \{\}\)/);
  assert.match(collaborationSource, /rebaseTextEdit\(baseMarkdown, liveText\.toString\(\), normalized\.markdown\)/);
  assert.equal((app.match(/baseMarkdown: takeCollaborationTextBase\(row, current, (historyPayload|payload)\)/g) ?? []).length, 2);
  // Structured blocks (tables, boards...) carry the metadata they were made against the same way.
  assert.match(collaborationSource, /mergeConcurrentValue\(baseMetadata, liveMetadata, normalized\.metadata\)/);
  assert.equal((app.match(/baseMetadata: takeCollaborationMetadataBase\(row, current, (historyPayload|payload)\)/g) ?? []).length, 2);
});

test("the caret is restored in the same task and moved past a peer's text", () => {
  const apply = functionSource(app, "applyCollaborationSnapshot", "applyCollaborationMaterialization");
  assert.match(apply, /captureCollaborationEditorFocus\(previousBlocks\)/);
  assert.match(apply, /\n  restoreCollaborationEditorFocus\(focus\);\n  requestAnimationFrame\(\(\) => renderCollaborationPresence\(\)\);/);
  const restore = functionSource(app, "restoreCollaborationEditorFocus", "updateInputValuePreservingSelection");
  assert.match(restore, /rebaseTextEdit\(focus\.textBase, control\.value, focus\.value\)/);
  assert.match(restore, /transformTextCaret\(focus\.value, control\.value, focus\.start\)/);
});

test("the save indicator re-checks when recovery writes drain", () => {
  assert.match(recoveryStorageSource, /onIdle\(listener\) \{/);
  assert.match(recoveryStorageSource, /pendingWrites -= 1;\n        notifyIdleIfSettled\(\);/);
  assert.match(app, /indexedDbRecoveryStorage\?\.onIdle\?\.\(\(\) => syncBeforeUnloadProtection\(\)\);/);
});

test("a to-do can actually be ticked while reading", () => {
  // The input event fired before change and rebuilt the read-only row.
  assert.match(app, /addEventListener\("input", \(event\) => \{\n(?:\s*\/\/.*\n)*\s*if \(event\.target\.closest\?\.\("\.read-mode-todo-toggle"\)\) return;/);
  // The read-only control walk disabled the checkbox right after it was enabled.
  assert.match(functionSource(app, "syncBlockReadOnlyState", "schedulePageViewHydration").replace(/\r\n/g, "\n"), /if \(control\.classList\.contains\("read-mode-todo-toggle"\)\) continue;/);
  // A load or mode-change lock never re-enabled it once lifted.
  assert.match(functionSource(app, "syncPageModeUi", "hasPendingPageEdits"), /syncReadModeTodoToggles\(\);/);
});
