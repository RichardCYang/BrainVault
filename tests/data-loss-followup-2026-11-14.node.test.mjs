// Regression guards for the 2026-11-14 data-loss review: over-long pastes,
// deleting a block that has nested blocks, automatic snapshot retention,
// restoring a deleted block from version history, history detail limits, and
// unsent comments across a reload.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { selectAutomaticSnapshotsToPrune } from "../src/lib/automatic-snapshot-retention.ts";
import {
  boundPageVersionChanges,
  pageVersionWriteMaxBytes
} from "../src/lib/page-version-history.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8").then((text) => text.replace(/\r\n/g, "\n"));
const [app, dialog, i18n, snapshots, env, styles] = await Promise.all([
  read("public/app.js"),
  read("public/app-dialog.js"),
  read("public/i18n.js"),
  read("src/lib/workspace-snapshots.ts"),
  read("src/config/env.ts"),
  read("public/styles.css")
]);

function functionSource(source, name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.notEqual(start, -1, `${name} must exist`);
  const next = source.slice(start + 1).search(/\n(?:async )?function |\n(?:const|let|document|window|elements)\b/);
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
}

// A valid TABLE block whose content is about rowCount x 4 KB.
function tableMetadata(rowCount, letter) {
  return {
    table: {
      rows: Array.from({ length: rowCount }, () => Array.from({ length: 4 }, () => letter.repeat(1_000))),
      headerRow: false,
      headerColumn: false
    }
  };
}

function deletedBlock(id, markdown, metadata = null, parentBlockId = null) {
  return {
    kind: "block-deleted",
    block: { id, parentBlockId, type: metadata ? "TABLE" : "MARKDOWN", markdown, checked: false, sortOrder: 0, metadata }
  };
}

test("a paste longer than the field allows is refused instead of silently cut", () => {
  const guard = app.slice(app.indexOf("function getPasteLengthGuardField("), app.indexOf("// Pasting an image or file adds it"));
  assert.match(guard, /document\.addEventListener\("paste", \(event\) => \{/);
  assert.match(guard, /\}, true\);/, "the guard must run in the capture phase, before field handlers");
  assert.match(guard, /if \(nextLength <= field\.maxLength\) return;\s*event\.preventDefault\(\);\s*event\.stopImmediatePropagation\(\);/);
  assert.match(guard, /t\("status\.pasteTooLong"/);
  const length = functionSource(app, "getLengthAfterPaste");
  assert.match(length, /text\.replace\(\/\\r\\n\?\/g, "\\n"\)/, "text areas count CRLF as one character");
  assert.match(length, /length - \(end - start\) \+ pasted\.length/, "the replaced selection is subtracted");
});

test("deleting a block with nested blocks names them and can keep them", () => {
  assert.match(dialog, /export function showChoiceDialog\(/);
  assert.match(dialog, /dialog\.close\("alternate"\)/);
  assert.match(dialog, /value === "confirm" \|\| value === "alternate" \? value : "cancel"/);
  assert.match(styles, /\.app-dialog-actions\.has-alternate \{\s*grid-template-columns: 1fr;/);

  const menu = app.slice(app.indexOf('if (button.dataset.action === "delete-block") {'));
  assert.match(menu, /const descendantCount = countBlockDescendants\(blockId\);/);
  assert.match(menu, /t\("confirm\.deleteBlockWithChildren", \{ count: formatNumber\(descendantCount\) \}\)/);
  assert.match(menu, /alternateLabel: t\("dialog\.deleteBlockKeepChildren"\)/);
  assert.ok(
    menu.indexOf('if (deleteChoice === "alternate")') < menu.indexOf("deleteBlockWithVersionCheck(blockId"),
    "keeping the children must not fall through to the subtree delete"
  );
  assert.match(menu, /await deleteEmptyBlock\(row, \{ announce: false \}\);/);
  assert.match(functionSource(app, "countBlockDescendants"), /pending\.push\(\.\.\.child\.children\)/);
});

test("recent automatic snapshots survive several restores in a row", () => {
  // Five restores within the retention window, newest first, count limit 3.
  const rows = ["s5", "s4", "s3", "s2", "s1"].map((id) => ({ id, recent: 1 }));
  assert.deepEqual(selectAutomaticSnapshotsToPrune(rows, ["s5"], { maxCount: 3 }), []);
  // The oldest one is the workspace as it was before the first attempt.
  assert.ok(!selectAutomaticSnapshotsToPrune(rows, ["s5"], { maxCount: 3 }).includes("s1"));
});

test("old automatic snapshots beyond the count are still pruned", () => {
  const rows = [
    { id: "new", recent: 1 },
    { id: "a", recent: 0 },
    { id: "b", recent: 0 },
    { id: "c", recent: 0 },
    { id: "d", recent: "0" }
  ];
  assert.deepEqual(selectAutomaticSnapshotsToPrune(rows, ["new"], { maxCount: 3 }), ["c", "d"]);
});

test("recent automatic snapshots are bounded by a hard ceiling", () => {
  const rows = Array.from({ length: 25 }, (_, index) => ({ id: `s${25 - index}`, recent: true }));
  const pruned = selectAutomaticSnapshotsToPrune(rows, ["s25"], { maxCount: 3, recentHardMaxCount: 20 });
  assert.equal(pruned.length, 5);
  assert.deepEqual(pruned, ["s5", "s4", "s3", "s2", "s1"]);
});

test("snapshot pruning reads snapshot age and a retention setting", () => {
  assert.match(env, /SNAPSHOT_AUTO_RETENTION_HOURS: z\.coerce\.number\(\)\.int\(\)\.min\(0\)\.max\(24 \* 366\)\.default\(7 \* 24\)/);
  assert.match(snapshots, /created_at >= CURRENT_TIMESTAMP\(3\) - INTERVAL \? HOUR\) AS recent/);
  assert.match(snapshots, /\[env\.SNAPSHOT_AUTO_RETENTION_HOURS, userId\]/);
  assert.match(snapshots, /selectAutomaticSnapshotsToPrune\(rows, keep,/);
});

test("a deleted structured block keeps up to 128 KiB of content in history", () => {
  const metadata = tableMetadata(15, "x");
  const [change] = boundPageVersionChanges([deletedBlock("b1", "", metadata)]);
  assert.equal(change.kind, "block-deleted");
  assert.deepEqual(change.block.metadata, metadata);
  assert.equal(change.block.metadataOmitted, undefined);
});

test("an oversized deletion keeps every deleted block's text instead of omitting all detail", () => {
  // 20 blocks of 15,000 Korean characters (about 45 KB each) exceed one row.
  const changes = Array.from({ length: 20 }, (_, index) => deletedBlock(`b${index}`, "가".repeat(15_000)));
  const bounded = boundPageVersionChanges(changes);
  const deleted = bounded.filter((change) => change.kind === "block-deleted");
  assert.ok(deleted.length >= 5, `kept ${deleted.length} deleted blocks`);
  assert.ok(deleted.every((change) => change.block.markdown.length === 15_000), "kept text is never truncated");
  assert.deepEqual(bounded.at(-1), { kind: "details-omitted", reason: "DETAIL_LIMIT" });
  assert.ok(Buffer.byteLength(JSON.stringify(bounded), "utf8") <= pageVersionWriteMaxBytes);
});

test("an oversized change keeps deleted blocks ahead of large field updates", () => {
  const update = {
    kind: "block-updated",
    blockId: "u1",
    blockType: "MARKDOWN",
    fields: [{ field: "markdown", before: "a".repeat(15_000), after: "b".repeat(15_000) }]
  };
  const changes = [
    ...Array.from({ length: 16 }, () => update),
    deletedBlock("keep", "important text"),
    deletedBlock("big", "c".repeat(20_000), tableMetadata(25, "d"))
  ];
  const bounded = boundPageVersionChanges(changes);
  const kept = bounded.find((change) => change.kind === "block-deleted" && change.block.id === "keep");
  assert.equal(kept?.block.markdown, "important text");
  assert.ok(bounded.some((change) => change.kind === "block-deleted" && change.block.id === "big"));
  assert.ok(Buffer.byteLength(JSON.stringify(bounded), "utf8") <= pageVersionWriteMaxBytes);
});

test("a change that fits keeps its full detail and no limit marker", () => {
  const changes = [deletedBlock("b1", "hello")];
  assert.deepEqual(boundPageVersionChanges(changes), changes);
});

test("version history can put a deleted block back", () => {
  const card = functionSource(app, "createPageVersionChangeCard");
  assert.match(card, /if \(!created && canRestoreBlockFromPageVersion\(change\.block\)\)/);
  assert.match(card, /restoreBlockFromPageVersion\(change\.block\)/);
  const canRestore = functionSource(app, "canRestoreBlockFromPageVersion");
  assert.match(canRestore, /block\.type !== "ATTACHMENT"/, "an attachment's file is gone with its block");
  assert.match(canRestore, /!block\.metadataOmitted/, "content left out of history cannot be restored faithfully");
  const restore = functionSource(app, "restoreBlockFromPageVersion");
  assert.match(restore, /if \(!requireWritablePage\(\)\) return false;/);
  assert.match(restore, /state\.selectedPage\?\.id !== pageId/);
});

test("unsent comments are stored in this tab and cleared on sign-out", () => {
  assert.match(app, /const pageCommentDraftStorageKey = "brainvault\.pageCommentDrafts\.v1";/);
  const persist = functionSource(app, "persistPageCommentDrafts");
  assert.match(persist, /if \(!pageCommentDraftStorageReady\) return;/, "an empty boot state must not erase stored drafts");
  assert.match(persist, /window\.sessionStorage\.setItem\(pageCommentDraftStorageKey/);
  const restore = functionSource(app, "restoreStoredPageCommentDrafts");
  assert.match(restore, /if \(stored\.ownerId !== userId\) \{\s*persistPageCommentDrafts\(\);/, "another account's drafts are dropped");
  assert.match(restore, /pageCommentDrafts\.has\(pageId\)/, "drafts already in memory are newer");
  assert.match(functionSource(app, "clearPageCommentDrafts"), /pageCommentDraftStorageReady = true;\s*persistPageCommentDrafts\(\);/);
  assert.match(functionSource(app, "adoptPageCommentDraftsForUser"), /restoreStoredPageCommentDrafts\(userId\);/);
  assert.match(app, /initializeAuthenticatedUi: async \(\) => \{\s*if \(!isCurrent\(\)\) return;\s*adoptPageCommentDraftsForUser\(state\.user\?\.id \?\? null\);/);
  assert.match(app, /window\.addEventListener\("pagehide", \(\) => persistPageCommentDrafts\(\)\);/);
});

test("every new message exists in all seven languages", () => {
  const section = i18n.slice(i18n.indexOf("const dataLossGuardTranslations = {"), i18n.indexOf("for (const [language, entries] of ["));
  const keys = [
    "status.pasteTooLong",
    "confirm.deleteBlockWithChildren",
    "dialog.deleteBlockAndChildren",
    "dialog.deleteBlockKeepChildren",
    "status.blockDeletedChildrenKept",
    "versions.restoreBlock",
    "versions.blockRestoredFromHistory",
    "status.blockRestoredFromHistory",
    "status.blockRestoreFromHistoryFailed"
  ];
  for (const key of keys) {
    const count = section.split(`"${key}":`).length - 1;
    assert.equal(count, 7, `${key} must be translated for every language`);
  }
  assert.match(i18n, /\.\.\.Object\.entries\(dataLossGuardTranslations\)/);
});
